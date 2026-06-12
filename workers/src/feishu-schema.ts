// feishu-schema.ts — 字段类型 → 飞书 Bitable 列类型的**单一真相源** + 类型化建列 / 类型化写值。
// See SPEC.md §16.8（发布即预建带类型的列，best-effort）与 §15.8（submit 升级为类型建列 + 类型写值）。
//
// 背景（合约要解决的问题）：
//   今天 owner 发布表单完全不碰飞书（forms.ts 只写 D1）；列只在**首次提交**撞缺列时由
//   §15.8 自愈一列列懒建、且**一律文本列**（type 1）。结果 owner 发布后看不到完整结构，
//   且 number/date/select 等字段全落成文本列。本模块把两件事补齐：
//     1) **发布即预建**：发布 / 编辑时按字段 type 把对应列在飞书表里**全部建好**（best-effort，
//        见 §16.8 / index.ts 的 waitUntil 接线）。
//     2) **类型化**：建列与写值都走**同一张映射表**（{@link FIELD_TYPE_TO_BITABLE}）——
//        number→数字列、date→日期列、select/radio→单选列、checkbox→多选列…而非一律文本。
//
// 与 submit.ts 的分层：submit.ts 仍是 `POST /api/submit` 写记录 / 自愈的归口；本模块提供
// 它**复用**的纯映射 + 类型化的建列 / 写值 seam（也被 forms.ts 发布/编辑路径的预建复用）。
// `answersToFields` / `ensureBitableFields` / `writeRecordWithFieldEnsure` 的契约改动注释见
// submit.ts 末尾的「§15.8 升级」段。
//
// 凭据边界（§15.7，与 submit.ts / feishu.ts 一致）：本模块所有上游调用只在
// `Authorization: Bearer <tenant_access_token>` 头里带 token；任何抛出的 message / 任何日志
// **绝不**含 `tenant_access_token` / `app_secret` 或其片段，只可带非敏感的飞书 `code` / HTTP 状态。
//
// Layering（给 implementer 的 seam）：下列纯函数（toBitableFieldType / buildFieldProperty /
// formatValueForBitable）是 inner-loop 单测靶；带 fetch 的 ensure*/preCreate* 是 outer-loop seam
// （SELF.fetch + mock open.feishu.cn）。实现体留 implementer，本文件只给类型 + 签名 + JSDoc 契约。

import type { Field, FieldType } from "./forms";
import {
  FEISHU_BITABLE_FIELDS_URL,
  FEISHU_FIELDS_LIST_PAGE_SIZE,
  FEISHU_CODE_FIELD_DUPLICATED,
  BitableWriteError,
} from "./submit";
import { FEISHU_OK_CODE, getFeishuTenantToken } from "./feishu";
import { getOwnerConfig } from "./config";
import { importConfigKey } from "./crypto";

// ---------------------------------------------------------------------------
// 飞书 Bitable 列类型常量（§15.5 / §16.8 单一真相）
// ---------------------------------------------------------------------------

/**
 * 飞书 Bitable 字段（列）`type` 枚举——本模块**只**用到这几种。数值即飞书开放平台
 * 「多维表格字段类型」约定（§16.8 映射表）：
 * - `1` 文本：text / textarea / file / group（兜底）/ 未知 type。
 * - `2` 数字：number。
 * - `3` 单选（SingleSelect）：select / radio——建列须带 `property.options`（见 {@link buildFieldProperty}）。
 * - `4` 多选（MultiSelect）：checkbox——建列须带 `property.options`。
 * - `5` 日期（DateTime）：date——值为**毫秒时间戳**（见 {@link formatValueForBitable}）。
 *
 * 复用 submit.ts 已有的 {@link import("./submit").FEISHU_FIELD_TYPE_TEXT}（= 1）作文本常量，
 * 二者数值一致；本枚举是它的超集，新增列类型集中在此声明，避免散落魔法数字。
 */
export const FEISHU_BITABLE_FIELD_TYPE = {
  /** 文本列。text / textarea / file / group / 未知 type 的兜底。 */
  TEXT: 1,
  /** 数字列。number 字段。 */
  NUMBER: 2,
  /** 单选列（SingleSelect）。select / radio；建列须带 property.options。 */
  SINGLE_SELECT: 3,
  /** 多选列（MultiSelect）。checkbox；建列须带 property.options。 */
  MULTI_SELECT: 4,
  /** 日期列（DateTime）。date；值为毫秒时间戳。 */
  DATE: 5,
} as const;

/** 一个飞书 Bitable 列类型数值（{@link FEISHU_BITABLE_FIELD_TYPE} 的值之一）。 */
export type FeishuFieldType =
  (typeof FEISHU_BITABLE_FIELD_TYPE)[keyof typeof FEISHU_BITABLE_FIELD_TYPE];

/**
 * **单一真相源**：表单字段 `type`（§3.2 {@link FieldType}）→ 飞书 Bitable 列 `type`。
 * 预建列（{@link preCreateBitableColumns}）与提交写值（{@link formatValueForBitable}）都从这里取，
 * **绝不**各自再写一份映射，避免「建列按一套、写值按另一套」漂移。
 *
 * 映射（§16.8）：
 * | 表单字段 type | 飞书列类型 | 说明 |
 * |---|---|---|
 * | `text` / `file` / `group` | 文本(1) | file 暂无附件上传，按文本兜底；group 自身无值，子字段各自映射 |
 * | `number` | 数字(2) | 值转 JS number |
 * | `date` | 日期(5) | 值转毫秒时间戳 |
 * | `select` / `radio` | 单选(3) | 建列带 property.options |
 * | `checkbox` | 多选(4) | 建列带 property.options，值为字符串数组 |
 *
 * 注意：§3.2 的 `FieldType` 没有独立的 `textarea` / `email` / `phone`（那是前端 UI 层
 * designerTools.ts 的 `UiFieldType`，发布时归一到 §3.2 的 `text`），故本表以 §3.2 的 8 种
 * `FieldType` 为准；UI 的 email/tel/textarea 在发布管线已落成 `text`，统一进文本列。
 */
