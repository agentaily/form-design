// projects.ts — D1 data layer for 项目级工作区持久化（A' 项目↔对话，§26.10 / PR-A）.
//
// A' 模型（docs/refactor-project-conversation.md）：一个「表单」= 一个「项目」。项目是容器，
// 承载一份**共享的**工作区模型（meta + fields）；项目下可开多条对话（会话），它们都编辑同一份
// 表单。切对话只换聊天线索，右侧工作区不变。本文件把项目级工作区落库（替代 #76 的「工作区快照
// 骑 turns_json」做法，那让两条会话各自重建工作区、回到耦合）。
//
// keying / 隔离（沿用 §26.8 纪律，与 chatSessions.ts 同密度）：项目按 (owner_id, project_id)
// 复合主键隔离——owner_id 取自 session JWT 的 sub，project_id 是客户端生成的稳定 UUID
// （crypto.randomUUID，草稿期即生成，不依赖表单 slug，§26.2 同根因）。隔离靠键本身、不靠运行期
// 过滤：A 即便猜到 B 的 project_id，WHERE owner_id=? 也读不到 B 的项目。
//
// form_slug 从 chat_sessions 行**上移**到 projects 行——一个项目一份表单一个 slug（软引用，可空，
// 无强外键，slug 删了项目不连删）。绝不存任何 owner 凭据（DeepSeek key / 飞书 secret 在
// owner_config，§12）。
//
// Layering: loadProject / upsertProject / listProjects / deleteProject 是 inner-loop
// unit-test target 与 outer-loop seam——route（index.ts）在其上编排（鉴权门 + ownerId 注入 +
// 404 映射）。deriveProjectTitle 是 framework-agnostic 纯函数，implementer 直接 TDD（损坏 / 空 /
// 无 title 防御性回退）。

/**
 * 一个项目（= 一份表单的容器）的对外投影。meta / fields 已 JSON-parse；formSlug 是发布后软引用
 * 的 slug（未发布 null），时间戳 ISO-8601。绝不含 owner_id / 任何凭据（§26.8）。
 */
