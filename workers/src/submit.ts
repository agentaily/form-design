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

/** Feishu Bitable add-record endpoint template. SPEC.md §15.5. Fill {app_token}/{table_id}. */
export const FEISHU_BITABLE_RECORDS_URL =
  "https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records";

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
 * - Does NOT validate answers against the form's schema (required-field /
 *   label-exists / 字段级一致性 checks are out of this slice — only shape-level
 *   validation). See SPEC.md §15.2、§16.5.
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
 * - Non-2xx or `code !== 0` → throws {@link BitableWriteError} (the route maps it
 *   to `502 { error }`). The thrown message MUST NEVER contain `token`. See §15.7.
 *
 * @param token the tenant_access_token from getFeishuTenantToken (feishu.ts).
 * @param appToken owner's Bitable app token (from getOwnerConfig).
 * @param tableId owner's Bitable table id (from getOwnerConfig).
 * @param fields the column→value map from {@link answersToFields}.
 * @returns `{ recordId }` on success.
 * @throws {@link BitableWriteError} when the write fails.
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
  throw new BitableWriteError(`飞书新增记录失败：code ${body.code}`);
}
