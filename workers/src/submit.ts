// submit.ts — type contracts for the submit-to-bitable endpoint `POST /api/submit`.
// See SPEC.md §15 (后端 · 提交写飞书多维表格：答题落库).
//
// An answerer submits one filled form; the Worker reads the owner's saved Feishu
// credentials (via getOwnerConfig — credentials are NOT taken from the request
// body), exchanges them for a tenant_access_token (the shared helper in
// feishu.ts), then writes one record into the owner's Bitable. The owner's
// app_secret and the tenant_access_token stay in-Worker and never leave (§15.7).
//
// Layering: the pure / mockable seams below are the inner-loop unit-test targets
// and the outer-loop seam:
//   - parseSubmitRequest: pure shape validation (empty answers → reject),
//   - answersToFields:    pure answers → Feishu fields mapping (§15.3),
//   - writeToBitable:     exactly one upstream call (add-record), maps the
//                         response to a recordId or throws.
// The Hono route (parse → read+decrypt config → 409 if no Feishu → get token →
// map fields → write → 200 { ok, recordId }) sits on top in index.ts and is
// exercised by the outer loop via SELF.fetch with a mocked open.feishu.cn.

import type { Field } from "./forms";
import { FEISHU_OK_CODE } from "./feishu";
import {
  FEISHU_BITABLE_FIELD_TYPE,
  formatValueForBitable,
  preCreateBitableColumns,
  toBitableFieldType,
  flattenLeafFields,
  type BitableColumnTypes,
  type FeishuFieldType,
} from "./feishu-schema";

/** Feishu Bitable add-record endpoint template. SPEC.md §15.5. Fill {app_token}/{table_id}. */
export const FEISHU_BITABLE_RECORDS_URL =
  "https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records";

/**
 * Feishu Bitable list-fields / add-field endpoint template. SPEC.md §15.5、§15.8.
 * Fill {app_token}/{table_id}. Used only by the §15.8 self-heal branch:
 * `GET .../fields?page_size=100` lists existing column names (`data.items[].field_name`),
 * `POST .../fields` with `{ field_name, type: 1 }` creates a missing text column.
 * Steady-state submits never hit this endpoint (反应式，非预检). The {@link FEISHU_FIELDS_LIST_PAGE_SIZE}
 * query is appended by the lister; the create call posts to the bare template.
 */
export const FEISHU_BITABLE_FIELDS_URL =
  "https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields";

/** `page_size` used when listing existing Bitable columns in the §15.8 self-heal. SPEC.md §15.5. */
export const FEISHU_FIELDS_LIST_PAGE_SIZE = 100;

/** Feishu Bitable field `type` for a plain text column. The §15.8 self-heal creates every
 * missing column as text (`type 1`). SPEC.md §15.8、§16.8.
 *
 * 历史：§15.8 自愈最初把每个缺列都建成文本（`type 1`）。§16.8 升级后，**精确的「字段 type →
 * 飞书列类型」映射**集中在 {@link import("./feishu-schema").FIELD_TYPE_TO_BITABLE}
 * （number→数字 / date→日期 / select→单选…），自愈与预建都改用它建**对应类型**的列。本常量保留为
 * 文本列的命名引用（= `FEISHU_BITABLE_FIELD_TYPE.TEXT`），二者数值一致；新代码取列类型一律经
 * feishu-schema 的 {@link import("./feishu-schema").toBitableFieldType}，不再硬编码 `1`。 */
export const FEISHU_FIELD_TYPE_TEXT = 1;

/**
 * Feishu business code `1254045` `FieldNameNotFound`: a write referenced a column that
 * does not exist in the target table. The write produces NO record and has no side effect,
 * which is what makes the §15.8 single retry safe. {@link writeToBitable} maps this code to
 * {@link BitableFieldMissingError}; it is the ONLY trigger of the §15.8 self-heal. SPEC.md §15.5、§15.8.
 */
export const FEISHU_CODE_FIELD_NOT_FOUND = 1254045;

/**
 * Feishu business code `1254014` `FieldNameDuplicated`: creating a column whose name already
 * exists. In the §15.8 self-heal this is treated as idempotent SUCCESS (a concurrent first
 * submit may have just created it) rather than a failure. SPEC.md §15.5、§15.8.
 */