export const FIELD_TYPE_TO_BITABLE: Readonly<Record<FieldType, FeishuFieldType>> = {
  text: FEISHU_BITABLE_FIELD_TYPE.TEXT,
  number: FEISHU_BITABLE_FIELD_TYPE.NUMBER,
  date: FEISHU_BITABLE_FIELD_TYPE.DATE,
  select: FEISHU_BITABLE_FIELD_TYPE.SINGLE_SELECT,
  radio: FEISHU_BITABLE_FIELD_TYPE.SINGLE_SELECT,
  checkbox: FEISHU_BITABLE_FIELD_TYPE.MULTI_SELECT,
  // file：暂不支持附件上传，按文本列兜底（值为文件名/链接字符串）。
  file: FEISHU_BITABLE_FIELD_TYPE.TEXT,
  // group：容器字段，自身不写值（其 children 各自按 type 映射成独立列）；映射给文本仅为补全表项。
  group: FEISHU_BITABLE_FIELD_TYPE.TEXT,
} as const;

/**
 * 把一个字段 `type` 映射成飞书 Bitable 列 `type`——查 {@link FIELD_TYPE_TO_BITABLE}，
 * **未知 / 越界 type 一律兜底文本(1)**（永不抛、永不返回 undefined，防一个坏字段拖垮整次预建）。
 *
 * 这是建列与写值共用的入口；implementer 在 {@link preCreateBitableColumns} /
 * {@link formatValueForBitable} 里都经它取列类型，确保两边一致。
 *
 * @param fieldType 字段的 §3.2 type（也接受运行期任意字符串，未命中即兜底文本）。
 * @returns 对应的飞书列类型；未知 type → {@link FEISHU_BITABLE_FIELD_TYPE.TEXT}。
 */
export function toBitableFieldType(fieldType: FieldType | string): FeishuFieldType {
  // 查单一真相映射表；未命中（运行期未知 / 越界 type）一律兜底文本(1)，永不抛、永不 undefined，
  // 防一个坏字段拖垮整次预建 / 写值。
  return FIELD_TYPE_TO_BITABLE[fieldType as FieldType] ?? FEISHU_BITABLE_FIELD_TYPE.TEXT;
}

// ---------------------------------------------------------------------------
// 建列时的 property（单选 / 多选需要 options）
// ---------------------------------------------------------------------------

/**
 * 飞书建列请求体里的 `property`（仅单选 3 / 多选 4 需要带 `options`）。形如
 * `{ options: [{ name }, ...] }`——`name` 是选项展示名。其余列类型（文本 / 数字 / 日期）
 * 建列**不带** `property`（返回 `undefined`）。
 *
 * 选项来源：字段的 `options:[{label,value}]`（§3.2 {@link import("./forms").FieldOption}）。
 * MVP 写值用 `label` 对位（§15.3 label 即列名 / 选项名），故建列的选项 `name` 取
 * **`option.label`**（与提交时写进单选/多选的字符串一致），不取 `value`。
 */
export interface FeishuFieldProperty {
  /** 单选 / 多选列的候选项；`name` = 选项展示名（取字段 option.label）。 */
  options: Array<{ name: string }>;
}

/**
 * 据字段定义生成飞书建列的 `property`（§16.8）。
 *
 * - 单选(3) / 多选(4)：返回 `{ options: field.options.map(o => ({ name: o.label })) }`。
 *   `field.options` 为空 / 缺失时，返回**空 options**（`{ options: [] }`）而非抛——
 *   飞书允许建一个无预置选项的单选/多选列，写值时遇到新选项可由飞书自动补（依其设置），
 *   也避免「options 偶然为空」拖垮整次 best-effort 预建。
 * - 文本(1) / 数字(2) / 日期(5)：返回 `undefined`（建列体不带 `property`）。
 *
 * 选项名去重 / 截断等细节由 implementer 在合约内定（飞书对重复选项名会报错，建议去重）。
 *
 * @param field 字段定义（§3.2 Field）。
 * @returns 单选/多选 → `FeishuFieldProperty`；其它列类型 → `undefined`。
 */
export function buildFieldProperty(field: Field): FeishuFieldProperty | undefined {
  const targetType = toBitableFieldType(field.type);
  // 仅单选(3) / 多选(4) 列建列带 property.options；文本 / 数字 / 日期不带（返回 undefined）。
  if (
    targetType !== FEISHU_BITABLE_FIELD_TYPE.SINGLE_SELECT &&
    targetType !== FEISHU_BITABLE_FIELD_TYPE.MULTI_SELECT
  ) {
    return undefined;
  }
  // 选项名取 option.label（§15.3 label 即列名 / 选项名，与写值一致），去重——飞书对重复
  // 选项名会报错。options 缺失 / 为空 → 空 options（飞书允许建无预置选项的单选/多选列），
  // 不抛，避免「options 偶然为空」拖垮整次 best-effort 预建。
  const seen = new Set<string>();
  const options: Array<{ name: string }> = [];
  for (const opt of field.options ?? []) {
    if (seen.has(opt.label)) {
      continue;
    }
    seen.add(opt.label);
    options.push({ name: opt.label });
  }
  return { options };
}

// ---------------------------------------------------------------------------
// 类型化写值（按目标列类型格式化）
// ---------------------------------------------------------------------------

/**
 * 一个写进飞书 `fields` 的、**已按列类型格式化**的值。飞书新增记录 body 的 `fields`
 * 值依列类型而定：
 * - 文本(1)：`string`。
 * - 数字(2)：`number`。
 * - 日期(5)：`number`（**毫秒**时间戳）。
 * - 单选(3)：`string`（选项名）。
 * - 多选(4)：`string[]`（选项名数组）。
 * - 跳过（无法格式化且无安全兜底时）：`undefined`——调用方应**省略该键**，不写入。
 */
export type FormattedBitableValue = string | number | string[] | undefined;

