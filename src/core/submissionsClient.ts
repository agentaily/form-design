// submissionsClient.ts — owner-side seam for the 数据后台 (第 6 步).
// Backend contract: GET /api/forms/:slug/submissions (owner-only, SPEC §18) — read
// back the submissions a published form has collected.
//
// ★ D1 主存版本 (PR-2 / #56)：提交的主存从 owner 的飞书多维表格翻转到 **D1**。本读端现在直接
//   从 D1 投影提交（不再读飞书），所以响应 shape 也随后端翻成 D1 形状：每条提交是
//   `{ id, answers, createdAt, feishu }`（不再是旧飞书的 `{ recordId, fields, createdTime }`）。
//   `answers` 是 submit 时原样落库的作答数组（label → value，与 publicClient 提交对称）；
//   `feishu` 是 best-effort 同步回执（未配 / 未同步 → 三者皆 null）。读 D1 不打飞书，故
//   **不再有** 409 未配飞书 / 502 上游错误——只剩 401（未登录）/ 404（slug 不存在或非本人）。
//
// OWNER-ONLY — carries `auth: true` (the OPPOSITE of publicClient). A missing /
// expired session surfaces as a 401 ApiError for the caller (SubmissionsContent) to
// route into the login flow (same onNeedLogin pattern as formsClient/configClient,
// §17.4). The response carries NO owner credentials and NO app_token/table_id (§18.6).
//
// (Kept as its own module rather than folded into formsClient to keep the data-read
//  concern separate from publish/管理 CRUD; both are owner-only over apiFetch.)

import { apiFetch } from "./apiClient";

/** One answer in a submission (§15.2)：`label` 是字段标签，`value` 单值 string、多选 / 多值
 *  string[]——与 submit 时 publicClient 发出的 Answer 对称（原样落 D1 的 answers_json）。 */
export interface SubmissionAnswer {
  label: string;
  value: string | string[];
}

/** 一条提交的飞书 best-effort 同步回执（§15，D1 主存版本）。未配飞书 / 尚未同步 → 三者皆 null；
 *  同步成功 → recordId + syncedAt 有值、error 为 null；同步失败 → 仅 error 有值（非敏感摘要）。 */
export interface SubmissionFeishuSync {
  recordId: string | null;
  syncedAt: string | null;
  error: string | null;
}

/** One collected submission (SPEC §18.2, **D1 主存投影**)。从 D1 `submissions` 行映射而来：
 *  `id` 是提交主键（稳定 UUID），`answers` 是原样落库的作答数组，`createdAt` 是落库时刻
 *  ISO-8601 字符串，`feishu` 是同步回执。携带 NO owner credentials / app_token / table_id。 */
export interface Submission {
  id: string;
  answers: SubmissionAnswer[];
  createdAt: string;
  feishu: SubmissionFeishuSync;
}

/** Result of GET /api/forms/:slug/submissions (SPEC §18.2): the submissions list +
 *  its count (MVP: count === submissions.length; no pagination, §18.4). An empty
 *  form yields `{ submissions: [], count: 0 }` — a normal empty state, not an error. */
export interface SubmissionsResult {
  submissions: Submission[];
  count: number;
}

/**
 * List the submissions a form has collected (SPEC §18, owner-only §17, **D1 主存**). Resolves
 * the {@link SubmissionsResult}; an empty form resolves to `{ submissions: [], count: 0 }`.
 * Error surfaces (all as ApiError carrying status + backend `{ error }`):
 *   - 401 → no/expired owner session → caller routes into login (onNeedLogin)
 *   - 404 → unknown slug（或 slug 存在但不属当前 owner——同一 404，不泄漏存在性）
 * （读 D1 不依赖飞书：**不再**返回 409 未配飞书 / 502 上游错误。）
 * See features/data-dashboard.feature.
 */
export function listSubmissions(slug: string): Promise<SubmissionsResult> {
  return apiFetch<SubmissionsResult>(`/api/forms/${encodeURIComponent(slug)}/submissions`, {
    auth: true,
  });
}
