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
//
// A' 项目↔对话（§26.10 / PR-A，灰度）：四个 D1 函数末尾各加一个**可选** `projectId` 参数，新增
// `renameChatSession`。语义是**灰度兼容**——**不传 projectId（旧 3/4 参数调用）= 旧路径**（不按
// project 过滤、INSERT 时 project_id 绑 NULL），现有 route 编排与旧测试零回归；传了 projectId 才
// 把会话归到该项目下（WHERE 加 AND project_id=?，用 idx_chat_sessions_owner_project）。`title` 列
// （0007 加）由独立的 {@link renameChatSession} 写，upsert **不**碰它（rename 是独立端点）。
// form_slug 列灰度期保留（长期真相源上移到 projects.form_slug，见 §6 兼容窗）。

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
  /** 可编辑标题列（0007，A'）；NULL → 列表回退到 deriveSessionTitle(turns_json) 推导。 */
  title: string | null;
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
 * A' 灰度（§26.10）：可选 `projectId`——仅当传入（非 null/undefined）时 WHERE 再加
 * `AND project_id = ?`（把会话定位收窄到该项目下）；不传则旧行为（仅按 owner+session）。
 * **绝不改 SELECT 列、绝不改 {@link ChatSessionRecord} 形状**（现有 api round-trip 测试对返回
 * 对象做精确 toEqual，加字段会破）。
 *
 * @param db D1 binding。
 * @param ownerId 当前登录 owner 的真实 user id（session JWT 的 sub，§17.5）。
 * @param sessionId 客户端生成的稳定 design session id（§26.2）。
 * @param projectId 可选（A'）：传入则把定位收窄到该项目下；不传 = 旧路径。
 * @returns 命中时 {@link ChatSessionRecord}，未命中 / 越权时 `null`。
 */