/**
 * 把一个答案 `value`（来自答题者，`string | string[]`，§15.2）按**目标列类型**格式化成
 * 飞书可接收的值（§16.8 / §15.8 升级）。建列与写值共用 {@link FIELD_TYPE_TO_BITABLE}，
 * 故这里的 `targetType` 必须是「这一列实际的飞书类型」——见 §15.8 升级里「按实际列类型写值」
 * 的方案 a（提交前列出现有列的真实类型，用它而非字段声明 type 来格式化，兜旧文本列 / 类型漂移）。
 *
 * 格式化规则（兜底策略已拍定）：
 * - 文本(1)：`string` 原样；`string[]` 合并成一个字符串（join，分隔符由 implementer 定，如 `, `）。
 * - 数字(2)：把字符串 `Number(value)`；**解析失败（NaN / 空串 / 非数字串）→ 返回 `undefined`
 *   （跳过该字段，不写入）**——宁可少写一格，也不要因一个脏值整条记录被飞书拒。
 * - 日期(5)：把日期串解析成**毫秒时间戳**（`Date.parse` 或约定格式）；**解析失败 → `undefined`
 *   （跳过）**。已是纯数字串（疑似时间戳）的处理由 implementer 在合约内定（建议按毫秒原样取）。
 * - 单选(3)：取 `string`（若给了 `string[]` 取第一项）作选项名。空 → `undefined`（跳过）。
 * - 多选(4)：`string[]` 原样（过滤空项）；单个 `string` 包成 `[value]`。空数组 → `undefined`（跳过）。
 * - 未知 targetType：按文本处理（与 {@link toBitableFieldType} 的兜底一致）。
 *
 * **「跳过」语义**：返回 `undefined` 表示「这一格无法安全写入，省略它」。调用方
 * （{@link answersToTypedFields}）据此**不把该键放进 `fields`**——绝不写一个会被飞书整条拒掉
 * 的脏值。空字符串答案是否写入（写空串 vs 跳过）由 implementer 在合约内定，但**必填**已在
 * §20.3 `validateAnswers` 拦过，故走到这里的空值都是可选字段未填，跳过最安全。
 *
 * @param value 答题者填的原始值（`string | string[]`）。
 * @param targetType 该列**实际**的飞书列类型（提交时来自列出现有列；预建语境用映射 type）。
 * @returns 格式化后的值；无法安全格式化 → `undefined`（调用方省略该键）。
 */
