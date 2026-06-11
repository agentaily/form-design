// forms.ts — type contracts for 表单发布 + 公开填写拉取.
// See SPEC.md §16 (后端 · 表单发布 + 公开填写).
//
// This module closes the 设计 → 发布 → 公开填写 → 写飞书 loop on the backend:
//   - 发布表单   POST /api/forms        — owner 提交表单定义 → 生成 slug + 存 D1 → { slug }
//   - 公开拉取   GET  /api/forms/:slug  — 答题者无鉴权拉取 meta + fields 用于渲染填写页
//   - submit 关联 POST /api/submit      — body 增加 formSlug，先校验 form 存在再写飞书
//
// 安全核心（§16.4）：公开拉取走的是 PublicForm 视图，它只含 meta + fields；它与
// owner_config（DeepSeek key / 飞书凭据）在不同的表、不同的查询路径，PublicForm 的
// 类型里**根本没有**承载任何凭据的字段，所以「不泄漏凭据」是类型级保证，而非运行期
// 过滤的产物。
//
// Layering: the pure / mockable seams below are the inner-loop unit-test targets,
// and the D1 read/write functions are the outer-loop seam:
//   - parsePublishInput: pure shape validation (meta + fields 对齐 §3.2 Field[]),
//   - generateSlug:      pure slug 生成（公开、不可猜、URL 安全）,
//   - saveForm:          insert 一行 forms → { slug }（owner_id 恒 'default'）,
//   - getPublicForm:     按 slug 读一行 → PublicForm | null（不存在 → null）.
// The Hono routes (parse → save → 201 { slug }；读 → 200 / 404) sit on top in
// index.ts and are exercised by the outer loop via SELF.fetch.

// ---------------------------------------------------------------------------
// 字段模型（对齐 SPEC.md §3.2 Field[]）
// ---------------------------------------------------------------------------

/** 字段类型，对齐 SPEC.md §3.2 的 `Field['type']`。 */
export type FieldType =
  | "text"
  | "number"
  | "select"
  | "date"
  | "checkbox"
  | "radio"
  | "file"
  | "group";

/** 选项（select / radio / checkbox 用），对齐 §3.2。 */
export interface FieldOption {
  label: string;
  value: string;
}

/** 字段校验规则，对齐 §3.2。 */
export interface FieldValidation {
  pattern?: string;
  min?: number;
  max?: number;
  message?: string;
}

/**
 * 表单字段，对齐 SPEC.md §3.2 的 `Field`。这是**数据真相**：答题者填写页据此渲染、
 * submit 据此对位。本期发布 / 拉取**整体透传**字段定义，不做字段级语义校验（§16.5）。
 */
export interface Field {
  id: string;
  type: FieldType;
  label: string;
  required?: boolean;
  options?: FieldOption[];
  validation?: FieldValidation;
  /** group 嵌套子字段。 */
  children?: Field[];
}

// ---------------------------------------------------------------------------
// 表单元信息 + 定义
// ---------------------------------------------------------------------------

/**
 * 表单展示用元信息（标题 / 介绍）。公开拉取会原样回给答题者用于渲染填写页头部，
 * 因此**只放可公开的展示文案**，绝不放任何凭据 / owner 私有配置。
 */
export interface FormMeta {
  /** 表单标题。必填、非空。 */
  title: string;
  /** 表单介绍 / 副标题。可选。 */
  description?: string;
}

/**
 * 一份完整的表单定义：展示用 `meta` + 数据真相 `fields`。这是发布的输入主体，也是
 * 公开拉取回给答题者的主体（见 {@link PublicForm}）。
 */
export interface FormDefinition {
  meta: FormMeta;
  fields: Field[];
}

/**
 * `POST /api/forms` 的请求体（发布表单的输入）。本期等同于一份 {@link FormDefinition}：
 * owner 提交 `meta` + `fields`，后端生成 slug 落库。owner_id 不在请求体里（MVP 恒
 * `'default'`，见 §16.3）。
 */
export interface PublishFormInput {
  meta: FormMeta;
  fields: Field[];
}

