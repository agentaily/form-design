// chatSessions.ts — D1 data layer for 设计对话持久化 (SPEC §26).
//
// owner 登录后（§17，owner-only），设计器把一段设计对话随聊天 PUT 上来、刷新 / 换设备时
// GET 回来。会话按 (owner_id, session_id) 隔离（复合主键，§26.7）：owner_id 取自 session
// JWT 的 sub，session_id 是客户端生成的稳定 design session id（§26.2）。
//
// 持久化两份转写（§26.6）：turns_json = 序列化的 UI 回合（PersistedTurn[]，给人看，含 tool
// 卡 / 思考块），history_json = 序列化的 LLM 历史（OpenAI ChatMessage[]，给模型看，含起首
// system）。表只存对话转写 + 关联 slug，绝不存任何 owner 凭据（DeepSeek key / 飞书 secret 在
// owner_config，§12）。
//
// Layering: loadChatSession / upsertChatSession 是 inner-loop unit-test target 与
// outer-loop seam——route（index.ts）在其上编排（鉴权门 + ownerId 注入 + 400 校验）。

/**
 * 一段持久化的设计对话（§26.6）对外投影。turns / history 是 JSON-parse 后的两份转写，
 * formSlug 是发布后关联的 slug（未发布为 null），时间戳为 ISO-8601。绝不含 owner_id /
 * 任何凭据（§26.8）。
 */
export interface ChatSessionRecord {
  sessionId: string;
  turns: unknown[];
  history: unknown[];
  formSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `PUT /api/chat/session/:sessionId` 的入参（§26.3）：整段替换的快照。 */
export interface ChatSessionUpsertInput {
  turns: unknown[];
  history: unknown[];
  /** 可选：发布后关联该会话到此 slug（§26.2）；缺省时不清空已存的 form_slug（§26.3）。 */
  formSlug?: string | null;
}

/** D1 行形状（按需投影）。 */
interface ChatSessionRow {
  turns_json: string;
  history_json: string;
  form_slug: string | null;
  created_at: string;
  updated_at: string;
}

/** 防御性 JSON.parse：库里存的本就是数组的序列化，损坏 / 空时回 []，不让一次读崩掉恢复。 */
function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 按 (owner_id, session_id) 读回一段已持久化的设计对话（§26.3 GET）。
 *
 * - 命中：把行里的 turns_json / history_json 反序列化，连同 form_slug + 时间戳组装成
 *   {@link ChatSessionRecord}。
 * - 该 owner 从未持久化过这个 session_id（含「A 猜 B 的 id」越权读）：返回 `null`
 *   （route → `{ session: null }`，正常空态，非 404，§26.8）。
 *
 * 隔离靠 WHERE owner_id=? AND session_id=?（复合主键，§26.8）——绝不暴露别的 owner 的对话。
 *
 * @param db D1 binding。
 * @param ownerId 当前登录 owner 的真实 user id（session JWT 的 sub，§17.5）。
 * @param sessionId 客户端生成的稳定 design session id（§26.2）。
 * @returns 命中时 {@link ChatSessionRecord}，未命中 / 越权时 `null`。
 */
export async function loadChatSession(
  db: D1Database,
  ownerId: string,
  sessionId: string,
): Promise<ChatSessionRecord | null> {
  const row = await db
    .prepare(
      `SELECT turns_json, history_json, form_slug, created_at, updated_at
       FROM chat_sessions WHERE owner_id = ? AND session_id = ?`,
    )
    .bind(ownerId, sessionId)
    .first<ChatSessionRow>();

  if (row === null) return null;

  return {
    sessionId,
    turns: parseJsonArray(row.turns_json),
    history: parseJsonArray(row.history_json),
    formSlug: row.form_slug ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 整段 upsert 一段设计对话（§26.3 PUT，last-write-wins）。按 (owner_id, session_id) 已存在则
 * 更新、不存在则插入；turns_json / history_json 整列覆盖，updated_at 刷新（§26.3/§26.4）。
 *
 * - **created_at 语义：** 首次插入时落当前时刻；后续更新**保留**原 created_at（用
 *   `ON CONFLICT ... DO UPDATE` 时不动 created_at 列）。
 * - **form_slug 语义（§26.3）：** 仅在入参显式带 `formSlug` 时更新；缺省时**不清空**已存的
 *   form_slug（避免一次普通对话写入把已关联的 slug 抹掉）。靠 COALESCE(excluded, 原值) 实现。
 *
 * @returns 写入后的 `{ sessionId, updatedAt }`（route → `200`，§26.3）。
 */
export async function upsertChatSession(
  db: D1Database,
  ownerId: string,
  sessionId: string,
  input: ChatSessionUpsertInput,
): Promise<{ sessionId: string; updatedAt: string }> {
  const now = new Date().toISOString();
  const turnsJson = JSON.stringify(input.turns);
  const historyJson = JSON.stringify(input.history);
  // 入参未带 formSlug → 传 null 给 INSERT 的占位，并在 DO UPDATE 用 COALESCE 保留原值。
  const incomingSlug = input.formSlug === undefined ? null : input.formSlug;
  // 区分「未传 formSlug（保留原值）」与「显式传 null（也按 COALESCE 保留原值——契约只在
  // 显式传入非空 slug 时更新关联，§26.3「缺省不清空」）」：两者都走保留分支。
  const updateSlug = input.formSlug === undefined || input.formSlug === null ? 1 : 0;

  await db
    .prepare(
      `INSERT INTO chat_sessions
         (owner_id, session_id, turns_json, history_json, form_slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, session_id) DO UPDATE SET
         turns_json   = excluded.turns_json,
         history_json = excluded.history_json,
         form_slug    = CASE WHEN ? = 1 THEN chat_sessions.form_slug ELSE excluded.form_slug END,
         updated_at   = excluded.updated_at`,
    )
    .bind(ownerId, sessionId, turnsJson, historyJson, incomingSlug, now, now, updateSlug)
    .run();

  return { sessionId, updatedAt: now };
}