export const FEISHU_CODE_FIELD_DUPLICATED = 1254014;

/**
 * One field's answer in a submitted form. `label` corresponds to §3.2 Field
 * `label` (MVP uses it directly as the Bitable column name); `value` is what the
 * answerer filled — a string, or a string[] for multi-select / multi-value.
 * See SPEC.md §15.2.
 */
export interface SubmitAnswer {
  /** Field label — used as the Bitable column key in the MVP. Non-empty. */
  label: string;
  /** The answer value; `string[]` for multi-select / multi-value. */
  value: string | string[];
}

/**
 * Request body for `POST /api/submit`: one answerer's full set of field answers.
 * `answers` must be a non-empty array. See SPEC.md §15.2、§16.5.
 *
 * `formSlug` 关联到一份已发布的表单（§16）：本期 route 先用它校验 form 是否存在
 * （不存在 → 404、不打飞书上游），存在则继续走 §15 的飞书写入。`formSlug` 暂不参与
 * answers ↔ fields 的字段级校验（从简，§16.5），但为将来多 owner「按 form 定位
 * owner」预留了入口。
 */
export interface SubmitRequest {
  /** 关联的已发布表单 slug（§16.5）。必填、非空。 */
  formSlug: string;
  answers: SubmitAnswer[];
}

/**
 * The Feishu Bitable add-record `fields` object: a flat map of column name →
 * value. Sent as `{ fields }` in the add-record request body. See SPEC.md §15.3、§16.8.
 *
 * 值类型（§16.8 升级）：原先（§15.3）只透传 `string | string[]`。升级后值由
 * {@link answersToTypedFields} **按目标列类型**格式化（{@link import("./feishu-schema").FormattedBitableValue}）
 * ——文本→`string`、数字 / 日期→`number`、单选→`string`、多选→`string[]`。无法安全格式化的格被**省略**
 * （不进 map），故 map 里**不含** `undefined` 值。`number` 加入并集即此次升级；旧的 `answersToFields`
 * （纯透传）仍保留作兼容/对照，但 submit 主路径改用 `answersToTypedFields`。
 */
export type BitableFields = Record<string, string | number | string[]>;

/**
 * Success result of `POST /api/submit`: the new record was written. Mirrors the
 * `200 { ok:true, recordId }` body. `recordId` comes from the upstream
 * `data.record.record_id`. See SPEC.md §15.4.
 *
 * The error branch is a separate `{ error }` body (see {@link SubmitErrorBody});
 * this success shape carries only `ok` + `recordId`, never the written fields,
 * the token, or any owner credential.
 */
export interface SubmitResult {
  ok: true;
  recordId: string;
}

/**
 * The JSON error shape for the non-success branches of `POST /api/submit`
 * (no Feishu configured, bad request, token-exchange / write failure). The
 * `error` string MUST NOT contain the owner's `app_secret`, the
 * `tenant_access_token`, or anything that could reconstruct them. See SPEC.md
 * §15.6, §15.7.
 */
export interface SubmitErrorBody {
  error: string;
}

/**
 * Thrown when `POST /api/submit` is invoked but the owner has no Feishu
 * configured (`OwnerConfig.feishu === null`). The route surfaces this as a
 * `409 { error: "owner 未配置飞书" }` and never calls upstream, letting the
 * frontend route the owner to 集成设置 (§12). See SPEC.md §15.6.
 */
export class FeishuNotConfiguredError extends Error {
  constructor(message = "owner 未配置飞书") {
    super(message);
    this.name = "FeishuNotConfiguredError";
  }
}

/**
 * Thrown when writing the record to the Bitable fails — upstream non-2xx or
 * response body `code !== 0`. The route surfaces this as a `502 { error }`.
 *
 * The `message` MUST NOT contain the `tenant_access_token` or the owner's
 * `app_secret`; it may carry the non-sensitive upstream `code` / HTTP status as a
 * troubleshooting hint. See SPEC.md §15.6, §15.7.
 */
export class BitableWriteError extends Error {
  constructor(message = "飞书新增记录失败") {
    super(message);
    this.name = "BitableWriteError";
  }
}