export interface ProjectRecord {
  projectId: string;
  /** 反序列化后的 FormMeta，损坏 / 非对象 / 空 → null（防御性，绝不抛）。 */
  meta: unknown | null;
  /** 反序列化后的 UiField[]，损坏 / 非数组 / 空 → []。 */
  fields: unknown[];
  formSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `PUT /api/projects/:projectId` 的入参：整段替换的工作区快照。 */
export interface ProjectUpsertInput {
  /** FormMeta | null（空项目可为 null）。 */
  meta: unknown | null;
  /** UiField[]（项目级工作区字段）。 */
  fields: unknown[];
  /** 可选：发布后关联此 slug；缺省 / null 时**不清空**已存（同 §26.3 form_slug 缺省不清空纪律）。 */
  formSlug?: string | null;
}

/** 项目列表项摘要（给项目切换器）。title 取 meta.title，空则回退默认。 */
export interface ProjectSummary {
  projectId: string;
  /** 列表展示标题：meta.title trim 后非空则取它，否则回退 {@link PROJECT_TITLE_FALLBACK}。 */
  title: string;
  /** 工作区字段数 = fields 长度。 */
  fieldCount: number;
  formSlug: string | null;
  /** 该项目最后写入时间，ISO-8601（列表按它 DESC 排，最近在前）。 */
  updatedAt: string;
}

/** D1 单项目读回的行形状（按需投影）。 */
interface ProjectRow {
  meta_json: string | null;
  fields_json: string | null;
  form_slug: string | null;
  created_at: string;
  updated_at: string;
}

/** 列表投影的 D1 行形状——只够列表渲染用（title 从 meta_json 推、fieldCount 从 fields_json 数）。 */
interface ProjectListRow {
  project_id: string;
  meta_json: string | null;
  fields_json: string | null;
  form_slug: string | null;
  updated_at: string;
}

/** 无 meta.title 时项目列表的回退标题（含 meta_json 损坏 / 空 / 非对象）。 */
export const PROJECT_TITLE_FALLBACK = "未命名表单";

/**
 * 防御性 JSON.parse 成**对象**：库里 meta_json 存的本就是 FormMeta 的序列化；损坏 / 非对象
 * （含数组 / null / 标量）/ 空时回 `null`，不让一次坏数据让读崩掉（同 parseJsonArray 纪律）。
 */
function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    // 仅接受非数组的普通对象；数组 / null / 标量都不是合法 FormMeta → null。
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** 防御性 JSON.parse 成数组：损坏 / 非数组 / 空 → []，不让一次读崩掉（同 chatSessions 纪律）。 */
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
 * 从一个项目的 `meta_json` 推导列表标题——**纯函数**，便于 implementer 直接 TDD。
 *
 * 规则：JSON-parse meta_json → 取 `obj.title` → trim；若非空则返回，否则回退
 * {@link PROJECT_TITLE_FALLBACK}（"未命名表单"）。
 *
 * 防御性回退（绝不抛，同 {@link deriveSessionTitle} 纪律）：meta_json 非合法 JSON / 非对象
 * （数组 / null / 标量）/ 无 title / title 非字符串 / trim 后为空。一次坏数据不该让整个项目
 * 列表读崩。
 *
 * @param metaJson 库里 `meta_json` 列的原始字符串（可能损坏 / 空 / NULL）。
 * @returns meta.title（trim 后非空）或 "未命名表单" 回退。
 */
export function deriveProjectTitle(metaJson: string | null | undefined): string {
  // 防御性 parse（损坏 / 非对象 / 空 → null → 走回退，绝不抛）。
  const meta = parseJsonObject(metaJson);
  if (meta === null) return PROJECT_TITLE_FALLBACK;
  const rawTitle = meta.title;
  if (typeof rawTitle !== "string") return PROJECT_TITLE_FALLBACK;
  const title = rawTitle.trim();
  return title.length > 0 ? title : PROJECT_TITLE_FALLBACK;
}

/**
 * 按 (owner_id, project_id) 读回一个项目的工作区（GET /api/projects/:projectId）。
 *
 * - 命中：把行里的 meta_json 防御性 parse 成对象 | null、fields_json parse 成数组，连同
 *   form_slug + 时间戳组装成 {@link ProjectRecord}。
 * - 该 owner 从未存过这个 project_id（含「A 猜 B 的 id」越权读）：返回 `null`（route →
 *   `{ project: null }`，正常空态，**非 404**，镜像 chat session GET，§26.8）。
 *
 * 隔离靠 WHERE owner_id=? AND project_id=?（复合主键，§26.8）——绝不暴露别的 owner 的项目。
 *
 * @param db D1 binding。
 * @param ownerId 当前登录 owner 的真实 user id（session JWT 的 sub，§17.5）。
 * @param projectId 客户端生成的稳定 project id（UUID）。
 * @returns 命中时 {@link ProjectRecord}，未命中 / 越权时 `null`。
 */
export async function loadProject(
  db: D1Database,
  ownerId: string,
  projectId: string,
): Promise<ProjectRecord | null> {
  const row = await db
    .prepare(
      `SELECT meta_json, fields_json, form_slug, created_at, updated_at
       FROM projects WHERE owner_id = ? AND project_id = ?`,
    )
    .bind(ownerId, projectId)
    .first<ProjectRow>();

  if (row === null) return null;

  return {
    projectId,
    meta: parseJsonObject(row.meta_json),
    fields: parseJsonArray(row.fields_json),
    formSlug: row.form_slug ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 整段 upsert 一个项目的工作区（PUT /api/projects/:projectId，last-write-wins）。按
 * (owner_id, project_id) 已存在则更新、不存在则插入；meta_json / fields_json 整列覆盖，
 * updated_at 刷新。
 *
 * - **created_at 语义：** 首次插入落当前时刻；后续更新**保留**原 created_at（`ON CONFLICT ...
 *   DO UPDATE` 不动 created_at 列）。
 * - **meta_json 语义：** input.meta == null → 存 NULL（空项目）；否则 JSON.stringify。
 * - **fields_json 语义：** JSON.stringify(input.fields ?? [])。
 * - **form_slug 语义（同 §26.3）：** 仅在入参显式带非空 string `formSlug` 时更新；缺省 / null
 *   时**不清空**已存的 form_slug（避免一次普通保存把已关联的 slug 抹掉）。靠 CASE 实现，与
 *   chatSessions.upsert 完全一致。
 *
 * @returns 写入后的 `{ projectId, updatedAt }`（route → `200`）。
 */
export async function upsertProject(
  db: D1Database,
  ownerId: string,
  projectId: string,
  input: ProjectUpsertInput,
): Promise<{ projectId: string; updatedAt: string }> {
  const now = new Date().toISOString();
  const metaJson = input.meta == null ? null : JSON.stringify(input.meta);
  const fieldsJson = JSON.stringify(input.fields ?? []);
  // 入参未带 formSlug → 传 null 给 INSERT 占位，并在 DO UPDATE 用 CASE 保留原值。
  const incomingSlug = input.formSlug === undefined ? null : input.formSlug;
  // 区分「未传 / 显式 null（保留原值）」与「显式非空 string（更新关联）」：前两者走保留分支
  // （契约只在显式传入非空 slug 时更新关联，§26.3「缺省不清空」），与 chatSessions.upsert 一致。
  const updateSlug = input.formSlug === undefined || input.formSlug === null ? 1 : 0;

  await db
    .prepare(
      `INSERT INTO projects
         (owner_id, project_id, meta_json, fields_json, form_slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, project_id) DO UPDATE SET
         meta_json   = excluded.meta_json,
         fields_json = excluded.fields_json,
         form_slug   = CASE WHEN ? = 1 THEN projects.form_slug ELSE excluded.form_slug END,
         updated_at  = excluded.updated_at`,
    )
    .bind(ownerId, projectId, metaJson, fieldsJson, incomingSlug, now, now, updateSlug)
    .run();

  return { projectId, updatedAt: now };
}

/**
 * 列出当前 owner 的全部项目摘要（GET /api/projects）——按 `updated_at DESC`（最近在前），仅
 * `WHERE owner_id = ?`（跨 owner 隔离：只见自己名下的行，§26.8）。每行投影成
 * {@link ProjectSummary}：title 由 {@link deriveProjectTitle} 从 meta_json 推、fieldCount =
 * fields_json parse 后数组长度。owner 名下零项目 → 空数组 `[]`（route → `200 { projects: [] }`，
 * 正常空态，非错误）。用 idx_projects_owner 索引。响应不含 owner_id / 凭据（§26.8）。
 *
 * 次级键 project_id DESC：updated_at 是毫秒分辨率，同毫秒写入会打平 → SQLite 对相等键的顺序
 * 未定义（列表会抖、测试假红）。加确定性 tiebreak，与 listChatSessions 同纪律。
 *
 * @param db D1 binding。
 * @param ownerId 当前登录 owner 的真实 user id（session JWT 的 sub，§17.5）。
 * @returns 该 owner 全部项目摘要，按 updatedAt DESC；零项目回 `[]`。
 */
export async function listProjects(db: D1Database, ownerId: string): Promise<ProjectSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT project_id, meta_json, fields_json, form_slug, updated_at
       FROM projects WHERE owner_id = ? ORDER BY updated_at DESC, project_id DESC`,
    )
    .bind(ownerId)
    .all<ProjectListRow>();

  // 零行 → []（route → 200 { projects: [] }，正常空态）。
  return (results ?? []).map((row) => ({
    projectId: row.project_id,
    title: deriveProjectTitle(row.meta_json),
    fieldCount: parseJsonArray(row.fields_json).length,
    formSlug: row.form_slug ?? null,
    updatedAt: row.updated_at,
  }));
}

/**
 * 删除当前 owner 名下指定 projectId 的项目（DELETE /api/projects/:projectId）——**级联**删其下
 * 会话。
 *
 * 项目没了，其对话也无处可挂（§3.1 建议级联），故先删本项目的 chat_sessions、再删 projects 行：
 *   1) `DELETE FROM chat_sessions WHERE owner_id=? AND project_id=?`（清掉本项目的全部会话）。
 *   2) `DELETE FROM projects       WHERE owner_id=? AND project_id=?`（删项目行本身）。
 *
 * - 项目存在（projects 删到 1 行）→ `true`（route → `200 { deleted: true }`）。
 * - **无匹配项目行**（从未存过 / 属于别的 owner）→ `false`（route → **404**）。owner 隔离的直接
 *   后果：A 删 B 的 projectId → A 名下无此项目行 → `false` → 404，B 的项目 + 会话**不动**（§26.8
 *   同纪律）。注意返回值看的是 **projects** 删除的 changes（项目行存在与否），不看会话删了几行
 *   （空项目无会话时会话删 0 行，但项目仍存在 → 应返回 true）。
 *
 * @param db D1 binding。
 * @param ownerId 当前登录 owner 的真实 user id（session JWT 的 sub，§17.5）。
 * @param projectId 要删的 project id。
 * @returns 项目存在并删到 `true`，无匹配项目行 `false`。
 */
export async function deleteProject(
  db: D1Database,
  ownerId: string,
  projectId: string,
): Promise<boolean> {
  // 1) 级联：先删本项目下的会话（owner 隔离 + 横向越权防护，§26.8）。
  await db
    .prepare(`DELETE FROM chat_sessions WHERE owner_id = ? AND project_id = ?`)
    .bind(ownerId, projectId)
    .run();
  // 2) 删项目行本身；返回值看 projects 的 changes（项目行存在与否）——会话可能为 0 行（空项目）。
  const result = await db
    .prepare(`DELETE FROM projects WHERE owner_id = ? AND project_id = ?`)
    .bind(ownerId, projectId)
    .run();
  // D1 run() 的影响行数在 result.meta.changes（与 deleteChatSession 同字段，已核实）。
  return result.meta.changes > 0;
}