/**
 * `POST /api/forms` 的成功响应（§16.2）。只回 `slug`（以及可选的可直接访问的公开
 * `url`），不回 owner_id / 内部行 id。
 */
export interface PublishFormResult {
  /** 公开 slug，作为 forms 表主键 + 公开访问标识。 */
  slug: string;
  /** 可选：拼好的公开填写页 URL，便于 owner 直接复制分享（实现可省略）。 */
  url?: string;
}

/**
 * 公开拉取 `GET /api/forms/:slug` 的响应视图（§16.2、§16.4）。
 *
 * **这是「不泄漏凭据」的类型级边界**：它**只含** `slug` + `meta` + `fields`，
 * 类型里根本没有承载 DeepSeek key / 飞书 app_secret / app_token / table_id / owner_id
 * 的字段。即便将来 forms 行里挂上更多 owner 私有信息，公开拉取也只能投影出这三样。
 */
export interface PublicForm {
  /** 该表单的公开 slug。 */
  slug: string;
  meta: FormMeta;
  fields: Field[];
}

/** 表单状态。MVP 发布即 `'published'`；预留 `'draft'` / `'closed'` 供后续 feature。 */
export type FormStatus = "published" | "draft" | "closed";

/**
 * Thrown by {@link parsePublishInput} when the publish body fails shape
 * validation (缺 meta.title / fields 非数组 / 字段缺 id|type|label 等)。The route
 * surfaces this as `400 { error }`, 不落库。See SPEC.md §16.2、§16.5.
 */
export class FormValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormValidationError";
  }
}

/**
 * Thrown when `POST /api/submit` 收到一个 `formSlug` 但该 form 在 D1 里不存在。
 * The submit route surfaces this as `404 { error }` 且**不打任何飞书上游**
 * (不换 token、不写记录)。See SPEC.md §16.5、§16.6.
 */
export class FormNotFoundError extends Error {
  constructor(message = "form not found") {
    super(message);
    this.name = "FormNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// 纯逻辑 + D1 读写（实现留给 implementer）
// ---------------------------------------------------------------------------

/** 合法 FieldType 的集合，对齐 §3.2 / {@link FieldType}（运行期形状校验用）。 */
const FIELD_TYPES: ReadonlySet<string> = new Set<FieldType>([
  "text",
  "number",
  "select",
  "date",
  "checkbox",
  "radio",
  "file",
  "group",
]);

/** 非空字符串守卫。 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * 校验 + 规整一个解析后的 JSON body 成 {@link PublishFormInput}。
 *
 * - `meta` 必须是对象且 `meta.title` 为非空字符串；否则 reject。
 * - `fields` 必须是数组（**可为空** —— 空表单的发布约定见 §16.5）；否则 reject。
 * - 每个 field 须有非空字符串 `id` / `label` 与合法 `type`（对齐 §3.2 FieldType）；
 *   `options` / `validation` / `children` 形状若提供则做浅校验，否则 reject。
 * - 本期**不做**字段级业务校验（不校验 select 必须带 options、id 是否唯一等），
 *   只做形状级校验，把合法形状的定义透传落库（§16.5）。
 * - **深度上限（§16.2 安全 nit）：** group 字段的 `children` 递归不得超过
 *   {@link MAX_FIELD_DEPTH} 层；超限即视为形状非法 → 抛 {@link FormValidationError}（route
 *   → 400，不落库），用以挡住深度爆栈 / 资源耗尽的畸形 payload。
 *
 * @throws {@link FormValidationError} when 形状校验失败 / 嵌套超 {@link MAX_FIELD_DEPTH}（route → 400，不落库）。
 */
export function parsePublishInput(body: unknown): PublishFormInput {
  // 顶层必须是普通对象（数组 / null / 标量都拒绝）。
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new FormValidationError("body must be a JSON object");
  }

  const { meta, fields } = body as { meta?: unknown; fields?: unknown };

  // meta：对象且 title 为非空字符串。description 可选。
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new FormValidationError("meta is required");
  }
  const { title, description } = meta as { title?: unknown; description?: unknown };
  if (!isNonEmptyString(title)) {
    throw new FormValidationError("meta.title is required");
  }
  if (description !== undefined && typeof description !== "string") {
    throw new FormValidationError("meta.description must be a string");
  }