/**
 * A specialization of {@link BitableWriteError} thrown by {@link writeToBitable} when the
 * add-record response carries `code === ` {@link FEISHU_CODE_FIELD_NOT_FOUND} (`1254045`
 * `FieldNameNotFound`) — i.e. the write referenced a column that doesn't exist in the target
 * table. Per §15.8 this write produced NO record (no side effect), so it is a recoverable
 * signal, not a terminal error: {@link writeRecordWithFieldEnsure} catches it, creates the
 * missing columns ({@link ensureBitableFields}), and retries the write exactly once.
 *
 * It deliberately `extends BitableWriteError` so that if the self-heal's single retry STILL
 * fails, the existing `catch (err instanceof BitableWriteError) → 502` in index.ts already
 * covers it — no new route branch is needed for the "重试仍失败" terminal case (§15.6).
 *
 * The `message` MUST NOT contain the `tenant_access_token` or the owner's `app_secret`
 * (§15.7); it may carry the non-sensitive upstream `code` as a hint.
 */
export class BitableFieldMissingError extends BitableWriteError {
  constructor(message = "飞书新增记录失败：列不存在") {
    super(message);
    this.name = "BitableFieldMissingError";
  }
}

/**
 * Validate + normalize a parsed JSON body into a {@link SubmitRequest}.
 *
 * - `formSlug` must be a non-empty string; otherwise reject (the route maps the
 *   rejection to `400 { error: "formSlug is required" }`, nothing forwarded).
 *   Existence of the form is NOT checked here — that是 route 在拿到合法形状后用
 *   `formExists` 做的（不存在 → 404，§16.5）；本函数只做形状级校验。
 * - `answers` must be a non-empty array; otherwise reject (the route maps the
 *   rejection to `400 { error: "answers is required" }`, nothing forwarded).
 * - Each answer must have a non-empty string `label` and a `value` that is a
 *   string or a string[]; otherwise reject (`400`, nothing forwarded).
 * - Does NOT validate answers against the form's schema here — that is now a
 *   SEPARATE step done by the route AFTER `formExists` + the status gate, via
 *   {@link validateAnswers} (§20.3). `parseSubmitRequest` stays shape-only;
 *   required-field / 字段级 checks moved to `validateAnswers`. See §15.2、§16.5、§20.
 *
 * @throws if the body fails shape validation.
 */
export function parseSubmitRequest(body: unknown): SubmitRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("answers is required");
  }
  const formSlug = (body as { formSlug?: unknown }).formSlug;
  if (typeof formSlug !== "string" || formSlug.length === 0) {
    throw new Error("formSlug is required");
  }
  const answers = (body as { answers?: unknown }).answers;
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error("answers is required");
  }
  for (const answer of answers) {
    if (typeof answer !== "object" || answer === null) {
      throw new Error("each answer must be { label, value }");
    }
    const { label, value } = answer as { label?: unknown; value?: unknown };
    if (typeof label !== "string" || label.length === 0) {
      throw new Error("answer.label must be a non-empty string");
    }
    const isString = typeof value === "string";
    const isStringArray = Array.isArray(value) && value.every((v) => typeof v === "string");
    if (!isString && !isStringArray) {
      throw new Error("answer.value must be a string or string[]");
    }
  }
  return { formSlug, answers: answers as SubmitAnswer[] };
}

/**
 * Map validated {@link SubmitAnswer}s into the Feishu Bitable {@link BitableFields}
 * object: key = `answer.label`, value = `answer.value` (string as-is, string[]
 * as-is). No structured type conversion. See SPEC.md §15.3.
 *
 * **§16.8 升级注记（给 implementer）：** 这是原始的**纯透传**映射，不做类型格式化。submit 主路径
 * 已改用 {@link answersToTypedFields}（按列真实类型格式化值）。本函数保留作兼容 / 对照，以及那些
 * **拿不到列类型**的退化场景（如列出列失败后的最末兜底）；新建语义请走 `answersToTypedFields`。
 *
 * @param answers the validated answers from {@link parseSubmitRequest}.
 */
export function answersToFields(answers: SubmitAnswer[]): BitableFields {
  const fields: BitableFields = {};
  for (const { label, value } of answers) {
    // MVP: label uniqueness is assumed (SPEC §15.3); a repeated label overwrites.
    fields[label] = value;
  }
  return fields;
}

