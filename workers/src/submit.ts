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
 * missing column as text (`type 1`); precise per-field-type mapping is後续 (§15.8 末). SPEC.md §15.8. */
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
 * value. Produced by {@link answersToFields}; sent as `{ fields }` in the
 * add-record request body. Values are passed through untouched (no structured
 * type conversion in this slice). See SPEC.md §15.3.
 */
export type BitableFields = Record<string, string | string[]>;

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
 * as-is). No structured type conversion in this slice. See SPEC.md §15.3.
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
 * Back-fill the Bitable columns named in `fieldNames` that don't yet exist in the target
 * table, as plain text columns. Called ONLY by the §15.8 self-heal branch, after a write
 * returned {@link FEISHU_CODE_FIELD_NOT_FOUND} — never on the steady-state happy path.
 *
 * Contract (§15.8):
 * - List existing columns: `GET` {@link FEISHU_BITABLE_FIELDS_URL} (with `{app_token}` /
 *   `{table_id}` filled and `?page_size=` {@link FEISHU_FIELDS_LIST_PAGE_SIZE}),
 *   `Authorization: Bearer <token>`, no body. Success requires upstream `2xx` AND body
 *   `code === 0`; the existing column-name set is `data.items[].field_name`.
 * - For each name in `fieldNames` NOT in that set, `POST` {@link FEISHU_BITABLE_FIELDS_URL}
 *   with body `{ field_name, type: ` {@link FEISHU_FIELD_TYPE_TEXT} ` }`. Success requires
 *   `2xx` AND `code === 0`. A `code === ` {@link FEISHU_CODE_FIELD_DUPLICATED} (`1254014`
 *   `FieldNameDuplicated`, a concurrent first submit just created it) is treated as
 *   idempotent SUCCESS, not a failure (§15.8 幂等与并发).
 * - Any other列出/建列 failure (非 2xx, `code !== 0` 且非 `1254014`, unparseable body,
 *   unreachable upstream) → throw {@link BitableWriteError}; the route maps it to
 *   `502 { error }` (§15.6). The thrown `message` MUST NEVER contain the `token` or any owner
 *   credential — only a non-sensitive upstream `code` / HTTP status hint (§15.7).
 * - `fieldNames` is the truth = `Object.keys(fields)` of the current write (§15.8): only the
 *   columns this submit needs are ensured, not the whole form schema. Columns already present
 *   are left untouched; an empty / fully-present `fieldNames` makes no create calls.
 *
 * @param token the tenant_access_token; rides ONLY the `Authorization` header (§15.7).
 * @param appToken owner's Bitable app token (from getOwnerConfig).
 * @param tableId owner's Bitable table id (from getOwnerConfig).
 * @param fieldNames the column names the current write needs — `Object.keys(fields)`.
 * @returns resolves once every name in `fieldNames` exists as a column.
 * @throws {@link BitableWriteError} when listing or creating a column fails (非 `1254014`).
 */
export async function ensureBitableFields(
  token: string,
  appToken: string,
  tableId: string,
  fieldNames: string[],
): Promise<void> {
  // Nothing to ensure → no upstream traffic (an empty fieldNames lists/creates nothing).
  if (fieldNames.length === 0) {
    return;
  }

  const fieldsUrl = FEISHU_BITABLE_FIELDS_URL.replace("{app_token}", appToken).replace(
    "{table_id}",
    tableId,
  );

  // 1) List existing columns: GET .../fields?page_size=100. The token rides ONLY
  //    the Authorization header (§15.7); failures fold no caught error into the
  //    message (it may embed the header), just a credential-free hint.
  const listUrl = `${fieldsUrl}?page_size=${FEISHU_FIELDS_LIST_PAGE_SIZE}`;
  let listRes: Response;
  try {
    listRes = await fetch(listUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new BitableWriteError("飞书列出字段失败：上游不可达");
  }

  let listBody: { code?: number; data?: { items?: Array<{ field_name?: string }> } };
  try {
    listBody = (await listRes.json()) as typeof listBody;
  } catch {
    throw new BitableWriteError(`飞书列出字段失败：上游返回 ${listRes.status}`);
  }

  // Double gate: 2xx AND body code === 0 (飞书 200 也可能带非 0 业务码, §15.8).
  if (!listRes.ok || listBody.code !== FEISHU_OK_CODE) {
    throw new BitableWriteError(`飞书列出字段失败：code ${listBody.code}`);
  }

  const existing = new Set<string>();
  for (const item of listBody.data?.items ?? []) {
    if (typeof item.field_name === "string") {
      existing.add(item.field_name);
    }
  }

  // 2) For each name NOT already present, POST .../fields { field_name, type: 1 }.
  //    Columns already present are left untouched (§15.8 只建缺失列).
  for (const fieldName of fieldNames) {
    if (existing.has(fieldName)) {
      continue;
    }

    let createRes: Response;
    try {
      createRes = await fetch(fieldsUrl, {
        method: "POST",
        headers: {
          // The tenant_access_token's ONLY destination here (§15.7).
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ field_name: fieldName, type: FEISHU_FIELD_TYPE_TEXT }),
      });
    } catch {
      throw new BitableWriteError("飞书新建字段失败：上游不可达");
    }

    let createBody: { code?: number };
    try {
      createBody = (await createRes.json()) as { code?: number };
    } catch {
      throw new BitableWriteError(`飞书新建字段失败：上游返回 ${createRes.status}`);
    }

    // code 1254014 (FieldNameDuplicated) is idempotent SUCCESS — a concurrent first
    // submit may have just created it (§15.8 幂等与并发). Otherwise require 2xx AND
    // code === 0; any other failure is terminal (message carries only the code, §15.7).
    if (createBody.code === FEISHU_CODE_FIELD_DUPLICATED) {
      continue;
    }
    if (!createRes.ok || createBody.code !== FEISHU_OK_CODE) {
      throw new BitableWriteError(`飞书新建字段失败：code ${createBody.code}`);
    }
  }
}

