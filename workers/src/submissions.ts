// submissions.ts — the D1 submissions store: the primary home of every answer set.
// See SPEC.md §15（提交落 D1 主存）+ §18（数据后台读 D1）.
//
// 架构转向（PR-2）：提交数据的**主存**从 owner 的飞书多维表格翻转到 **D1**。本模块拥有
// `submissions` 表（migrations/0005_submissions.sql）——写入、读回、以及飞书 best-effort
// 同步的回执回填都在这里收口：
//   - insertSubmission：POST /api/submit 校验门通过后写入一条提交（**主存，必成**，§15）。
//   - listSubmissions：数据后台 GET /api/forms/:slug/submissions 按 (owner_id, form_slug)
//     从 D1 读回（取代旧的「飞书 GET 记录列表」，§18）。owner 隔离照旧。
//   - recordFeishuSync / recordFeishuSyncError：把 best-effort 同步飞书的结果回填进同一行的
//     回执列（成功 → record_id + synced_at；失败 → 仅非敏感 error 摘要，§15）。
//
// 飞书自此降为**可选外部同步出口**：未配飞书照常落 D1、不同步；配了飞书才在 waitUntil 后台
// 同步（编排在 index.ts 的 submit 路由 + syncSubmissionToFeishu helper，best-effort）。本模块
// 不碰飞书上游、不持有任何 owner 凭据——只读写 D1 的提交数据本身（§18.6）。
//
// Layering: 这几个函数都是 inner-loop 可单测的 D1 seam（用 miniflare D1 直驱），route 在其上
// 编排，由 outer-loop 通过 SELF.fetch 驱动（submissions-api / submissions-storage-api 套件）。

import type { SubmitAnswer } from "./submit";

/**
 * 写入一条提交所需的字段（§15）。`answers` 会被序列化进 `answers_json`；飞书同步回执列
 * （feishu_*）初始为 NULL——同步成功 / 失败后由 {@link recordFeishuSync} /
 * {@link recordFeishuSyncError} 回填。
 */
export interface InsertSubmissionInput {
  /** 稳定主键（crypto.randomUUID()）。 */
  id: string;
  /** 关联的已发布表单 slug（forms.slug）。 */
  formSlug: string;
  /** form 所属 owner 的真实 user id（隔离键，由 getFormOwner 反查，§16.5 / §17.9 第 5 条）。 */
  ownerId: string;
  /** 一份作答（§15.2 的 SubmitAnswer[]，原样序列化进 answers_json）。 */
  answers: SubmitAnswer[];
  /** 落库时刻 ISO-8601。 */
  createdAt: string;
}

/**
 * 数据后台对外投影的一条提交（§18.2，D1 主存版本）。从 `submissions` 行映射而来：
 * `answers` ← `answers_json`（反序列化回 SubmitAnswer[]），`createdAt` ← `created_at`，
 * `feishu` 三字段 ← 同步回执列（未同步 / 未配飞书 → 均为 null）。
 *
 * **只**含提交数据本身 + 飞书同步状态，**绝不**含任何 owner 凭据、`owner_id`、或
 * `app_token` / `table_id`（§18.6）——这些要么不在本表，要么不投影。
 */
export interface Submission {
  /** 提交主键（submissions.id）。 */
  id: string;
  /** 这份作答（从 answers_json 反序列化）。 */
  answers: SubmitAnswer[];
  /** 落库时刻 ISO-8601。 */
  createdAt: string;
  /**
   * 飞书 best-effort 同步状态（§15）。未配飞书 / 尚未同步 → 三者皆 null；同步成功 →
   * recordId + syncedAt 有值、error 为 null；同步失败 → 仅 error 有值（非敏感摘要，绝不含凭据）。
   */
  feishu: {
    recordId: string | null;
    syncedAt: string | null;
    error: string | null;
  };
}

/**
 * `GET /api/forms/:slug/submissions` 的成功响应（§18.2）。
 *
 * - `submissions`：D1 里该 (owner_id, form_slug) 的提交，映射成 {@link Submission}[]；空 → `[]`（正常态）。
 * - `count`：`submissions.length`（本期不分页，等于这一批的条数）。
 *
 * 响应里**绝不**含 owner 凭据、`tenant_access_token`、或 `owner_id`（§18.6）。
 */
export interface SubmissionsResult {
  submissions: Submission[];
  count: number;
}

/** `submissions` 行的原始形状（D1 SELECT 出来的列）。 */
interface SubmissionRow {
  id: string;
  answers_json: string;
  created_at: string;
  feishu_record_id: string | null;
  feishu_synced_at: string | null;
  feishu_sync_error: string | null;
}