  // fields：必须是数组（可为空，§16.5）。
  if (!Array.isArray(fields)) {
    throw new FormValidationError("fields must be an array");
  }
  const parsedFields = fields.map((field) => parseField(field));

  const parsedMeta: FormMeta = { title };
  if (description !== undefined) {
    parsedMeta.description = description;
  }
  return { meta: parsedMeta, fields: parsedFields };
}

/**
 * 浅校验单个 field 的形状（id / type / label + 可选 options / validation / children）。
 * 只做形状级校验、原样透传合法值，不做字段级业务校验（§16.5）。
 *
 * **深度上限（§16.2 安全 nit）：** 通过 `depth` 参数跟踪当前嵌套层级，递归 `children` 时
 * `depth + 1`；当 `depth` 超过 {@link MAX_FIELD_DEPTH} 即抛 {@link FormValidationError}，
 * 挡住深度爆栈 / 资源耗尽的畸形 payload。`implementer` 须把 `depth` 沿 `children.map`
 * 递归传下去（顶层从 0 起算）。
 *
 * @param field 待校验的原始值。
 * @param depth 当前嵌套深度（顶层 0）；超 {@link MAX_FIELD_DEPTH} → 形状非法。
 * @throws {@link FormValidationError} when 形状非法 / 嵌套超 {@link MAX_FIELD_DEPTH}。
 */
function parseField(field: unknown, depth = 0): Field {
  if (depth > MAX_FIELD_DEPTH) {
    throw new FormValidationError(`field nesting exceeds max depth ${MAX_FIELD_DEPTH}`);
  }
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    throw new FormValidationError("each field must be an object");
  }
  const f = field as Record<string, unknown>;

  if (!isNonEmptyString(f.id)) {
    throw new FormValidationError("field.id is required");
  }
  if (typeof f.type !== "string" || !FIELD_TYPES.has(f.type)) {
    throw new FormValidationError(`field.type is invalid: ${String(f.type)}`);
  }
  if (!isNonEmptyString(f.label)) {
    throw new FormValidationError("field.label is required");
  }

  const parsed: Field = {
    id: f.id,
    type: f.type as FieldType,
    label: f.label,
  };

  if (f.required !== undefined) {
    if (typeof f.required !== "boolean") {
      throw new FormValidationError("field.required must be a boolean");
    }
    parsed.required = f.required;
  }

  if (f.options !== undefined) {
    parsed.options = parseOptions(f.options);
  }

  if (f.validation !== undefined) {
    parsed.validation = parseValidation(f.validation);
  }

  if (f.children !== undefined) {
    if (!Array.isArray(f.children)) {
      throw new FormValidationError("field.children must be an array");
    }
    // 递归下探一层：§16.2 深度上限靠 depth + 1 累积，超 MAX_FIELD_DEPTH 在子层即拒绝。
    parsed.children = f.children.map((child) => parseField(child, depth + 1));
  }

  return parsed;
}

/** 浅校验 options 数组：每项须有非空 label + 字符串 value。 */
function parseOptions(options: unknown): FieldOption[] {
  if (!Array.isArray(options)) {
    throw new FormValidationError("field.options must be an array");
  }
  return options.map((opt) => {
    if (typeof opt !== "object" || opt === null || Array.isArray(opt)) {
      throw new FormValidationError("each option must be { label, value }");
    }
    const { label, value } = opt as { label?: unknown; value?: unknown };
    if (!isNonEmptyString(label)) {
      throw new FormValidationError("option.label must be a non-empty string");
    }
    if (typeof value !== "string") {
      throw new FormValidationError("option.value must be a string");
    }
    return { label, value };
  });
}