export function formatValueForBitable(
  value: string | string[],
  targetType: FeishuFieldType,
): FormattedBitableValue {
  switch (targetType) {
    case FEISHU_BITABLE_FIELD_TYPE.NUMBER: {
      // 数字列：把字符串转 number。脏值（NaN / 空串 / 纯空白 / "12abc"）→ undefined（跳过该格），
      // 宁可少写一格也不让一个脏值整条记录被飞书拒。`Number("")` 是 0，故先判空。
      const raw = Array.isArray(value) ? value[0] : value;
      if (typeof raw !== "string" || raw.trim().length === 0) {
        return undefined;
      }
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case FEISHU_BITABLE_FIELD_TYPE.DATE: {
      // 日期列：解析成毫秒时间戳。已是纯数字串（疑似毫秒时间戳）按原样取；否则走 Date.parse。
      // 解析失败 → undefined（跳过）。
      const raw = Array.isArray(value) ? value[0] : value;
      if (typeof raw !== "string" || raw.trim().length === 0) {
        return undefined;
      }
      const trimmed = raw.trim();
      if (/^\d+$/.test(trimmed)) {
        return Number(trimmed);
      }
      const ms = Date.parse(trimmed);
      return Number.isNaN(ms) ? undefined : ms;
    }
    case FEISHU_BITABLE_FIELD_TYPE.SINGLE_SELECT: {
      // 单选列：取选项字符串（给了 string[] 取第一项）。空 → undefined（跳过）。
      const raw = Array.isArray(value) ? value[0] : value;
      if (typeof raw !== "string" || raw.length === 0) {
        return undefined;
      }
      return raw;
    }
    case FEISHU_BITABLE_FIELD_TYPE.MULTI_SELECT: {
      // 多选列：string[] 原样（过滤空项）；单个 string 包成 [value]。空数组 → undefined（跳过）。
      const arr = Array.isArray(value) ? value : [value];
      const filtered = arr.filter((v) => typeof v === "string" && v.trim().length > 0);
      return filtered.length > 0 ? filtered : undefined;
    }
    // 文本(1) 与未知 targetType：按文本处理（与 toBitableFieldType 的兜底一致）。
    default: {
      // string[] 合并成一个字符串（join `, `）；空字符串答案 → undefined（跳过，§16.8）。
      const text = Array.isArray(value) ? value.join(", ") : value;
      return text.length > 0 ? text : undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// 发布即预建带类型的列（§16.8，best-effort）—— 实现留给 implementer
// ---------------------------------------------------------------------------

/**
 * 预建（或增量补建）一份表单 `fields` 对应的飞书 Bitable 列——**按字段 type 建成对应类型的列**
 * （§16.8）。发布（`POST /api/forms`）建**全部**列；编辑（`PATCH /api/forms/:slug` 改了 fields）
 * 建**新增**的列。由 forms.ts 发布/编辑路径在 `c.executionCtx.waitUntil` 里**后台 best-effort** 调用。
 *
 * 契约（§16.8）：
 * - **列出现有列**：`GET` {@link import("./submit").FEISHU_BITABLE_FIELDS_URL}
 *   （`?page_size=` {@link import("./submit").FEISHU_FIELDS_LIST_PAGE_SIZE}），取
 *   `data.items[].field_name` 现有列名集合 + 各列 `type`（{@link listBitableColumns}）。
 * - **只建缺列**：对 `fields` 里**列名（= `field.label`，§15.3 label 对位）不在现有集合**的每个字段，
 *   `POST .../fields` 建列，body `{ field_name: field.label, type: toBitableFieldType(field.type),
 *   property?: buildFieldProperty(field) }`（单选/多选带 options）。
 * - **绝不改既有列**：列名已存在 → **跳过**该字段，**不**改它的类型 / property（哪怕类型与字段不符）——
 *   预建只对缺列生效（改名 / 改类型 / 删列不在本期，§16.8 范围）。
 * - **幂等**：建列遇 `code` {@link import("./submit").FEISHU_CODE_FIELD_DUPLICATED}（`1254014`
 *   并发下别处刚建）视为**成功**，跳过。
 * - **group**：容器字段不建列；只对其 `children` 里有值的叶子字段建列（递归展开由 implementer 在合约内定）。
 * - **best-effort 不抛穿透**：见 {@link preCreateBitableColumnsBestEffort}——本函数可在内部对单列失败
 *   选择「跳过继续建下一列」或抛出，由 implementer 在合约内定；但**对外**（forms 路由侧）的入口是
 *   best-effort 包装，任何失败都被吞掉、只记日志（绝不含凭据），发布响应不受影响。
 *
 * @param token tenant_access_token；只进 `Authorization` 头（§15.7）。
 * @param appToken owner Bitable app token。
 * @param tableId owner Bitable table id。
 * @param fields 该表单的字段定义（发布=全部；编辑=新增字段，由调用方算差集后传入）。
 * @returns 列出 / 建列完成后 resolve；失败语义见上（对外由 best-effort 包装吞掉）。
 */
export async function preCreateBitableColumns(
  token: string,
  appToken: string,
  tableId: string,
  fields: Field[],
): Promise<void> {
  // 展平 group → 叶子字段；空 / 全已存在 → 不发任何建列调用。
  const leaves = flattenLeafFields(fields);
  if (leaves.length === 0) {
    return;
  }
  // 先列出现有列名（绝不改既有列，只对缺列生效，§16.8）。
  const items = await listBitableFieldItems(token, appToken, tableId);
  const existing = new Set<string>();
  for (const item of items) {
    if (typeof item.field_name === "string") {
      existing.add(item.field_name);
    }
  }
  // 顺序建缺列——按字段 type 建对应类型列（单选/多选带 options）。1254014 在 createBitableColumn
  // 内被当幂等成功吞掉；其它失败抛 BitableWriteError（对外由 best-effort 外壳吞掉）。
  for (const field of leaves) {
    if (existing.has(field.label)) {
      continue;
    }
    await createBitableColumn(token, appToken, tableId, field);
  }
}

/**
 * {@link preCreateBitableColumns} 的 **best-effort 外壳**——发布 / 编辑路径在
 * `c.executionCtx.waitUntil(...)` 里调用的就是它。把整段预建（换 token + 列出 + 建列）的**任何**
 * 失败都**吞掉**，只记一条**不含凭据**的日志（`err.name` 级别，绝不含 token / app_secret / 明文），
 * **绝不**让发布 / 编辑响应失败（§16.8 best-effort 铁律）。
 *
 * 内部职责（§16.8 接线）：
 * 1. 读 + 解密**该 owner**的飞书配置（`getOwnerConfig`）；`owner.feishu === null`（未配飞书）→ 直接
 *    return（静默跳过，不报错、不打上游）。
 * 2. `getFeishuTenantToken(appId, appSecret)`；换 token 失败（不可达 / code≠0）→ 吞掉（记 err.name）、return。
 * 3. `preCreateBitableColumns(token, appToken, tableId, fields)`；列出 / 建列失败 → 吞掉、return。
 *
 * 即：owner 未配飞书 / 飞书连不上 / token 换取失败 / 建列失败 —— 一律**静默跳过**，发布照常 `201`、
 * 编辑照常 `200`。与 index.ts 既有 {@link import("./email")} 的 `sendVerifyEmail` best-effort 同纪律：
 * 只记 `err.name`，**绝不**把凭据 / 明文写进日志（§15.7）。
 *
 * @param env 提供 `DB` / `CONFIG_KEY` 的 Worker env（与 submit / submissions 路由同源读取 owner 配置）。
 * @param ownerId 发布 / 编辑这份表单的 owner 真实 user id（发布 = 当前 session.sub；编辑 = 同）。
 * @param fields 要预建的字段（发布=全部；编辑=新增差集）。
 * @returns 总是 resolve（best-effort，永不 reject）。
 */
export async function preCreateBitableColumnsBestEffort(
  env: { DB: D1Database; CONFIG_KEY: string },
  ownerId: string,
  fields: Field[],
): Promise<void> {
  try {
    // 1) 读 + 解密该 owner 的飞书配置；未配飞书 → 静默 return（不报错、不打上游）。
    const key = await importConfigKey(env.CONFIG_KEY);
    const owner = await getOwnerConfig(env.DB, key, ownerId);
    if (owner.feishu === null) {
      return;
    }
    const feishu = owner.feishu;
    // 2) 换 tenant_access_token（失败抛 FeishuTokenError，落入下方 catch 被吞）。
    const token = await getFeishuTenantToken(feishu.appId, feishu.appSecret);
    // 3) 列出 + 按类型建缺列（任何失败落入 catch 被吞）。
    await preCreateBitableColumns(token, feishu.appToken, feishu.tableId, fields);
  } catch (err) {
    // best-effort 铁律（§16.8）：owner 未配飞书 / 飞书连不上 / token 换取失败 / 列出 / 建列
    // 失败 —— 一律静默吞掉，绝不改变发布 / 编辑的状态码与响应体。与 index.ts 的
    // sendVerifyEmail best-effort 同纪律：只记 err.name，绝不把 app_secret / tenant_access_token
    // / 明文写进日志（§15.7）。
    console.error(
      "preCreate feishu columns best-effort failed",
      err instanceof Error ? err.name : "unknown",
    );
  }
}

// ---------------------------------------------------------------------------
// 提交时：列出现有列的真实类型（既有列冲突兜底方案 a）—— 实现留给 implementer
// ---------------------------------------------------------------------------

/**
 * 一列在飞书表里的「名 → 实际类型」。{@link listBitableColumns} 的产物，供提交时
 * {@link answersToTypedFields} **按列的真实类型**格式化值（既有列冲突兜底方案 a，见 §15.8 升级）。
 */
export type BitableColumnTypes = Map<string, FeishuFieldType>;

/**
 * 一列在飞书表里的**详细身份**：实际列类型 + 飞书侧的 `field_id`（§16.8.7）。
 *
 * `field_id` 是飞书 Bitable 列的稳定标识——**改名一跳**（{@link renameBitableColumn} 的
 * `PUT .../fields/{field_id}`）唯一据以定位目标列的键。现有 {@link listBitableColumns} 只投影
 * 「名 → 类型」、丢掉了 `field_id`，故改名链路需要本更宽的视图（{@link listBitableColumnsDetailed}）。
 */
export interface BitableColumnDetail {
  /** 该列的实际飞书列类型（同 {@link BitableColumnTypes} 的值，未知 / 缺失兜底文本）。 */
  type: FeishuFieldType;
  /** 该列的飞书 `field_id`（`data.items[].field_id`）；改名 API 的路径参数。 */
  fieldId: string;
}

/**
 * 列出目标表现有列的「列名 → {@link BitableColumnDetail}」（含 `field_id`，§16.8.7）。
 *
 * 与 {@link listBitableColumns} 共用同一次「列出字段」上游一跳（{@link listBitableFieldItems}），
 * 但**多投影一个 `data.items[].field_id`**——改名链路据 `field_id` 定位列。**`listBitableColumns`
 * 的签名（`Map<列名, 类型>`）与 §16.8.4 提交写值路径完全不变**：要么让 `listBitableColumns` 从本
 * 函数的产物投影出「名 → 类型」、要么二者并存各读一次，由 implementer 在合约内定（别破坏写值路径）。
 *
 * 丢弃 `field_id` 缺失（异常态）的 item：没有 `field_id` 的列无法被改名定位，纳入也无用。
 * 失败语义沿用 {@link listBitableFieldItems}：抛 {@link import("./submit").BitableWriteError}
 * （message 只带非敏感 code / 状态，绝不含 token / secret，§15.7）。
 *
 * @param token tenant_access_token；只进 `Authorization` 头（§15.7）。
 * @param appToken owner Bitable app token。
 * @param tableId owner Bitable table id。
 * @returns 列名 → { 实际类型, field_id }；空表 → 空 Map。
 * @throws {@link import("./submit").BitableWriteError} 列出失败（非 2xx / code≠0 / 不可达）。
 */
export async function listBitableColumnsDetailed(
  token: string,
  appToken: string,
  tableId: string,
): Promise<Map<string, BitableColumnDetail>> {
  // 与 listBitableColumns 共用同一次「列出字段」上游一跳，但多投影 field_id（改名据此定位列）。
  const items = await listBitableFieldItems(token, appToken, tableId);
  const cols = new Map<string, BitableColumnDetail>();
  for (const item of items) {
    // 丢弃没有 field_name 或 field_id 的 item：没有 field_id 的列无法被改名定位，纳入无用。
    if (typeof item.field_name !== "string" || typeof item.field_id !== "string") {
      continue;
    }
    // 未知 / 缺失 type 兜底文本，保证值始终是合法 FeishuFieldType（与 listBitableColumns 一致）。
    const type =
      typeof item.type === "number"
        ? (item.type as FeishuFieldType)
        : FEISHU_BITABLE_FIELD_TYPE.TEXT;
    cols.set(item.field_name, { type, fieldId: item.field_id });
  }
  return cols;
}

/**
 * 列出目标表现有列的「列名 → 飞书列类型」映射（§15.8 升级 / §16.8）。
 *
 * `GET` {@link import("./submit").FEISHU_BITABLE_FIELDS_URL}（`?page_size=` 列页大小），取
 * `data.items[].field_name` 与 `data.items[].type`，组装成 {@link BitableColumnTypes}。
 * 复用 submit.ts 既有列出契约（双门：`2xx` 且 body `code===0`），但**多读一个 `type` 字段**
 * （原 §15.8 只读 `field_name`）。失败语义沿用 submit.ts：抛 {@link import("./submit").BitableWriteError}
 * （message 只带非敏感 code / 状态，绝不含 token / secret，§15.7）。
 *
 * @param token tenant_access_token；只进 `Authorization` 头（§15.7）。
 * @param appToken owner Bitable app token。
 * @param tableId owner Bitable table id。
 * @returns 列名 → 实际飞书列类型；空表 → 空 Map。
 * @throws {@link import("./submit").BitableWriteError} 列出失败（非 2xx / code≠0 / 不可达）。
 */
export async function listBitableColumns(
  token: string,
  appToken: string,
  tableId: string,
): Promise<BitableColumnTypes> {
  const items = await listBitableFieldItems(token, appToken, tableId);
  const cols: BitableColumnTypes = new Map();
  for (const item of items) {
    if (typeof item.field_name === "string") {
      // 未知 / 缺失 type 兜底文本，保证 Map 的值始终是合法的 FeishuFieldType。
      const type =
        typeof item.type === "number"
          ? (item.type as FeishuFieldType)
          : FEISHU_BITABLE_FIELD_TYPE.TEXT;
      cols.set(item.field_name, type);
    }
  }
  return cols;
}

// ---------------------------------------------------------------------------
// 内部：列出 / 建列的飞书上游调用收口（listBitableColumns / preCreateBitableColumns 共用）
// ---------------------------------------------------------------------------

/** 一条飞书列出字段响应里的 item（只取本模块用到的 `field_name` / `type` / `field_id`）。 */
interface FeishuFieldItem {
  field_name?: string;
  type?: number;
  /** 飞书列稳定标识；{@link listBitableColumnsDetailed} 投影它供改名定位（§16.8.7）。 */
  field_id?: string;
}

/**
 * `GET .../fields?page_size=N`，列出目标表现有列项（`data.items[]`）。成功要求 `2xx` 且
 * body `code === 0`；失败抛 {@link BitableWriteError}（message 只带非敏感 code / 状态，§15.7）。
 * 这是 {@link listBitableColumns} 与 {@link preCreateBitableColumns} 共用的「列出」一跳。
 */
async function listBitableFieldItems(
  token: string,
  appToken: string,
  tableId: string,
): Promise<FeishuFieldItem[]> {
  const base = FEISHU_BITABLE_FIELDS_URL.replace("{app_token}", appToken).replace(
    "{table_id}",
    tableId,
  );
  const url = `${base}?page_size=${FEISHU_FIELDS_LIST_PAGE_SIZE}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      // tenant_access_token 的唯一去处是 Authorization 头（§15.7）。
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new BitableWriteError("飞书列出字段失败：上游不可达");
  }
  let body: { code?: number; data?: { items?: FeishuFieldItem[] } };
  try {
    body = (await res.json()) as { code?: number; data?: { items?: FeishuFieldItem[] } };
  } catch {
    throw new BitableWriteError(`飞书列出字段失败：上游返回 ${res.status}`);
  }
  if (res.ok && body.code === FEISHU_OK_CODE) {
    return body.data?.items ?? [];
  }
  throw new BitableWriteError(`飞书列出字段失败：code ${body.code}`);
}

/**
 * `POST .../fields` 建一列。body `{ field_name, type, property? }`。成功要求 `2xx` 且
 * `code === 0`；`code === 1254014`（并发别处刚建）视为**幂等成功**。其它失败抛
 * {@link BitableWriteError}（message 只带非敏感 code / 状态，§15.7）。
 */
async function createBitableColumn(
  token: string,
  appToken: string,
  tableId: string,
  field: Field,
): Promise<void> {
  const url = FEISHU_BITABLE_FIELDS_URL.replace("{app_token}", appToken).replace(
    "{table_id}",
    tableId,
  );
  const property = buildFieldProperty(field);
  const reqBody: { field_name: string; type: FeishuFieldType; property?: FeishuFieldProperty } = {
    field_name: field.label,
    type: toBitableFieldType(field.type),
  };
  if (property !== undefined) {
    reqBody.property = property;
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });
  } catch {
    throw new BitableWriteError("飞书建列失败：上游不可达");
  }
  let body: { code?: number };
  try {
    body = (await res.json()) as { code?: number };
  } catch {
    throw new BitableWriteError(`飞书建列失败：上游返回 ${res.status}`);
  }
  // 成功，或并发下别处刚建（1254014）视为幂等成功——都不抛。
  if ((res.ok && body.code === FEISHU_OK_CODE) || body.code === FEISHU_CODE_FIELD_DUPLICATED) {
    return;
  }
  throw new BitableWriteError(`飞书建列失败：code ${body.code}`);
}

/**
 * 把字段树展平成「要建成列的叶子字段」序列（§16.8）：group 容器自身不建列，只递归展开其
 * `children`；非 group 字段即一个叶子列。重复 label（同名列）只保留首次出现，避免对同一列名
 * 发两次建列。
 *
 * 导出（§15.8 自愈复用）：submit.ts 的 {@link import("./submit").writeRecordWithFieldEnsure}
 * 在「按 writeKeys 过滤要补建的字段」前也用它把 `fieldDefs` 摊平成叶子字段——否则 `group` 容器
 * 自身 label 不是写入键、会被过滤掉，其子字段 label 又埋在 `children` 里，导致分组子字段的缺列
 * 自愈漏建（与发布预建用 `flattenLeafFields` 摊平 group 的语义对齐）。
 */
export function flattenLeafFields(fields: Field[]): Field[] {
  const leaves: Field[] = [];
  const seen = new Set<string>();
  const walk = (fs: Field[]): void => {
    for (const field of fs) {
      if (field.type === "group") {
        // 容器字段自身无值、不建列；只展开其子字段。
        walk(field.children ?? []);
        continue;
      }
      if (seen.has(field.label)) {
        continue;
      }
      seen.add(field.label);
      leaves.push(field);
    }
  };
  walk(fields);
  return leaves;
}

/**
 * 把字段树展平成**全部**叶子字段序列——**不按 label 去重**（与 {@link flattenLeafFields} 唯一的
 * 差别）：group 容器自身不算叶子、只递归展开其 `children`，每个非 group 字段都是一个叶子，**同
 * label 不同 id 的两个字段都保留**。
 *
 * 为什么需要它(§16.8.7 改名 diff)：{@link flattenLeafFields} **按 `label` 去重**（为预建路径设计——
 * 同名列只建一次），但改名 diff（{@link computeFieldRenames}）是**按 `field.id` 配对**做的。两者冲突：
 * 若旧 schema 有两个同 `label` 的字段（如 `[{id:f1,label:"其他"},{id:f2,label:"其他"}]`，`parseField`
 * 只禁空 label、不禁重复 label，故可达），`flattenLeafFields` 会把其一按 label 去重掉 → 改名 diff 的
 * `oldById` 缺了那个 id → 改它的 label 时认不出是改名、当成新字段 → 预建按新 label 另建一列、旧列连
 * 数据被孤立（正是改名同步要防的丢数据）。故改名 diff **只**用本不去重的摊平；**预建路径仍用
 * {@link flattenLeafFields} 的 label 去重不变**（别破坏 §16.8 预建「同名只建一列」语义）。
 *
 * 仅供本模块内部的改名 diff 用，不导出。同 id 的两个叶子（异常态）在调用方按 id 配对时仍 first-wins。
 */
function flattenLeafFieldsAll(fields: Field[]): Field[] {
  const leaves: Field[] = [];
  const walk = (fs: Field[]): void => {
    for (const field of fs) {
      if (field.type === "group") {
        // 容器字段自身无值、不建列；只展开其子字段。
        walk(field.children ?? []);
        continue;
      }
      // 不按 label 去重：同 label 不同 id 的字段都保留，供按 id 配对的改名 diff 全量看到。
      leaves.push(field);
    }
  };
  walk(fields);
  return leaves;
}

// ---------------------------------------------------------------------------
// §16.8.7：改字段标签 → 同步飞书列改名（best-effort，v1 只改名）—— 实现留给 implementer
// ---------------------------------------------------------------------------

/**
 * 飞书「改字段名 / 改单列」端点模板（按 `field_id` 定位单列，§16.8.7）。
 *
 * `PUT https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields/{field_id}`，
 * `Authorization: Bearer <tenant_access_token>`，body **同时带回原 `type`**：`{ field_name, type }`
 * ——**只改名、不改类型**（漏带 `type` 可能被飞书误改 / 拒；列类型由 §16.8.4 既有列冲突兜底负责）。
 * 与 {@link import("./submit").FEISHU_BITABLE_FIELDS_URL}（建列 / 列出，无 `field_id` 段）是不同路由。
 */
export const FEISHU_BITABLE_FIELD_BY_ID_URL =
  "https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields/{field_id}";

/**
 * 一条「飞书列改名」计划项（{@link computeFieldRenames} 的产物）：把某字段对应的飞书列从
 * `oldLabel` 改名成 `newLabel`。`type` 是该字段映射出的飞书列类型，**仅作改名调用时带回原 `type`
 * 的兜底参照**；改名一跳真正带回的 `type` 应以**飞书侧该列现有类型**为准（来自
 * {@link listBitableColumnsDetailed}），二者通常一致，冲突时以列现有类型为准（只改名不改类型）。
 */
export interface FieldRename {
  /** 字段稳定 `id`（§3.2；新旧配对的钥匙，改名后不变）。 */
  fieldId: string;
  /** 旧标签——**即飞书那列现在的名字**，据此定位列（§16.8.7）。 */
  oldLabel: string;
  /** 新标签——改名后的列名。 */
  newLabel: string;
  /** 该字段映射出的飞书列类型（`toBitableFieldType(field.type)`），改名带回 `type` 的参照。 */
  type: FeishuFieldType;
}

/**
 * **纯函数 seam（inner-loop 单测靶）：** 对比编辑前后的字段定义，算出「哪些字段被改了名」
 * （§16.8.7）。**无 I/O**。
 *
 * 规则：
 * - 先各自摊平 `group`（分组子字段一并参与配对；容器自身不参与）——用**不按 label 去重**的
 *   {@link flattenLeafFieldsAll}（**非** {@link flattenLeafFields}），保证同 label 不同 id 的两个
 *   字段都进 diff；否则按 label 去重会丢掉其一的 id、把改它名当成新字段而漏判改名（丢数据）。
 * - 按 `field.id` 把新旧字段**配对**：`id` 在**新旧都有**、且 `label` **不同** = 一条改名
 *   （`oldLabel` = 旧字段 label，`newLabel` = 新字段 label，`type` = `toBitableFieldType(新字段.type)`）。
 * - **新增**（id 只在新）/ **删除**（id 只在旧）/ **改类型但 label 不变** → **不在结果内**
 *   （v1 只同步改名；新增由预建处理，删 / 改类型不同步，§16.8.7 范围表）。
 * - `oldLabel === newLabel`（label 没变）→ 跳过，不产生改名项。
 * - 同一旧 id 出现多次（异常态）/ label 为空等脏数据的处理由 implementer 在合约内定，但**不得抛**
 *   （一份脏字段定义不该拖垮整次 diff，与本模块「永不因坏字段拖垮」的纪律一致）。
 *
 * @param oldFields 编辑落库**前**的字段定义（来自旧 `schema_json`）。
 * @param newFields 编辑后的字段定义（`UpdateFormInput.fields`）。
 * @returns 改名计划项数组；无改名 → `[]`（调用方据此不发任何改名调用）。
 */
export function computeFieldRenames(oldFields: Field[], newFields: Field[]): FieldRename[] {
  // 各自摊平 group → 叶子字段（分组子字段一并参与配对；容器自身不参与）——用 flattenLeafFieldsAll
  // （不按 label 去重），保证同 label 不同 id 的两个字段都进 diff；若用 flattenLeafFields 的 label
  // 去重，会丢掉其一的 id → 改它名时认不出改名、当成新字段（旧列连数据被孤立的丢数据 bug）。
  // 按 field.id 索引旧字段，同一旧 id 多次出现（异常态）只取首次（不抛——一份脏字段定义不该拖垮整次 diff）。
  const oldById = new Map<string, Field>();
  for (const leaf of flattenLeafFieldsAll(oldFields)) {
    if (!oldById.has(leaf.id)) {
      oldById.set(leaf.id, leaf);
    }
  }

  const renames: FieldRename[] = [];
  const seenNewIds = new Set<string>();
  for (const leaf of flattenLeafFieldsAll(newFields)) {
    // 同一新 id 多次出现（异常态）只认首次，避免对同一字段产出多条改名。
    if (seenNewIds.has(leaf.id)) {
      continue;
    }
    seenNewIds.add(leaf.id);

    const old = oldById.get(leaf.id);
    // id 只在新（新增字段）→ 不进结果（新增由预建建列）。
    if (old === undefined) {
      continue;
    }
    // id 两边都有但 label 未变（仅改类型 / 改校验 / 重排）→ 不进结果（v1 只同步改名）。
    if (old.label === leaf.label) {
      continue;
    }
    // id 同、label 不同 = 一条改名。type 取新字段映射类型，仅作改名带回 type 的参照
    // （真正带回的 type 以飞书侧列现有类型为准，syncBitableColumnRenamesBestEffort 里取）。
    renames.push({
      fieldId: leaf.id,
      oldLabel: old.label,
      newLabel: leaf.label,
      type: toBitableFieldType(leaf.type),
    });
  }
  // id 只在旧（删除字段）天然不进结果（只遍历新字段）。
  return renames;
}

/**
 * 改飞书表里**一列**的名字（§16.8.7 单列一跳）。
 *
 * `PUT` {@link FEISHU_BITABLE_FIELD_BY_ID_URL}（`{field_id}` 填该列的飞书 field_id），body
 * `{ field_name: newLabel, type }`——**带回原 `type` 只改名、不改类型**。成功要求 `2xx` 且
 * `code === 0`。失败抛 {@link import("./submit").BitableWriteError}（message 只带非敏感
 * code / 状态，绝不含 token / secret / 列值，§15.7）；对外由 {@link syncBitableColumnRenamesBestEffort}
 * 逐项 try/catch 吞掉，单列失败不影响其它列。
 *
 * 注意：**调用前的冲突判定不在本函数**——「新名撞已存在的另一列」「旧名找不到列」由
 * {@link syncBitableColumnRenamesBestEffort} 在调本函数前据 {@link listBitableColumnsDetailed}
 * 的产物逐项过滤（§16.8.7 冲突 / 边界）。本函数只管「拿着 field_id 把名字改成 newLabel」这一跳。
 *
 * @param token tenant_access_token；只进 `Authorization` 头（§15.7）。
 * @param appToken owner Bitable app token。
 * @param tableId owner Bitable table id。
 * @param fieldId 目标列的飞书 field_id（来自 {@link listBitableColumnsDetailed}）。
 * @param newLabel 新列名。
 * @param type 该列现有类型，带回 body 以**只改名不改类型**。
 * @throws {@link import("./submit").BitableWriteError} 改名失败（非 2xx / code≠0 / 不可达）。
 */
export async function renameBitableColumn(
  token: string,
  appToken: string,
  tableId: string,
  fieldId: string,
  newLabel: string,
  type: FeishuFieldType,
): Promise<void> {
  const url = FEISHU_BITABLE_FIELD_BY_ID_URL.replace("{app_token}", appToken)
    .replace("{table_id}", tableId)
    .replace("{field_id}", fieldId);
  // body 带回原 type 一起改名——只改名、不改类型（漏带 type 飞书可能误改 / 拒）。
  const reqBody = { field_name: newLabel, type };
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: {
        // tenant_access_token 的唯一去处是 Authorization 头（§15.7）。
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });
  } catch {
    throw new BitableWriteError("飞书改列名失败：上游不可达");
  }
  let body: { code?: number };
  try {
    body = (await res.json()) as { code?: number };
  } catch {
    throw new BitableWriteError(`飞书改列名失败：上游返回 ${res.status}`);
  }
  // 成功要求 2xx 且 code === 0；失败抛 BitableWriteError（message 只带非敏感 code / 状态，
  // 绝不含 token / secret / 列值，§15.7）——对外由 syncBitableColumnRenamesBestEffort 逐项吞掉。
  if (res.ok && body.code === FEISHU_OK_CODE) {
    return;
  }
  throw new BitableWriteError(`飞书改列名失败：code ${body.code}`);
}

/**
 * {@link computeFieldRenames} + 飞书改名的 **best-effort 外壳**——编辑路径（`PATCH /api/forms/:slug`
 * 带了 `fields`）在 `c.executionCtx.waitUntil(...)` 里**先于** {@link preCreateBitableColumnsBestEffort}
 * 调用的就是它（顺序铁律见 §16.8.1 / §16.8.7）。把整段同步（读配置 → 换 token → 列出含 field_id →
 * 逐个改名）的**任何**失败都**吞掉**，只记一条**不含凭据 / 列值**的日志，**绝不**让编辑响应失败。
 *
 * 内部职责（§16.8.7 接线）：
 * 1. `renames = computeFieldRenames(oldFields, newFields)`；空 → 直接 return（不打任何上游）。
 * 2. 读 + 解密**该 owner** 的飞书配置（`getOwnerConfig`）；`owner.feishu === null`（未配飞书）→ return。
 * 3. `getFeishuTenantToken(appId, appSecret)`；换 token 失败 → 吞掉、return。
 * 4. `listBitableColumnsDetailed(token, appToken, tableId)` 拿现有列「名 → { type, fieldId }」。
 * 5. **逐项**改名（冲突 / 边界逐项跳过，互不影响，§16.8.7）：
 *    - 旧 label 在现有列里**找不到** → 跳过该项（从没建过 / 已被改过）。
 *    - 新 label 在现有列里**已存在另一个不同列**（撞名）→ **跳过 + 记日志（不含凭据）**，不强改。
 *    - 否则 `renameBitableColumn(...)` 用该列 `fieldId` + 列**现有类型**改名；单项失败 try/catch 吞掉、继续下一项。
 *
 * 即：renames 为空 / owner 未配飞书 / 飞书连不上 / token 换取失败 / 列出失败 / 某项改名失败 ——
 * 一律**静默跳过**，编辑照常 `200`。与 {@link preCreateBitableColumnsBestEffort} 同 best-effort
 * 纪律：只记 `err.name`，**绝不**把 `app_secret` / `tenant_access_token` / 列值写进日志（§15.7）。
 *
 * 顺序铁律（§16.8.7）：本函数**先于**预建跑——改名把现有列改成新名后，随后的预建列出现有列、
 * 看到已改名的列存在即跳过，**不会按新 label 重复建一个列**。
 *
 * @param env 提供 `DB` / `CONFIG_KEY` 的 Worker env（与预建外壳同源读 owner 配置）。
 * @param ownerId 编辑这份表单的 owner 真实 user id（= 当前 session.sub）。
 * @param oldFields 编辑落库**前**的字段定义（旧 `schema_json`，调用方在 `updateForm` 前读取）。
 * @param newFields 编辑后的字段定义（`UpdatedForm.fields` / `UpdateFormInput.fields`）。
 * @returns 总是 resolve（best-effort，永不 reject）。
 */
export async function syncBitableColumnRenamesBestEffort(
  env: { DB: D1Database; CONFIG_KEY: string },
  ownerId: string,
  oldFields: Field[],
  newFields: Field[],
): Promise<void> {
  try {
    // 1) 纯 diff 算改名计划——无改名 → 直接 return（不读配置、不打任何上游）。
    const renames = computeFieldRenames(oldFields, newFields);
    if (renames.length === 0) {
      return;
    }
    // 2) 读 + 解密该 owner 的飞书配置；未配飞书 → 静默 return。
    const key = await importConfigKey(env.CONFIG_KEY);
    const owner = await getOwnerConfig(env.DB, key, ownerId);
    if (owner.feishu === null) {
      return;
    }
    const feishu = owner.feishu;
    // 3) 换 tenant_access_token（失败抛 FeishuTokenError，落入下方 catch 被吞）。
    const token = await getFeishuTenantToken(feishu.appId, feishu.appSecret);
    // 4) 列出现有列「名 → { type, fieldId }」（失败抛 BitableWriteError，落入 catch 被吞）。
    const existing = await listBitableColumnsDetailed(token, feishu.appToken, feishu.tableId);
    // 5) 逐项改名——冲突 / 边界逐项跳过、互不影响、单项失败不外抛（§16.8.7）。
    for (const rename of renames) {
      const col = existing.get(rename.oldLabel);
      // 旧 label 在现有列里找不到（从没建过 / 已被改过）→ 跳过该项。
      if (col === undefined) {
        continue;
      }
      // 新 label 已是另一个不同列（撞名）→ 跳过 + 记日志（不含凭据 / 列值），不强改。
      const collision = existing.get(rename.newLabel);
      if (collision !== undefined && collision.fieldId !== col.fieldId) {
        console.error("feishu column rename skipped: target name already exists");
        continue;
      }
      try {
        // 用该列 fieldId + 列现有类型改名（只改名不改类型）。单项失败 try/catch 吞掉、继续下一项。
        await renameBitableColumn(
          token,
          feishu.appToken,
          feishu.tableId,
          col.fieldId,
          rename.newLabel,
          col.type,
        );
        // 本地视图同步：改名后该列以新名存在、旧名消失，使同批次后续改名的撞名 / 定位判断准确。
        existing.delete(rename.oldLabel);
        existing.set(rename.newLabel, col);
      } catch (itemErr) {
        // 单条改名失败 → 静默跳过，只记 err.name（绝不含 token / secret / 列值，§15.7），不外抛。
        console.error(
          "feishu column rename item failed",
          itemErr instanceof Error ? itemErr.name : "unknown",
        );
      }
    }
  } catch (err) {
    // best-effort 铁律（§16.8.7）：owner 未配飞书 / 飞书连不上 / token 换取失败 / 列出失败 ——
    // 一律静默吞掉，绝不改变编辑的状态码与响应体。只记 err.name，绝不把 app_secret /
    // tenant_access_token / 列值写进日志（§15.7）。
    console.error(
      "sync feishu column renames best-effort failed",
      err instanceof Error ? err.name : "unknown",
    );
  }
}