/**
 * 写入一条提交到 D1 主存（§15）。POST /api/submit 在校验门（form 存在 + 状态开放 + 必填）
 * 全过之后调用——这是提交的**主存写入，必须成功**（失败 → route 返回 5xx，提交未落库）。
 * 飞书同步回执列初始为 NULL，待 best-effort 同步后由 {@link recordFeishuSync} /
 * {@link recordFeishuSyncError} 回填。
 *
 * @param db D1 binding。
 * @param input 见 {@link InsertSubmissionInput}。
 */
export async function insertSubmission(
  db: D1Database,
  input: InsertSubmissionInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO submissions (id, form_slug, owner_id, answers_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.id, input.formSlug, input.ownerId, JSON.stringify(input.answers), input.createdAt)
    .run();
}

/**
 * 读回某 owner 某表单的提交列表（§18，D1 主存版本）。按 `(owner_id, form_slug)` 过滤
 * （owner 隔离照旧——A 永远读不到 B 的提交，§17.9）+ 复合索引覆盖，按 `created_at` 倒序
 * （最新在前）、`rowid` 倒序为稳定 tiebreak（同毫秒落库时仍确定有序）。
 *
 * 每行映射成 {@link Submission}：`answers_json` 反序列化回 SubmitAnswer[]（脏 / 不可解析 →
 * 退化为空数组，绝不抛——读列表不该因单条脏数据整体失败），飞书回执列映射进 `feishu`。
 *
 * @param db D1 binding。
 * @param ownerId 当前登录 owner 的真实 user id（隔离键，route 从 c.get('session').sub 取）。
 * @param formSlug 目标表单 slug。
 * @returns 映射后的提交数组（route 据此组 `{ submissions, count }`）。
 */
export async function listSubmissions(
  db: D1Database,
  ownerId: string,
  formSlug: string,
): Promise<Submission[]> {
  const { results } = await db
    .prepare(
      `SELECT id, answers_json, created_at, feishu_record_id, feishu_synced_at, feishu_sync_error
       FROM submissions
       WHERE owner_id = ? AND form_slug = ?
       ORDER BY created_at DESC, rowid DESC`,
    )
    .bind(ownerId, formSlug)
    .all<SubmissionRow>();

  return (results ?? []).map((row) => ({
    id: row.id,
    answers: parseAnswers(row.answers_json),
    createdAt: row.created_at,
    feishu: {
      recordId: row.feishu_record_id,
      syncedAt: row.feishu_synced_at,
      error: row.feishu_sync_error,
    },
  }));
}

/**
 * 回填飞书 best-effort 同步**成功**的回执（§15）：写入 `feishu_record_id` + `feishu_synced_at`，
 * 并清空 `feishu_sync_error`（先前若失败过、这次成功则覆盖掉旧错误）。按主键 `id` 定位。
 *
 * @param db D1 binding。
 * @param submissionId 提交主键（insertSubmission 写入的 id）。
 * @param recordId 飞书新增记录返回的 record_id。
 * @param syncedAt 同步成功时刻 ISO-8601。
 */
export async function recordFeishuSync(
  db: D1Database,
  submissionId: string,
  recordId: string,
  syncedAt: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE submissions
       SET feishu_record_id = ?, feishu_synced_at = ?, feishu_sync_error = NULL
       WHERE id = ?`,
    )
    .bind(recordId, syncedAt, submissionId)
    .run();
}

/**
 * 记录飞书 best-effort 同步**失败**（§15）：只写 `feishu_sync_error`（一段**非敏感**摘要，
 * 通常是错误名，**绝不**含 tenant_access_token / app_secret，§15.7）。不动 record_id / synced_at
 * （它们仍为 NULL，标识「未成功同步」）。同步失败绝不影响提交本身——主存那行早已写入。
 *
 * @param db D1 binding。
 * @param submissionId 提交主键。
 * @param error 非敏感错误摘要（如 err.name）。
 */
export async function recordFeishuSyncError(
  db: D1Database,
  submissionId: string,
  error: string,
): Promise<void> {
  await db
    .prepare(`UPDATE submissions SET feishu_sync_error = ? WHERE id = ?`)
    .bind(error, submissionId)
    .run();
}

/** 反序列化 answers_json 回 SubmitAnswer[]；不可解析 / 非数组 → 空数组（读列表不因脏数据整体失败）。 */
function parseAnswers(json: string): SubmitAnswer[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as SubmitAnswer[]) : [];
  } catch {
    return [];
  }
}