/**
 * Map validated {@link SubmitAnswer}s into a **typed** {@link BitableFields}——按每列的**真实**
 * 飞书列类型把每个答案值格式化成飞书可接收的形态（§16.8 / §15.8 升级）。submit 主路径用它替代
 * {@link answersToFields}。
 *
 * **既有列冲突兜底——方案 a（已选，见 §15.8 升级 / §16.8）：** 提交时先 `listBitableColumns`
 * （feishu-schema.ts）拿到目标表**现有每列的真实类型**，再用列的**真实类型**（而非字段声明 type）
 * 格式化值。这样能正确兜住「本 feature 前 §15.8 自愈建的旧文本列」「未重新发布的旧表」「列类型与
 * 字段声明漂移」——按列真实类型写，飞书不会因类型不符整条拒掉。代价是 happy path 每次提交多一次
 * `GET .../fields`（取舍见 §15.8 升级；选 a 不选 b「乐观写+失败回退文本重试」是因为 a 一次列出就
 * 拿到全部列类型、一致且无重试风暴，b 省一次调用但每个类型不符的字段都要触发一轮写失败+回退重试，
 * 调用数与延迟在多字段表上反而更差、且回退成文本会丢类型）。
 *
 * 规则：
 * - 键 = `answer.label`（§15.3 label 即列名）。
 * - 列类型按以下优先级取（§16.8.4 修订）：
 *   1. **列已存在**（命中 `columnTypes`，{@link BitableColumnTypes}）→ 用该列**真实类型**（方案 a，
 *      兜旧文本列 / 类型漂移，不改既有列语义）。
 *   2. **列缺失**（不在 `columnTypes`，预建漏了 / 自愈尚未建）→ 用该字段**自身映射类型**
 *      `toBitableFieldType(field.type)`（按 `fieldDefs` 里 `label↔type` 查）。这是为非文本字段而
 *      生的关键修订：缺列会由 {@link writeRecordWithFieldEnsure} 的自愈**按字段映射类型建成那个类型**
 *      （如 `number` → 数字列），故第一次写就要带**该类型化值**（`95` 而非 `"95"`），自愈重试才能
 *      命中新建的类型列；若仍按文本格式化，重试会把文本塞进数字/日期/多选列被飞书拒（§16.8.4）。
 *   3. **列缺失且 `fieldDefs` 里也无此 label**（异常态）→ 退化为按文本格式化（最稳兜底）。
 * - 值经 {@link import("./feishu-schema").formatValueForBitable}(value, targetType) 格式化；
 *   返回 `undefined`（无法安全格式化，如脏数字 / 坏日期）→ **省略该键**（不写该格）。
 *
 * @param answers 已过 {@link parseSubmitRequest} + {@link validateAnswers} 的作答。
 * @param columnTypes 目标表现有列的「列名 → 真实类型」（来自 {@link import("./feishu-schema").listBitableColumns}）。
 * @param fieldDefs 该 form 的字段定义（§3.2 Field[]，含 group）；用于给**缺列**按字段映射类型格式化值
 *   （内部 `flattenLeafFields` 摊平 group，故分组子字段也能按其类型格式化）。
 * @returns 已格式化、可直接进 add-record body `{ fields }` 的 map（不含被省略的键）。
 */
export function answersToTypedFields(
  answers: SubmitAnswer[],
  columnTypes: BitableColumnTypes,
  fieldDefs: Field[],
): BitableFields {
  // label → 字段映射类型（摊平 group，分组子字段也进表）。给「缺列」的答案按字段自身映射类型
  // 格式化（§16.8.4 修订）——自愈正会把缺列建成这个类型，故首写就带匹配类型值，重试天然命中。
  const labelToFieldType = new Map<string, FeishuFieldType>();
  for (const leaf of flattenLeafFields(fieldDefs)) {
    if (!labelToFieldType.has(leaf.label)) {
      labelToFieldType.set(leaf.label, toBitableFieldType(leaf.type));
    }
  }

  const fields: BitableFields = {};
  for (const { label, value } of answers) {
    // 列类型优先级：已存在列用真实类型（方案 a，兜旧文本列）；缺列用字段自身映射类型（自愈会建成
    // 那个类型）；缺列且无字段定义（异常态）→ 文本兜底。
    const targetType =
      columnTypes.get(label) ?? labelToFieldType.get(label) ?? FEISHU_BITABLE_FIELD_TYPE.TEXT;
    const formatted = formatValueForBitable(value, targetType);
    // 返回 undefined（无法安全格式化，如脏数字 / 坏日期 / 空值）→ 省略该键，绝不写一个会被
    // 飞书整条拒掉的脏值。MVP label 唯一（§15.3），重复 label 后者覆盖。
    if (formatted !== undefined) {
      fields[label] = formatted;
    }
  }
  return fields;
}

