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
// 多会话（§26.9，PR #65）：一个 owner 可同时持有多段会话（D1 主键是复合键，不限一行）。
// listChatSessions 用 idx_chat_sessions_owner 索引（migration 0003 已预留）按 owner 列出会话
// 摘要，deleteChatSession 删一行；title / turnCount 是 turns_json 的运行期投影，**不加列、不加
// migration**（0003 注释已说多会话列表是 follow-up）。
//
// Layering: loadChatSession / upsertChatSession / listChatSessions / deleteChatSession 是
// inner-loop unit-test target 与 outer-loop seam——route（index.ts）在其上编排（鉴权门 +
// ownerId 注入 + 404 映射）。deriveSessionTitle / countUserTurns 是 framework-agnostic 纯函数，
// implementer 直接 TDD（损坏 / 空 turns_json 防御性回退）。

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

/** 列表投影的 D1 行形状（§26.9）——**不**含 history_json（列表不需要，省带宽）。 */
interface ChatSessionListRow {
  session_id: string;
  turns_json: string;
  form_slug: string | null;
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

// ---------------------------------------------------------------------------
// 多会话列表 + 删除（SPEC §26.9，PR #65）——owner-only，不加列 / migration
// ---------------------------------------------------------------------------

/** title 推导的最大字符数（超出截断并加省略号，§26.9）。 */
export const SESSION_TITLE_MAX_LEN = 40;

/** 无 user turn 时的回退标题（含 turns_json 损坏 / 空，§26.9）。 */
export const SESSION_TITLE_FALLBACK = "新会话";

/**
 * 一段会话在「会话列表」里的摘要投影（§26.9）——只够列表渲染 + 切换 / 删除用，**不**含两份
 * 完整转写（那靠 {@link loadChatSession} 按 sessionId 拉）。title / turnCount 是 turns_json
 * 的运行期推导（库里**不**存这两列，0003 不加 migration），故任何时候都与转写一致。
 * 不含 owner_id / 任何凭据（§26.8）。
 */
export interface ChatSessionSummary {
  /** 客户端生成的稳定 design session id（(owner_id, sessionId) 键的 sessionId 部分，§26.2）。 */
  sessionId: string;
  /**
   * 列表展示标题，运行期从 turns_json 推（§26.9）：首条 `role === "user"` 的 turn 的 `text`，
   * trim 后截断到 {@link SESSION_TITLE_MAX_LEN} 字（超出补 "…"）。无 user turn / 空 / 损坏
   * turns_json → {@link SESSION_TITLE_FALLBACK}。由 {@link deriveSessionTitle} 计算。
   */
  title: string;
  /**
   * 对话轮数 = turns_json 里 `role === "user"` 的 turn 数（§26.9）。损坏 / 空 → 0。
   * 由 {@link countUserTurns} 计算。
   */
  turnCount: number;
  /** 发布后关联的 forms.slug（§26.2）；未发布为 `null`。 */
  formSlug: string | null;
  /** 该会话最后写入时间，ISO-8601（列表按它 DESC 排，最近在前，§26.9）。 */
  updatedAt: string;
}

/**
 * 从一段会话的 `turns_json` 推导列表标题（§26.9）——**纯函数**，便于 implementer 直接 TDD。
 *
 * 规则：JSON-parse turns_json → 取数组里**首条** `role === "user"` 的 turn → 取其 `text`，
 * trim；若非空则截断到 {@link SESSION_TITLE_MAX_LEN} 字（超出补单个 "…"，省略号不计入上限）。
 *
 * 防御性回退到 {@link SESSION_TITLE_FALLBACK}（"新会话"）的情形：turns_json 非合法 JSON /
 * 非数组 / 无 user turn / 首条 user turn 无 `text` 或 trim 后为空。绝不抛——一次坏数据不该让
 * 整个列表读崩（与既有 {@link parseJsonArray} 同纪律）。
 *
 * @param turnsJson 库里 `turns_json` 列的原始字符串（可能损坏 / 空）。
 * @returns 截断后的标题，或 "新会话" 回退。
 */
export function deriveSessionTitle(turnsJson: string | null | undefined): string {
  // 防御性 parse（同 parseJsonArray 纪律：损坏 / 非数组 / 空 → 走回退，绝不抛）。
  const turns = parseJsonArray(turnsJson);
  // 首条 role === "user" 的 turn 的 text。
  const firstUser = turns.find(
    (t): t is { text?: unknown } =>
      typeof t === "object" && t !== null && (t as { role?: unknown }).role === "user",
  );
  const rawText = firstUser?.text;
  if (typeof rawText !== "string") return SESSION_TITLE_FALLBACK;
  const text = rawText.trim();
  if (text.length === 0) return SESSION_TITLE_FALLBACK;
  // 截断按 Unicode 码点（避免把 emoji 的 surrogate pair 切半），超出补单个 "…"（不计入上限）。
  const chars = [...text];
  if (chars.length <= SESSION_TITLE_MAX_LEN) return text;
  return chars.slice(0, SESSION_TITLE_MAX_LEN).join("") + "…";
}

/**
 * 从一段会话的 `turns_json` 数出对话轮数（§26.9）——**纯函数**，便于 implementer 直接 TDD。
 * 轮数 = 数组里 `role === "user"` 的 turn 个数。turns_json 非合法 JSON / 非数组 / 空 → `0`。
 * 绝不抛（同 {@link parseJsonArray} 纪律）。
 *
 * @param turnsJson 库里 `turns_json` 列的原始字符串（可能损坏 / 空）。
 * @returns user turn 数，损坏 / 空回 0。
 */
export function countUserTurns(turnsJson: string | null | undefined): number {
  // 防御性 parse（损坏 / 非数组 / 空 → 0，绝不抛）。
  return parseJsonArray(turnsJson).filter(
    (t) => typeof t === "object" && t !== null && (t as { role?: unknown }).role === "user",
  ).length;
}

/**
 * 列出当前 owner 的全部会话摘要（§26.9 GET /api/chat/sessions）——按 `updated_at DESC`
 * （最近在前），仅 `WHERE owner_id = ?`（跨 owner 隔离：只见自己名下的行，§26.8）。每行投影成
 * {@link ChatSessionSummary}，title / turnCount 由 {@link deriveSessionTitle} /
 * {@link countUserTurns} 从该行 turns_json 运行期推导。owner 名下零会话 → 空数组 `[]`
 * （route → `200 { sessions: [] }`，正常空态，非错误）。用 idx_chat_sessions_owner 索引
 * （migration 0003 已预留）。响应不含 owner_id / 凭据（§26.8）。
 *
 * @param db D1 binding。
 * @param ownerId 当前登录 owner 的真实 user id（session JWT 的 sub，§17.5）。
 * @returns 该 owner 全部会话摘要，按 updatedAt DESC；零会话回 `[]`。
 */
export async function listChatSessions(
  db: D1Database,
  ownerId: string,
): Promise<ChatSessionSummary[]> {
  // 列表只需 session_id / turns_json / form_slug / updated_at——**不** SELECT history_json
  // （列表不渲染完整 LLM 历史，省带宽，§26.9）。按 updated_at DESC（最近在前），仅 WHERE
  // owner_id=?（跨 owner 隔离，§26.8），用 idx_chat_sessions_owner 索引。
  // 次级键 session_id DESC：updated_at 是毫秒分辨率，同毫秒写入会打平 → SQLite 对相等键的
  // 顺序未定义（列表会抖、测试假红）。加一个确定性 tiebreak，让平局也有稳定顺序。
  const { results } = await db
    .prepare(
      `SELECT session_id, turns_json, form_slug, updated_at
       FROM chat_sessions WHERE owner_id = ? ORDER BY updated_at DESC, session_id DESC`,
    )
    .bind(ownerId)
    .all<ChatSessionListRow>();

  // 零行 → []（route → 200 { sessions: [] }，正常空态）。
  return (results ?? []).map((row) => ({
    sessionId: row.session_id,
    title: deriveSessionTitle(row.turns_json),
    turnCount: countUserTurns(row.turns_json),
    formSlug: row.form_slug ?? null,
    updatedAt: row.updated_at,
  }));
}

/**
 * 删除当前 owner 名下指定 sessionId 的会话行（§26.9 DELETE /api/chat/session/:sessionId）。
 * 数据层 `DELETE ... WHERE owner_id = ? AND session_id = ?`——只能删自己名下的行（owner 隔离，
 * §26.8）。
 *
 * - 删到（有匹配行）→ `true`（route → `200 { deleted: true }`）。
 * - **无匹配行**（该 owner 从未存过这个 sessionId / 该 id 属于别的 owner）→ `false`
 *   （route → **404** `{ error: "会话不存在" }`）。owner 隔离的直接后果：A 删 B 的 sessionId →
 *   A 名下无此行 → `false` → 404，B 的行**不动**（不暴露 B 有这段对话，与 §26.8 GET 同纪律）。
 *
 * @param db D1 binding。
 * @param ownerId 当前登录 owner 的真实 user id（session JWT 的 sub，§17.5）。
 * @param sessionId 要删的 design session id（§26.2）。
 * @returns 删到 `true`，无行 `false`。
 */
export async function deleteChatSession(
  db: D1Database,
  ownerId: string,
  sessionId: string,
): Promise<boolean> {
  // 删自己名下那行（owner 隔离 + 横向越权防护，§26.8）：WHERE 必带 AND owner_id=?——A 删 B 的
  // sessionId 影响 0 行 → false → route 404，B 的行不动、不暴露 B 有这段对话。
  const result = await db
    .prepare(`DELETE FROM chat_sessions WHERE owner_id = ? AND session_id = ?`)
    .bind(ownerId, sessionId)
    .run();
  // D1 run() 的影响行数在 result.meta.changes（miniflare/workerd；与 deleteForm 同字段，已核实）。
  return result.meta.changes > 0;
}
