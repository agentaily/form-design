// submissionsClient.ts — owner-side seam for the 数据后台 (第 6 步).
// Backend contract: GET /api/forms/:slug/submissions (owner-only, SPEC §18) — read
// back the submissions a published form has collected (from the owner's 飞书
// 多维表格). One call behind apiClient's Bearer injection (§17).
//
// OWNER-ONLY — carries `auth: true` (the OPPOSITE of publicClient). A missing /
// expired session surfaces as a 401 ApiError for the caller (SubmissionsView) to
// route into the login flow (same onNeedLogin pattern as formsClient/configClient,
// §17.4). The response carries NO owner credentials and NO app_token/table_id (§18.6).
//
// (Kept as its own module rather than folded into formsClient to keep the data-read
//  concern separate from publish/管理 CRUD; both are owner-only over apiFetch.)

import { apiFetch } from "./apiClient";

/** One collected submission (SPEC §18.2). `fields` is the 飞书 record's fields,
 *  projected as-is (column label → value; value is a string or, for multi-value
 *  columns, a string array — symmetric with the Answer value sent at submit time).
 *  `createdTime` is an optional epoch-millis timestamp (omitted when upstream lacks
 *  it). Carries no owner credentials. */
export interface Submission {
  recordId: string;
  fields: Record<string, string | string[]>;
  createdTime?: number;
}

/** Result of GET /api/forms/:slug/submissions (SPEC §18.2): the submissions list +
 *  its count (MVP: count === submissions.length; no pagination, §18.4). An empty
 *  form yields `{ submissions: [], count: 0 }` — a normal empty state, not an error. */
export interface SubmissionsResult {
  submissions: Submission[];
  count: number;
}

/**
 * List the submissions a form has collected (SPEC §18, owner-only §17). Resolves the
 * {@link SubmissionsResult}; an empty form resolves to `{ submissions: [], count: 0 }`.
 * Error surfaces (all as ApiError carrying status + backend `{ error }`):
 *   - 401 → no/expired owner session → caller routes into login (onNeedLogin)
 *   - 404 → unknown slug
 *   - 409 → owner 未配飞书 (引导去集成设置, §18.5)
 *   - 502 → 上游(飞书)出错
 * Stub — see features/data-dashboard.feature.
 */
export function listSubmissions(slug: string): Promise<SubmissionsResult> {
  return apiFetch<SubmissionsResult>(`/api/forms/${encodeURIComponent(slug)}/submissions`, {
    auth: true,
  });
}