/**
 * Write one record into the owner's Feishu Bitable.
 *
 * - Calls `POST` the {@link FEISHU_BITABLE_RECORDS_URL} with `{app_token}` /
 *   `{table_id}` filled, `Authorization: Bearer <token>`, body `{ fields }`.
 * - Success requires upstream `2xx` AND response body `code === 0`; returns the
 *   `record_id` taken from `data.record.record_id`.
 * - `code === ` {@link FEISHU_CODE_FIELD_NOT_FOUND} (`1254045` `FieldNameNotFound`,
 *   a referenced column doesn't exist) → throws {@link BitableFieldMissingError}.
 *   This is the recoverable §15.8 signal: the write made no record, so
 *   {@link writeRecordWithFieldEnsure} catches it, back-fills the missing columns, and
 *   retries once. Because `BitableFieldMissingError extends BitableWriteError`, a retry
 *   that still fails is still caught by the route's `BitableWriteError → 502` branch.
 * - Any other non-2xx or `code !== 0` → throws {@link BitableWriteError} (the route maps
 *   it to `502 { error }`). The thrown message MUST NEVER contain `token`. See §15.7.
 *
 * @param token the tenant_access_token from getFeishuTenantToken (feishu.ts).
 * @param appToken owner's Bitable app token (from getOwnerConfig).
 * @param tableId owner's Bitable table id (from getOwnerConfig).
 * @param fields the column→value map from {@link answersToFields}.
 * @returns `{ recordId }` on success.
 * @throws {@link BitableFieldMissingError} when `code === 1254045` (列不存在；可自愈).
 * @throws {@link BitableWriteError} when the write otherwise fails.
 */
export async function writeToBitable(
  token: string,
  appToken: string,
  tableId: string,
  fields: BitableFields,
): Promise<{ recordId: string }> {
  const url = FEISHU_BITABLE_RECORDS_URL.replace("{app_token}", appToken).replace(
    "{table_id}",
    tableId,
  );
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        // The tenant_access_token's ONLY destination (SPEC §15.7).
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ fields }),
    });
  } catch {
    // Network error / timeout: never fold the caught error (which may embed the
    // Authorization header) into the message — only a credential-free hint.
    throw new BitableWriteError("飞书新增记录失败：上游不可达");
  }

  // HTTP 200 may still carry a non-zero business code, so success requires both
  // 2xx AND body code === 0. An unparseable body is a failed write. Only the
  // non-sensitive HTTP status / upstream code may ride the message — never the
  // token or app_secret. SPEC §15.5, §15.7.
  let body: { code?: number; data?: { record?: { record_id?: string } } };
  try {
    body = (await res.json()) as {
      code?: number;
      data?: { record?: { record_id?: string } };
    };
  } catch {
    throw new BitableWriteError(`飞书新增记录失败：上游返回 ${res.status}`);
  }

  const recordId = body.data?.record?.record_id;
  if (res.ok && body.code === 0 && typeof recordId === "string") {
    return { recordId };
  }
  // `1254045`（列不存在）是可自愈的特例：抛子类让 writeRecordWithFieldEnsure 捕获、补列、
  // 重试一次（§15.8）。其它 code≠0 / 非 2xx 是普通写失败。两者 message 都只带非敏感 code（§15.7）。
  if (body.code === FEISHU_CODE_FIELD_NOT_FOUND) {
    throw new BitableFieldMissingError(`飞书新增记录失败：列不存在（code ${body.code}）`);
  }
  throw new BitableWriteError(`飞书新增记录失败：code ${body.code}`);
}