/** 浅校验 validation：pattern/message 为字符串、min/max 为数字（均可选）。 */
function parseValidation(validation: unknown): FieldValidation {
  if (typeof validation !== "object" || validation === null || Array.isArray(validation)) {
    throw new FormValidationError("field.validation must be an object");
  }
  const v = validation as Record<string, unknown>;
  const parsed: FieldValidation = {};
  if (v.pattern !== undefined) {
    if (typeof v.pattern !== "string") {
      throw new FormValidationError("validation.pattern must be a string");
    }
    parsed.pattern = v.pattern;
  }
  if (v.min !== undefined) {
    if (typeof v.min !== "number") {
      throw new FormValidationError("validation.min must be a number");
    }
    parsed.min = v.min;
  }
  if (v.max !== undefined) {
    if (typeof v.max !== "number") {
      throw new FormValidationError("validation.max must be a number");
    }
    parsed.max = v.max;
  }
  if (v.message !== undefined) {
    if (typeof v.message !== "string") {
      throw new FormValidationError("validation.message must be a string");
    }
    parsed.message = v.message;
  }
  return parsed;
}

/** base62 字母表（URL 安全：仅 alnum，无需转义）。 */
const SLUG_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** slug 长度：12 个 base62 字符 ≈ 71 bit 熵，远超「不可枚举 / 不可猜」需求。 */
const SLUG_LENGTH = 12;

/**
 * group 字段 `children` 的递归嵌套**深度上限**（§16.2 安全 nit，防深 payload）。
 * `parseField` 递归到超过此深度即视为形状非法 → {@link FormValidationError} → route `400`。
 * 一份正常表单的 group 嵌套远到不了这个量级；上限值为合约内固定常量，可按需微调，但**必须**存在。
 */
export const MAX_FIELD_DEPTH = 8;

/**
 * 生成一个公开 `slug`：URL 安全、对外即标识、**不可枚举 / 不可猜**（§16.3）。
 *
 * - 用 `crypto.getRandomValues` 取高熵随机字节，逐字节映射到 base62 字母表
 *   （仅 alnum，URL 安全、无需转义），不暴露自增序号。
 * - 唯一性：靠随机串的高熵 + slug 作主键的插入约束保证；插入冲突时由
 *   {@link saveForm} 重新生成再插（§16.3）。
 *
 * @returns 一个新的 slug 字符串（长度 {@link SLUG_LENGTH}）。
 */
export function generateSlug(): string {
  const bytes = new Uint8Array(SLUG_LENGTH);
  crypto.getRandomValues(bytes);
  let slug = "";
  for (const byte of bytes) {
    // 取模到 62 个字符。62 不整除 256 → 轻微偏置，但对「不可猜」无实质影响。
    slug += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
  }
  return slug;
}

/** MVP 单 owner：forms.owner_id 恒为 'default'（同 owner_config，§16.3）。 */
const DEFAULT_OWNER_ID = "default";
/** MVP 发布即 'published'（§16.7）。 */
const PUBLISHED_STATUS: FormStatus = "published";
/** slug 主键冲突时的最大重试次数（高熵下几乎永不触发）。 */
const MAX_SLUG_ATTEMPTS = 5;

/**
 * 把一份发布输入落成 forms 表的一行并返回其 slug（§16.2、§16.3）。
 *
 * - owner_id 恒为 `'default'`（MVP 单 owner，见 §16.3 / schema.sql）。
 * - slug 由 {@link generateSlug} 生成；`meta` / `fields` 分别序列化进 `meta_json` /
 *   `schema_json`；`status` 置 `'published'`；`created_at` 为当前 ISO-8601。
 * - slug 是主键：插入冲突（极罕见）则重新生成再插，至多 {@link MAX_SLUG_ATTEMPTS} 次。
 * - 返回 `{ slug }`（route 据此回 `201 { slug }`，可附 `url`）。
 *
 * @param db D1 binding（同 owner_config 所用的 `DB`）。
 * @param input 已由 {@link parsePublishInput} 校验过的发布输入。
 * @returns `{ slug }`。
 */