export async function loadChatSession(
  db: D1Database,
  ownerId: string,
  sessionId: string,
  projectId?: string | null,
): Promise<ChatSessionRecord | null> {
  // 灰度：projectId 传入才加 AND project_id=?（收窄到项目下）；不传则旧 WHERE。
  const scopeProject = projectId != null;
  const row = await db
    .prepare(
      `SELECT turns_json, history_json, form_slug, created_at, updated_at
       FROM chat_sessions WHERE owner_id = ? AND session_id = ?${
         scopeProject ? " AND project_id = ?" : ""
       }`,
    )
    .bind(...(scopeProject ? [ownerId, sessionId, projectId] : [ownerId, sessionId]))
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
 *   form_slug（避免一次普通对话写入把已关联的 slug 抹掉）。靠 CASE(excluded, 原值) 实现。
 * - **project_id 语义（A' 灰度，§26.10）：** 可选 `projectId`——未传 → INSERT 绑 NULL（旧路径，
 *   会话不归属任何项目）、DO UPDATE **保留**原 project_id；传了 → INSERT 落该值、DO UPDATE
 *   更新成该值（CASE，镜像 form_slug 的「未传则保留、传了则更新」）。
 * - **title 列（0007）：** upsert **不**写 title——rename 是独立端点（{@link renameChatSession}）。
 *   INSERT 不含 title 列（默认 NULL）；DO UPDATE 不动 title 列（一次整段保存不该抹掉显式标题）。
 *
 * @param projectId 可选（A'）：会话归属的项目 id；不传 = 旧路径（绑 / 保留 NULL）。
 * @returns 写入后的 `{ sessionId, updatedAt }`（route → `200`，§26.3）。
 */
export async function upsertChatSession(
  db: D1Database,
  ownerId: string,
  sessionId: string,
  input: ChatSessionUpsertInput,
  projectId?: string | null,
): Promise<{ sessionId: string; updatedAt: string }> {
  const now = new Date().toISOString();
  const turnsJson = JSON.stringify(input.turns);
  const historyJson = JSON.stringify(input.history);
  // 入参未带 formSlug → 传 null 给 INSERT 的占位，并在 DO UPDATE 用 CASE 保留原值。
  const incomingSlug = input.formSlug === undefined ? null : input.formSlug;
  // 区分「未传 formSlug（保留原值）」与「显式传 null（也按 CASE 保留原值——契约只在
  // 显式传入非空 slug 时更新关联，§26.3「缺省不清空」）」：两者都走保留分支。
  const updateSlug = input.formSlug === undefined || input.formSlug === null ? 1 : 0;
  // A' 灰度：未传 projectId（undefined/null）→ INSERT 绑 NULL、DO UPDATE 保留原 project_id；
  // 传了非空 → INSERT 落该值、DO UPDATE 更新成该值（CASE 镜像 form_slug 的保留/更新分支）。
  const incomingProject = projectId == null ? null : projectId;
  const updateProject = projectId == null ? 1 : 0;

  await db
    .prepare(
      `INSERT INTO chat_sessions
         (owner_id, session_id, turns_json, history_json, form_slug, project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, session_id) DO UPDATE SET
         turns_json   = excluded.turns_json,
         history_json = excluded.history_json,
         form_slug    = CASE WHEN ? = 1 THEN chat_sessions.form_slug ELSE excluded.form_slug END,
         project_id   = CASE WHEN ? = 1 THEN chat_sessions.project_id ELSE excluded.project_id END,
         updated_at   = excluded.updated_at`,
    )
    .bind(
      ownerId,
      sessionId,
      turnsJson,
      historyJson,
      incomingSlug,
      incomingProject,
      now,
      now,
      updateSlug,
      updateProject,
    )
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
   * 列表展示标题（A' 语义，§26.10）：**优先用行里 `title` 列**（owner 显式 rename 的标题，
   * 由 {@link renameChatSession} 写）——非空 string 直接取它；为 NULL / 空时才**回退**到运行期
   * 从 turns_json 推（§26.9）：首条 `role === "user"` 的 turn 的 `text`，trim 后截断到
   * {@link SESSION_TITLE_MAX_LEN} 字（超出补 "…"）。无 user turn / 空 / 损坏 turns_json →
   * {@link SESSION_TITLE_FALLBACK}。回退路径由 {@link deriveSessionTitle} 计算。
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
 * 列出当前 owner 的会话摘要（§26.9 GET /api/chat/sessions）——按 `updated_at DESC`（最近在前）。
 * 每行投影成 {@link ChatSessionSummary}：title「行 title 列非空优先、否则
 * {@link deriveSessionTitle}(turns_json) 推导」、turnCount 由 {@link countUserTurns} 从该行
 * turns_json 运行期推导。owner 名下零会话 → 空数组 `[]`（route → `200 { sessions: [] }`，正常
 * 空态，非错误）。响应不含 owner_id / 凭据（§26.8）。
 *
 * A' 灰度（§26.10）：可选 `projectId`——传入则 `WHERE owner_id=? AND project_id=?`（只列**本
 * 项目**会话，用 idx_chat_sessions_owner_project）；不传则旧 `WHERE owner_id=?`（全部，用
 * idx_chat_sessions_owner）。
 *
 * @param db D1 binding。
 * @param ownerId 当前登录 owner 的真实 user id（session JWT 的 sub，§17.5）。
 * @param projectId 可选（A'）：只列该项目下的会话；不传 = 旧路径（owner 全部会话）。
 * @returns 该 owner（可选限定项目）的会话摘要，按 updatedAt DESC；零会话回 `[]`。
 */
export async function listChatSessions(
  db: D1Database,
  ownerId: string,
  projectId?: string | null,
): Promise<ChatSessionSummary[]> {
  // 列表只需 session_id / turns_json / form_slug / title / updated_at——**不** SELECT
  // history_json（列表不渲染完整 LLM 历史，省带宽，§26.9）。按 updated_at DESC（最近在前）。
  // 次级键 session_id DESC：updated_at 是毫秒分辨率，同毫秒写入会打平 → SQLite 对相等键的
  // 顺序未定义（列表会抖、测试假红）。加一个确定性 tiebreak，让平局也有稳定顺序。
  // A' 灰度：projectId 传入则加 AND project_id=?（只列本项目，用 idx_chat_sessions_owner_project）。
  const scopeProject = projectId != null;
  const { results } = await db
    .prepare(
      `SELECT session_id, turns_json, form_slug, title, updated_at
       FROM chat_sessions WHERE owner_id = ?${scopeProject ? " AND project_id = ?" : ""}
       ORDER BY updated_at DESC, session_id DESC`,
    )
    .bind(...(scopeProject ? [ownerId, projectId] : [ownerId]))
    .all<ChatSessionListRow>();

  // 零行 → []（route → 200 { sessions: [] }，正常空态）。
  return (results ?? []).map((row) => ({
    sessionId: row.session_id,
    // A'：显式 title 列非空优先，否则回退到 turns_json 运行期推导（§26.9）。
    title:
      typeof row.title === "string" && row.title.length > 0
        ? row.title
        : deriveSessionTitle(row.turns_json),
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
 * A' 灰度（§26.10）：可选 `projectId`——传入则 WHERE 再加 `AND project_id=?`（只删本项目下
 * 那行）；不传则旧行为。
 *
 * @param db D1 binding。
 * @param ownerId 当前登录 owner 的真实 user id（session JWT 的 sub，§17.5）。
 * @param sessionId 要删的 design session id（§26.2）。
 * @param projectId 可选（A'）：把删除收窄到该项目下；不传 = 旧路径。
 * @returns 删到 `true`，无行 `false`。
 */
export async function deleteChatSession(
  db: D1Database,
  ownerId: string,
  sessionId: string,
  projectId?: string | null,
): Promise<boolean> {
  // 删自己名下那行（owner 隔离 + 横向越权防护，§26.8）：WHERE 必带 AND owner_id=?——A 删 B 的
  // sessionId 影响 0 行 → false → route 404，B 的行不动、不暴露 B 有这段对话。
  // A' 灰度：projectId 传入则再加 AND project_id=?（收窄到本项目下那行）。
  const scopeProject = projectId != null;
  const result = await db
    .prepare(
      `DELETE FROM chat_sessions WHERE owner_id = ? AND session_id = ?${
        scopeProject ? " AND project_id = ?" : ""
      }`,
    )
    .bind(...(scopeProject ? [ownerId, sessionId, projectId] : [ownerId, sessionId]))
    .run();
  // D1 run() 的影响行数在 result.meta.changes（miniflare/workerd；与 deleteForm 同字段，已核实）。
  return result.meta.changes > 0;
}

/**
 * 重命名一段会话——写 `title` 列（§26.10 PATCH /api/chat/session/:sessionId，A'）。
 * 数据层 `UPDATE chat_sessions SET title = ? WHERE owner_id=? AND session_id=?`——只能改自己
 * 名下的行（owner 隔离 + 横向越权防护，§26.8）。
 *
 * - **不刷 updated_at：** rename 只改显示标签，不该把会话顶到列表最前（updated_at 是「最后写入
 *   对话内容」的时间，列表按它 DESC 排）。故本函数只动 title 列，**不动** updated_at。
 * - 改到（有匹配行）→ `true`（route → `200 { renamed: true }`）。
 * - **无匹配行**（该 owner 从未存过这个 sessionId / 该 id 属于别的 owner）→ `false`
 *   （route → **404**）。owner 隔离的直接后果：A rename B 的 sessionId → A 名下无此行 →
 *   `false` → 404，B 的行**不动**（不暴露 B 有这段对话，与 §26.8 GET/DELETE 同纪律）。
 *
 * A' 灰度：可选 `projectId`——传入则 WHERE 再加 `AND project_id=?`（只改本项目下那行）；
 * 不传则旧（仅按 owner+session 定位）。
 *
 * @param db D1 binding。
 * @param ownerId 当前登录 owner 的真实 user id（session JWT 的 sub，§17.5）。
 * @param sessionId 要重命名的 design session id（§26.2）。
 * @param title 新标题（route 侧已 trim + 非空校验）。
 * @param projectId 可选（A'）：把重命名收窄到该项目下；不传 = 旧路径。
 * @returns 改到 `true`，无匹配行 `false`。
 */
export async function renameChatSession(
  db: D1Database,
  ownerId: string,
  sessionId: string,
  title: string,
  projectId?: string | null,
): Promise<boolean> {
  // 只动 title 列、**不刷 updated_at**（rename 不顶列表顺序）。WHERE 必带 owner_id（越权防护）。
  const scopeProject = projectId != null;
  const result = await db
    .prepare(
      `UPDATE chat_sessions SET title = ? WHERE owner_id = ? AND session_id = ?${
        scopeProject ? " AND project_id = ?" : ""
      }`,
    )
    .bind(...(scopeProject ? [title, ownerId, sessionId, projectId] : [title, ownerId, sessionId]))
    .run();
  // D1 run() 的影响行数在 result.meta.changes（与 deleteChatSession 同字段）。无匹配 → false → 404。
  return result.meta.changes > 0;
}