// ---------------------------------------------------------------------------
// §15.8：飞书列自动创建（自愈）—— 反应式、稳态零开销（实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * Back-fill the Bitable columns the current write needs that don't yet exist in the target
 * table — **建成与字段 type 对应的类型列**（§16.8 升级；不再一律文本）。Called ONLY by the
 * §15.8 self-heal branch, after a write returned {@link FEISHU_CODE_FIELD_NOT_FOUND} — never
 * on the steady-state happy path.
 *
 * **§16.8 升级注记（给 implementer）：** 旧契约一律建文本列（`type 1`）、只收 `fieldNames: string[]`。
 * 升级后收 `fields: Field[]`（这次写入涉及的字段定义），按 {@link import("./feishu-schema").toBitableFieldType}
 * 给每个缺列建**对应类型**的列（number→数字 / date→日期 / select→单选…），单选 / 多选还要带
 * {@link import("./feishu-schema").buildFieldProperty} 生成的 `property.options`。列名 = `field.label`
 * （§15.3 label 对位）。implementer 须把本函数的实现从「`POST {field_name, type:1}`」改为
 * 「`POST {field_name, type: toBitableFieldType(field.type), property?: buildFieldProperty(field)}`」。
 *
 * Contract（§15.8 不变 + §16.8 类型化）：
 * - List existing columns: `GET` {@link FEISHU_BITABLE_FIELDS_URL}（`?page_size=`
 *   {@link FEISHU_FIELDS_LIST_PAGE_SIZE}），`Authorization: Bearer <token>`，no body。Success
 *   requires `2xx` AND body `code === 0`；the existing column-name set is `data.items[].field_name`。
 * - 对 `fields` 里**列名（`field.label`）不在现有集合**的每个字段，`POST`
 *   {@link FEISHU_BITABLE_FIELDS_URL}，body `{ field_name: field.label,
 *   type: toBitableFieldType(field.type), property?: buildFieldProperty(field) }`。Success requires
 *   `2xx` AND `code === 0`。`code === ` {@link FEISHU_CODE_FIELD_DUPLICATED}（`1254014`
 *   `FieldNameDuplicated`，并发下别处刚建）视为**幂等成功**，跳过（§15.8 幂等与并发）。
 * - **绝不改既有列**：列名已存在 → 跳过该字段，不改其类型（§16.8 范围）。
 * - 其它列出 / 建列 failure（非 2xx、`code !== 0` 且非 `1254014`、unparseable body、不可达）→
 *   throw {@link BitableWriteError}（route → `502`，§15.6）。thrown `message` 绝不含 `token` /
 *   owner 凭据，只可带非敏感 `code` / HTTP 状态（§15.7）。
 * - 列名真相 = 本次写入需要的列（= `fields` 的 label 集合，§15.8）：只补这次要写的列，不强建整份
 *   schema。已存在的列不动；空 / 全已存在 → 不发任何建列调用。
 *
 * @param token tenant_access_token；只进 `Authorization` 头（§15.7）。
 * @param appToken owner Bitable app token。
 * @param tableId owner Bitable table id。
 * @param fields 这次写入涉及的字段定义（列名 = `field.label`，type 决定建列类型）。
 * @returns 每个 `field.label` 都存在为列后 resolve。
 * @throws {@link BitableWriteError} 列出 / 建列失败（非 `1254014`）。
 */
export async function ensureBitableFields(
  token: string,
  appToken: string,
  tableId: string,
  fields: Field[],
): Promise<void> {
  // 空 / 全已存在 → 不发任何建列调用。复用 feishu-schema 的预建（先列出现有列 → 只建缺列、
  // 按字段 type 建对应类型列、单选/多选带 options、1254014 幂等成功、绝不改既有列）——自愈与
  // 预建走同一条「按类型只建缺列」的路径，确保两边一致（§16.8）。本期 fields 已是叶子字段
  // （writeRecordWithFieldEnsure 传的是 fieldDefs 里 label 命中本次 fields 键的子集），
  // preCreateBitableColumns 内部也会再展平一次 group，幂等无害。
  if (fields.length === 0) {
    return;
  }
  await preCreateBitableColumns(token, appToken, tableId, fields);
}