/**
 * Write one record into the owner's Bitable, self-healing missing columns once (§15.8).
 *
 * This is the §15.8 orchestrator that the submit route calls instead of {@link writeToBitable}
 * directly:
 * 1. `writeToBitable(token, appToken, tableId, fields)`. Success → return `{ recordId }`
 *    with NO field-endpoint traffic (稳态零开销，反应式非预检).
 * 2. If it throws {@link BitableFieldMissingError} (`code 1254045`, 列不存在；the failed write
 *    made no record so the retry is side-effect-safe) → `ensureBitableFields(token, appToken,
 *    tableId, Object.keys(fields))` to back-fill the missing columns, then `writeToBitable`
 *    again — exactly ONCE.
 * 3. The single retry's outcome is final: success → `{ recordId }`; if it still throws (still
 *    `1254045`, or any other {@link BitableWriteError}) the error propagates and the route maps
 *    it to `502` (§15.6). NO further retry loop — self-heal back-fills missing columns once,
 *    it is not an unbounded loop (§15.8.3).
 *
 * Other errors from the FIRST write (a plain {@link BitableWriteError} that is NOT a
 * {@link BitableFieldMissingError}) are NOT self-heal candidates and propagate unchanged.
 * `ensureBitableFields` failures (建列/列出失败) likewise propagate as {@link BitableWriteError}.
 * No message here ever carries the `token` or any owner credential (§15.7).
 *
 * @param token the tenant_access_token from getFeishuTenantToken (feishu.ts).
 * @param appToken owner's Bitable app token (from getOwnerConfig).
 * @param tableId owner's Bitable table id (from getOwnerConfig).
 * @param fields the column→value map from {@link answersToFields}.
 * @returns `{ recordId }` on first-try success or after the single self-heal retry.
 * @throws {@link BitableWriteError} when the write fails terminally (含自愈后重试仍失败) or a
 *   self-heal列出/建列 step fails.
 */
export async function writeRecordWithFieldEnsure(
  token: string,
  appToken: string,
  tableId: string,
  fields: BitableFields,
): Promise<{ recordId: string }> {
  try {
    // 1) Steady-state happy path: target columns exist → success with NO field
    //    endpoint traffic (反应式非预检, 稳态零开销).
    return await writeToBitable(token, appToken, tableId, fields);
  } catch (err) {
    // Only a missing-column failure is a self-heal candidate; the failed write
    // made no record so the retry is side-effect-safe (§15.8). Any other
    // BitableWriteError (or non-Bitable error) propagates unchanged.
    if (!(err instanceof BitableFieldMissingError)) {
      throw err;
    }
    // 2) Back-fill exactly the columns this write needs, then retry the write
    //    ONCE. The retry's outcome is final — no further loop (§15.8.3): success
    //    returns; a still-failing retry (1254045 or any BitableWriteError) is
    //    rethrown for the route's BitableWriteError → 502 branch.
    await ensureBitableFields(token, appToken, tableId, Object.keys(fields));
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