export async function saveForm(db: D1Database, input: PublishFormInput): Promise<{ slug: string }> {
  const metaJson = JSON.stringify(input.meta);
  const schemaJson = JSON.stringify(input.fields);
  const createdAt = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT INTO forms (slug, owner_id, meta_json, schema_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = generateSlug();
    try {
      await stmt
        .bind(slug, DEFAULT_OWNER_ID, metaJson, schemaJson, PUBLISHED_STATUS, createdAt)
        .run();
      return { slug };
    } catch (err) {
      // A PRIMARY KEY collision means the random slug已存在 → regenerate + retry.
      // Any other error (real DB failure) is not retryable — rethrow immediately.
      if (isUniqueConstraintError(err)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  // Exhausted retries on persistent slug collisions (statistically impossible at
  // 62^12 entropy) — surface the last collision rather than loop forever.
  throw lastErr instanceof Error ? lastErr : new Error("failed to generate a unique slug");
}

/** Detect a D1 / SQLite UNIQUE / PRIMARY KEY constraint violation. */
function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /UNIQUE constraint failed|PRIMARY KEY|constraint failed/i.test(err.message);
}

/**
 * 按 slug 读取公开表单视图（§16.2、§16.4）。
 *
 * - 命中：把行里的 `meta_json` / `schema_json` 反序列化成 `meta` / `fields`，连同
 *   `slug` 组装成 {@link PublicForm}。**只投影 meta + fields + slug**，绝不读取 /
 *   返回 owner_config 或任何凭据（这是类型级 + 查询级双重保证，§16.4）。
 * - 未命中（slug 不存在）：返回 `null`（route → 404）。
 *
 * @param db D1 binding。
 * @param slug 公开 slug。
 * @returns {@link PublicForm} 命中时，`null` 未命中时。
 */
export async function getPublicForm(db: D1Database, slug: string): Promise<PublicForm | null> {
  // 只投影 meta_json + schema_json（连同入参 slug 组装 PublicForm）。绝不 SELECT
  // owner_id / status / created_at，更不碰 owner_config —— 查询级 + 类型级双重保证
  // 凭据不外泄（§16.4）。
  const row = await db
    .prepare(`SELECT meta_json, schema_json FROM forms WHERE slug = ?`)
    .bind(slug)
    .first<{ meta_json: string; schema_json: string }>();

  if (row === null) {
    return null;
  }

  return {
    slug,
    meta: JSON.parse(row.meta_json) as FormMeta,
    fields: JSON.parse(row.schema_json) as Field[],
  };
}

/**
 * 判断某 slug 对应的 form 是否存在——submit 关联校验的轻量探针（§16.5）。
 *
 * 用于 `POST /api/submit`：拿到 body 里的 `formSlug` 后，先确认 form 存在再继续写
 * 飞书；不存在 → route 抛 {@link FormNotFoundError} → `404`，**不打任何飞书上游**。
 *
 * 实现可直接复用 {@link getPublicForm}（命中即存在），或做一次更轻的 `SELECT 1`。
 *
 * @param db D1 binding。
 * @param slug 来自 submit 请求体的 `formSlug`。
 * @returns `true` 存在、`false` 不存在。
 */
export async function formExists(db: D1Database, slug: string): Promise<boolean> {
  // 轻量探针：只问「这张表在不在」，不读 meta / schema / 任何 owner 维度字段。
  const row = await db
    .prepare(`SELECT 1 AS one FROM forms WHERE slug = ?`)
    .bind(slug)
    .first<{ one: number }>();
  return row !== null;
}

// ---------------------------------------------------------------------------
// §20：提交校验所需的 status / fields 读取（实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * 读取某 slug 对应 form 的 {@link FormStatus}（§20.2）。
 *
 * 供 `POST /api/submit` 在 {@link formExists} 之后做状态门：非 `'published'`
 * （`'draft'` / `'closed'`）→ route 拒收（`409 { error }`），不读 owner 配置、不打飞书上游。
 *
 * - 命中：返回该行的 `status`（`'published' | 'draft' | 'closed'`）。
 * - 未命中（slug 不存在）：返回 `null`（route 侧通常已先用 formExists 挡掉，本函数对
 *   不存在保持 `null` 即可）。
 *
 * 实现可与 {@link getFormFields} 合并成一次 D1 读（`SELECT status, schema_json ...`），
 * 也可独立查 `SELECT status ...`——由实现在合约内定。
 *
 * @param db D1 binding。
 * @param slug 来自 submit 请求体的 `formSlug`。
 * @returns 该 form 的 status，或 `null`（不存在）。
 */
export async function getFormStatus(db: D1Database, slug: string): Promise<FormStatus | null> {
  const row = await db
    .prepare(`SELECT status FROM forms WHERE slug = ?`)
    .bind(slug)
    .first<{ status: string }>();
  if (row === null) {
    return null;
  }
  return row.status as FormStatus;
}

/**
 * 读取某 slug 对应 form 的字段定义（schema 真相，§20.3）。
 *
 * 供 `POST /api/submit` 在状态门通过后，把它交给 {@link validateAnswers}（submit.ts）
 * 校验答案是否漏填必填项。这里读的是发布时存进 `schema_json` 的 `Field[]`（同公开拉取
 * 的 fields，但本调用是 owner 侧 submit 流程内部使用，不对外投影）。
 *
 * - 命中：把 `schema_json` 反序列化成 `Field[]` 返回。
 * - 未命中（slug 不存在）：返回 `null`。
 *
 * 实现可与 {@link getFormStatus} 合并成一次 D1 读。
 *
 * @param db D1 binding。
 * @param slug 来自 submit 请求体的 `formSlug`。
 * @returns 该 form 的 `Field[]`，或 `null`（不存在）。
 */
export async function getFormFields(db: D1Database, slug: string): Promise<Field[] | null> {
  const row = await db
    .prepare(`SELECT schema_json FROM forms WHERE slug = ?`)
    .bind(slug)
    .first<{ schema_json: string }>();
  if (row === null) {
    return null;
  }
  return JSON.parse(row.schema_json) as Field[];
}

// ---------------------------------------------------------------------------
// §21：表单管理 CRUD（owner-only：列表 / 改状态 / 删除）（实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * `GET /api/forms` 列表里的一项（§21.2）。**只**给概览：`slug` / `meta` / `status` /
 * `createdAt`，**不**含 `fields` 全量（详情走 `GET /api/forms/:slug` / PATCH 回显）。
 *
 * 这是 owner-only 视图，故**可以**带 owner 私有维度 `status` / `createdAt`；但**绝不**含
 * 任何 owner 凭据（凭据在 `owner_config`，不在 `forms` 表，§21.2）。`submissionCount` 为
 * 可选——算它要打一次飞书，MVP 可省略（§21.2）。
 */
export interface FormListItem {
  /** 公开 slug，同时是 owner 管理 / 编辑 / 删除的定位键。 */
  slug: string;
  meta: FormMeta;
  /** 当前状态（`published` / `draft` / `closed`）。 */
  status: FormStatus;
  /** 发布时刻（ISO-8601），来自 forms.created_at。 */
  createdAt: string;
  /** 可选：该表单已收集的提交条数（需打飞书才能算，MVP 可省略，§21.2）。 */
  submissionCount?: number;
}

/**
 * `GET /api/forms` 的成功响应（§21.2）：该 owner 的所有表单 + 条数。空 → `forms: []`。
 */
export interface FormListResult {
  forms: FormListItem[];
  count: number;
}

/**
 * `PATCH /api/forms/:slug` 的请求体（§21.3）——**部分更新**，所有字段可选。
 *
 * - `status`：只接受 `'published'` / `'closed'`（**不**允许 PATCH 成 `'draft'`，§21.3）。
 * - `meta` / `fields`：若给则整块替换（编辑为合约内增强；给 `fields` 时须过 §16 的
 *   `parseField` 形状校验 + §16.2 深度上限）。
 * - 未出现的键保持原值；空体 `{}` 为 no-op（仍 `200`）。
 */
export interface UpdateFormInput {
  /** 改状态：`published`（开放提交）↔ `closed`（停止收集）。 */
  status?: Extract<FormStatus, "published" | "closed">;
  /** 可选：整块替换展示 meta。 */
  meta?: FormMeta;
  /** 可选：整块替换字段定义（须过 parseField 形状校验 + 深度上限）。 */
  fields?: Field[];
}

/**
 * `PATCH /api/forms/:slug` 成功回的更新后视图（§21.3）。让 owner 确认改动已生效——
 * 至少含 `slug` + `status`，建议带上 `meta` / `fields` / `createdAt` 的 owner 视图。
 * 仍**不**含任何 owner 凭据。
 */
export interface UpdatedForm {
  slug: string;
  meta: FormMeta;
  fields: Field[];
  status: FormStatus;
  createdAt: string;
}

/**
 * `DELETE /api/forms/:slug` 的成功响应（§21.4）。MVP 硬删 → `{ ok:true, slug }`
 * （或实现选 `204`；本类型对应 `200 { ok }` 形状）。
 */
export interface DeleteFormResult {
  ok: true;
  slug: string;
}

/**
 * 列出某 owner 的所有表单（§21.2）——owner-only。
 *
 * - MVP 单 owner：`owner_id` 恒 `'default'`（{@link DEFAULT_OWNER_ID}），列表即该 owner 全部。
 * - 只投影 `slug` / `meta_json` / `status` / `created_at`，组装成 {@link FormListItem}[]；
 *   **不**读 `schema_json` 全量（列表不带 fields），更不碰 owner_config（§21.2）。
 * - 排序（按 created_at 倒序 / 不约定）由实现定。空 → `[]`。
 *
 * @param db D1 binding。
 * @param ownerId owner 维度键（MVP 恒 'default'，可由实现默认填）。
 * @returns 该 owner 的表单概览数组（route 据此组 `{ forms, count }`）。
 */
export async function listForms(
  db: D1Database,
  ownerId: string = DEFAULT_OWNER_ID,
): Promise<FormListItem[]> {
  // 只投影列表字段：slug / meta_json / status / created_at。绝不 SELECT schema_json
  // （列表不带 fields 全量），更不碰 owner_config —— 凭据 / owner_id 永不进列表（§21.2）。
  const { results } = await db
    .prepare(
      `SELECT slug, meta_json, status, created_at FROM forms WHERE owner_id = ? ORDER BY created_at DESC`,
    )
    .bind(ownerId)
    .all<{ slug: string; meta_json: string; status: string; created_at: string }>();

  return (results ?? []).map((row) => ({
    slug: row.slug,
    meta: JSON.parse(row.meta_json) as FormMeta,
    status: row.status as FormStatus,
    createdAt: row.created_at,
  }));
}

/**
 * 部分更新一份表单（§21.3）——owner-only。
 *
 * - 只更新 `input` 里出现的键（`status` / `meta` / `fields`），未出现的保持原值；空 `input`
 *   为 no-op。`status` 只允许 `published` / `closed`（非法值由 route 在解析时挡成 400）。
 * - 命中并更新成功：返回更新后的 {@link UpdatedForm}。
 * - slug 不存在：返回 `null`（route → `404 { error }`）。
 *
 * @param db D1 binding。
 * @param slug 目标表单 slug。
 * @param input 部分更新输入（已由 route 形状校验）。
 * @returns 更新后的视图，或 `null`（不存在）。
 */
export async function updateForm(
  db: D1Database,
  slug: string,
  input: UpdateFormInput,
): Promise<UpdatedForm | null> {
  // 只更新 input 里出现的键；未出现的保持原值。空 input → 跳过 UPDATE（no-op），直接读回。
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (input.status !== undefined) {
    sets.push("status = ?");
    binds.push(input.status);
  }
  if (input.meta !== undefined) {
    sets.push("meta_json = ?");
    binds.push(JSON.stringify(input.meta));
  }
  if (input.fields !== undefined) {
    sets.push("schema_json = ?");
    binds.push(JSON.stringify(input.fields));
  }

  if (sets.length > 0) {
    const result = await db
      .prepare(`UPDATE forms SET ${sets.join(", ")} WHERE slug = ?`)
      .bind(...binds, slug)
      .run();
    // 无行被更新 → slug 不存在 → null（route → 404）。
    if (result.meta.changes === 0) {
      return null;
    }
  }

  // 读回更新后的 owner 视图（含 fields / status / createdAt）。空 input 的 no-op 也走这里，
  // 若 slug 不存在则读不到 → null。绝不读 / 回 owner_config 或任何凭据。
  const row = await db
    .prepare(`SELECT meta_json, schema_json, status, created_at FROM forms WHERE slug = ?`)
    .bind(slug)
    .first<{ meta_json: string; schema_json: string; status: string; created_at: string }>();
  if (row === null) {
    return null;
  }

  return {
    slug,
    meta: JSON.parse(row.meta_json) as FormMeta,
    fields: JSON.parse(row.schema_json) as Field[],
    status: row.status as FormStatus,
    createdAt: row.created_at,
  };
}

/**
 * 校验 + 规整 `PATCH /api/forms/:slug` 的 JSON body 成 {@link UpdateFormInput}（§21.3）。
 *
 * - 顶层须是普通对象；空对象 `{}` 合法（no-op 更新）。
 * - `status` 若给：须是 `'published'` / `'closed'`（**拒绝** `'draft'` 与其它值 → 抛
 *   {@link FormValidationError} → route `400`）。
 * - `meta` 若给：复用 §16 的 meta 形状约定（title 非空）。
 * - `fields` 若给：复用 §16 的 `parseField` 形状校验（含 §16.2 深度上限）。
 *
 * @throws {@link FormValidationError} when 形状 / status 非法（route → 400）。
 */
export function parseUpdateInput(body: unknown): UpdateFormInput {
  // 顶层须是普通对象（数组 / null / 标量都拒绝）。空对象 {} 合法 → no-op 更新。
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new FormValidationError("body must be a JSON object");
  }

  const { status, meta, fields } = body as {
    status?: unknown;
    meta?: unknown;
    fields?: unknown;
  };

  const input: UpdateFormInput = {};

  // status：只接受 'published' / 'closed'（拒绝 'draft' 与任意乱值，§21.3）。
  if (status !== undefined) {
    if (status !== "published" && status !== "closed") {
      throw new FormValidationError(
        `status must be 'published' or 'closed', got: ${String(status)}`,
      );
    }
    input.status = status;
  }

  // meta：若给则复用 §16 的 meta 形状约定（对象 + title 非空，description 可选字符串）。
  if (meta !== undefined) {
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
      throw new FormValidationError("meta must be an object");
    }
    const { title, description } = meta as { title?: unknown; description?: unknown };
    if (!isNonEmptyString(title)) {
      throw new FormValidationError("meta.title is required");
    }
    if (description !== undefined && typeof description !== "string") {
      throw new FormValidationError("meta.description must be a string");
    }
    const parsedMeta: FormMeta = { title };
    if (description !== undefined) {
      parsedMeta.description = description;
    }
    input.meta = parsedMeta;
  }

  // fields：若给则复用 §16 的 parseField 形状校验（含 §16.2 深度上限，从 depth 0 起算）。
  if (fields !== undefined) {
    if (!Array.isArray(fields)) {
      throw new FormValidationError("fields must be an array");
    }
    input.fields = fields.map((field) => parseField(field));
  }

  return input;
}

/**
 * 硬删一份表单（§21.4）——owner-only。从 `forms` 表删掉该 slug 行；删后公开拉取 / submit
 * 该 slug 都变 404。**不**联动删 owner 飞书表里已收集的记录（§21.4）。
 *
 * - 命中并删除：返回 `true`。
 * - slug 不存在：返回 `false`（route → `404 { error }`，MVP 取严格语义，§21.4）。
 *
 * @param db D1 binding。
 * @param slug 目标表单 slug。
 * @returns 是否删除了一行。
 */
export async function deleteForm(db: D1Database, slug: string): Promise<boolean> {
  // 硬删（§21.4）：从 forms 表删掉该 slug 行。不联动删 owner 飞书表里已收集的记录。
  const result = await db.prepare(`DELETE FROM forms WHERE slug = ?`).bind(slug).run();
  // 删了一行 → true；slug 不存在（0 行受影响）→ false（route → 404，严格语义）。
  return result.meta.changes > 0;
}