/**
 * Write one record into the owner's Bitable, self-healing missing columns once (§15.8)——
 * 自愈现在按字段 type 建**对应类型**的列（§16.8 升级），而非一律文本。This is the orchestrator
 * the submit route calls instead of {@link writeToBitable} directly.
 *
 * **§16.8 升级注记（给 implementer）：** 旧契约只收 `fields: BitableFields`，自愈建文本列。升级后
 * 额外收 `fieldDefs: Field[]`（该 form 的字段定义，含 label↔type），用于：
 * (1) 自愈时把缺列建成正确类型（传给已升级的 {@link ensureBitableFields}）；
 * 注意：**写值的类型格式化**已在更上游完成——route 先 {@link import("./feishu-schema").listBitableColumns}
 * 拿列真实类型，再 {@link answersToTypedFields} 把 `answers` 格成 typed `fields` 后才传进来（既有列
 * 冲突兜底方案 a，§15.8 升级）。故本函数收到的 `fields` 已是 typed 值，它只管「写 → 缺列则按
 * `fieldDefs` 建对应类型列 → 重试一次」。
 *
 * 流程（§15.8 不变 + §16.8 类型化建列）：
 * 1. `writeToBitable(token, appToken, tableId, fields)`。成功 → `{ recordId }`，**不**碰字段端点
 *    （稳态零开销，反应式非预检）。
 * 2. 抛 {@link BitableFieldMissingError}（`code 1254045`，列不存在；失败写无记录、无副作用）→
 *    `ensureBitableFields(token, appToken, tableId, <flattenLeafFields(fieldDefs) 中 label 命中本次
 *    fields 键的子集>)` 按字段 type 补建缺列，再 `writeToBitable` **恰好一次**。先 `flattenLeafFields`
 *    摊平 group（与发布预建对齐），分组子字段的缺列才能被自愈建到。
 * 3. 单次重试的结果即终态：成功 → `{ recordId }`；仍抛（仍 `1254045` 或任何
 *    {@link BitableWriteError}）→ 传播，route → `502`（§15.6）。**不**再循环（§15.8.3）。
 *
 * 第一次写入的其它 {@link BitableWriteError}（非 {@link BitableFieldMissingError}）不是自愈候选，
 * 原样传播；`ensureBitableFields` 失败同样以 {@link BitableWriteError} 传播。本函数任何 message
 * 绝不含 `token` / owner 凭据（§15.7）。
 *
 * @param token tenant_access_token（feishu.ts 的 getFeishuTenantToken）；只进 Authorization 头。
 * @param appToken owner Bitable app token。
 * @param tableId owner Bitable table id。
 * @param fields **已类型化**的列→值 map（来自 {@link answersToTypedFields}）。
 * @param fieldDefs 该 form 的字段定义（§3.2 Field[]）；自愈据此把缺列建成对应类型（label↔type）。
 * @returns `{ recordId }`（首写成功或单次自愈重试后）。
 * @throws {@link BitableWriteError} 终态写失败（含自愈后重试仍失败）或自愈列出 / 建列失败。
 */
export async function writeRecordWithFieldEnsure(
  token: string,
  appToken: string,
  tableId: string,
  fields: BitableFields,
  fieldDefs: Field[],
): Promise<{ recordId: string }> {
  try {
    // 1) 稳态：直接写。成功 → recordId，不碰字段端点（反应式非预检，§15.8）。
    return await writeToBitable(token, appToken, tableId, fields);
  } catch (err) {
    // 2) 仅 1254045（列不存在；失败写无记录、无副作用）才自愈。其它 BitableWriteError 原样传播。
    if (!(err instanceof BitableFieldMissingError)) {
      throw err;
    }
    // 按字段 type 补建本次写入涉及的缺列——先用 flattenLeafFields 把 fieldDefs 摊平成叶子字段
    // （与发布预建对齐），再取 label 命中本次 fields 键的子集（§15.8 只补这次要写的列）。**必须先
    // 摊平**：group 容器自身无值、其 label 不是写入键，会被 writeKeys 过滤掉，而其子字段 label 埋在
    // children 里——不摊平则分组子字段的缺列被漏建、自愈重试仍失败（与发布预建的 group 处理不一致）。
    const writeKeys = new Set(Object.keys(fields));
    const neededDefs = flattenLeafFields(fieldDefs).filter((f) => writeKeys.has(f.label));
    await ensureBitableFields(token, appToken, tableId, neededDefs);
    // 3) 恰好重试一次即终态：成功 → recordId；仍抛（仍 1254045 或任何 BitableWriteError）→
    //    传播，route → 502（§15.6）。不再循环（§15.8.3）。
    return await writeToBitable(token, appToken, tableId, fields);
  }
}

// ---------------------------------------------------------------------------
// §20：提交前的状态门 + answers 对 schema 必填校验（实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * Thrown when `POST /api/submit` targets a form whose status is NOT `'published'`
 * (`'draft'` / `'closed'`) — the form exists but is not currently accepting
 * submissions (§20.2). The route surfaces this as `409 { error }` and never reads
 * owner config / touches any Feishu upstream.
 *
 * 注意与 {@link FeishuNotConfiguredError} 区分：两者都映射成 `409`，但语义不同
 * （此为「表单未开放提交」，彼为「owner 未配飞书」），靠 `error` 文案区分（§20.4）。
 */
export class FormNotPublishedError extends Error {
  constructor(message = "表单未开放提交") {
    super(message);
    this.name = "FormNotPublishedError";
  }
}

/**
 * Thrown when the submitted `answers` fail validation against the form's schema —
 * MVP: a `required` field has no non-empty answer (§20.3). The route surfaces this
 * as `400 { error }` and never touches any Feishu upstream.
 *
 * The `message` may name the offending field (non-sensitive, helps the answerer
 * correct it) but MUST NOT contain any owner credential (§20.4).
 */
export class AnswersValidationError extends Error {
  constructor(message = "answers 校验未通过") {
    super(message);
    this.name = "AnswersValidationError";
  }
}

/**
 * 按 form 的 `fields`（§3.2 Field 真相）校验提交的 `answers`（§20.3）。route 在
 * `formExists` + 状态门通过后调用；校验失败 → route `400 { error }`，不打飞书上游。
 *
 * **MVP 必做——必填校验：** 对每个 `required === true` 的 field，要求 `answers` 里存在
 * 一条 `label` 等于该 field `label`（§15.3 的 label 对位约定）、且 `value` 非空的作答；
 * 缺失或空值 → 抛 {@link AnswersValidationError}。「空值」至少覆盖：空串 / 纯空白串 / 空数组
 * （多选未选）。
 *
 * **可选增强（本期不强制，§20.3）：** 类型校验（number 是否数字串）、select/radio/checkbox
 * 的 `value` 是否落在 `options` 内、`validation`（pattern/min/max）——若实现，失败同样抛
 * {@link AnswersValidationError}（同一 `400` 出口）。group `children` 的递归必填校验亦为
 * 可选增强；MVP 至少校验顶层 `fields`。
 *
 * @param fields 该 form 的字段定义（来自 forms.ts 的 getFormFields）。
 * @param answers 已通过 {@link parseSubmitRequest} 形状校验的作答。
 * @throws {@link AnswersValidationError} when 必填项缺失 / 空值（或可选的类型/选项校验失败）。
 */
export function validateAnswers(fields: Field[], answers: SubmitAnswer[]): void {
  // label → 提交值的索引（§15.3 / §20.3 的 label 对位约定）。
  const byLabel = new Map<string, SubmitAnswer["value"]>();
  for (const { label, value } of answers) {
    byLabel.set(label, value);
  }

  for (const field of fields) {
    // MVP 只校验顶层 required 字段；非必填缺失 / 空值不拦（§20.3）。
    if (field.required !== true) {
      continue;
    }
    const value = byLabel.get(field.label);
    if (isEmptyAnswer(value)) {
      // 文案点名缺失字段（非敏感，帮答题者修正，§20.4）；绝不含任何 owner 凭据。
      throw new AnswersValidationError(`必填字段「${field.label}」未填写`);
    }
  }
}

/**
 * 「空值」判定（§20.3）：未作答（undefined）/ 空串 / 纯空白串 / 空数组（多选未选）均视为空。
 * 字符串数组里若全是空白项也视为未选。
 */
function isEmptyAnswer(value: SubmitAnswer["value"] | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  // string[]：空数组、或所有项都是空白 → 视为未选。
  return value.length === 0 || value.every((v) => v.trim().length === 0);
}
