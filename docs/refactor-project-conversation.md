# 重构方案 · 「项目 ↔ 对话」状态模型(A')

> 状态:**PROPOSAL / 计划**(spec-architect 出,PR #80)。本文件只**提议** SPEC.md /
> `features/*.feature` / `src/core` 契约该怎么改,**不**直接动它们、不写实现代码。
> 经 manager / 老板 review 后,再由后续有序 PR 落地(见 §6 拆分建议)。
>
> 背景:老板已拍板方向 **A'**(给「会话」上面加「项目」层)。本文档把这个方向落成
> 数据模型、契约签名、已 ship 契约的变更清单与回归风险、前端接线变化、拆分建议。

---

## 1. 产品意图与 A' 模型

**一个「表单」= 一个「项目」。** 项目是容器;项目里可开多条对话(会话),但它们都编辑
**同一份表单**。切对话只换左侧聊天线索,右侧表单工作区(标题 + 字段)**不变**。进项目默认
接最近那条对话继续编辑。「项目」承载这份共享的表单模型(meta + fields);「对话(会话)」是
它下面**共享同一份表单**的多条编辑线索。

这是对现状的纠正:现状(§26 + #76)里**对话是顶层、工作区骑在每条对话里**
(`buildWorkspaceSnapshotTurn` 把 `{meta, fields}` 当一条合成 turn 塞进该会话的
`turns_json`)。结果是「切对话 = 切到另一份工作区」,与「多条对话共编同一表单」的产品意图相反。
A' 把工作区上提到**项目级**,会话退化为「同一表单下的多条聊天线索」。

### A' 的关键取舍(已定,不再推翻)

- **项目用自己的 client-minted UUID `project_id`**:草稿期(进设计器、还没建任何字段)就生成,
  写 localStorage,**不依赖表单 id**。这绕开 §26.2 当初不按表单 keying 的那个真实约束——
  **草稿发布前没有稳定的表单 slug**(slug 仅 `POST /api/forms` 后才有)。发布后再把表单 `slug`
  **软引用**关联到 project(沿用现 `form_slug` 思路:可空、无强外键)。
- **会话归到项目下**:键 `(owner_id, session_id)` → **`(owner_id, project_id, session_id)`**;
  会话列表(SessionMenu)按**当前 project_id** 筛(只列本项目的对话,不再全局扁平)。
- **工作区项目级**:表单 meta + fields 绑 `project_id`、**不绑 session**;切对话不动工作区。
  这**废弃** `buildWorkspaceSnapshotTurn` / `splitWorkspaceSnapshot` / `WORKSPACE_SNAPSHOT_ID`
  (#76 的「工作区快照骑在 turns_json」做法)。
- 进项目载该项目**最近会话的真实聊天**;**去掉**合成的「已载入《×》·共 N 字段」开场白
  (那是 `loadFormForEdit` 用 `setMessagesTracked` 塞的字面量 note)。
- **对话标题可编辑(rename)**:库里加一列存显式标题,缺省仍回退到 §26.9 的运行期推导(首条
  user 消息截断)。

### 关系图

```
owner (users.id)
  │  1
  │
  │  N
  ▼
project (project_id, client-minted UUID)
  ├── 承载一份共享的 workspace / form 模型 (meta_json + fields_json)   ← 项目级,切对话不变
  ├── form_slug (软引用,发布后填;未发布 NULL)
  │
  │  1
  │
  │  N
  ▼
session (project_id, session_id)
  ├── turns_json   (UI 回合 PersistedTurn[],纯对话,不再含 workspace 快照 turn)
  ├── history_json (LLM 历史 ChatMessage[],含 system)
  └── title        (可编辑;缺省回退到首条 user 消息推导)

进项目  → 选最近 session(updated_at DESC)→ 载它的 turns/history + 项目的 workspace
切对话  → 换 session(只重渲对话 + reseed history)→ workspace 不动
新对话  → 同 project 下 mint 新 session_id;workspace 不动(继续编同一份表单)
```

---

## 2. 数据模型(后端 D1)

新 migration:`workers/migrations/0007_projects_and_session_project.sql`(现号已到 0006)。

### 2.1 新建 `projects` 表(承载项目级工作区)

「草稿工作区现在不落库」是 §26 / §16 的现状:`forms` 表**只存已发布表单**(PK `slug`),草稿
表单模型只活在前端 `modelRef.current`。A' 要让**切对话工作区不变**,就必须把项目级工作区
**落库**(否则同一项目的两条会话各自重建工作区,又回到 #76 的耦合)。故新建 `projects`:

```sql
CREATE TABLE IF NOT EXISTS projects (
  project_id  TEXT NOT NULL,    -- client-minted UUID(§A'.1);草稿期即生成,不依赖表单 slug
  owner_id    TEXT NOT NULL,    -- owner 真实 user id(users.id);隔离键
  meta_json   TEXT,             -- 序列化 FormMeta(title/description);空项目可 NULL
  fields_json TEXT,             -- 序列化 UiField[](项目级工作区字段);空项目可 NULL
  form_slug   TEXT,             -- 发布后软引用 forms.slug;未发布 NULL,可空,无强外键
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (owner_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_id);
```

- **复合主键 `(owner_id, project_id)`**:同 `chat_sessions` 隔离纪律(§26.8),靠键本身隔离、
  不靠运行期过滤。`project_id` 是 client-minted UUID(crypto.randomUUID),高熵不可猜。
- **`meta_json` / `fields_json` 可空**:owner 进项目还没建字段就能存在一个空项目(对话先于表单,
  正是 §26.2 keying 不绑表单的同一根本原因,只是上提到项目)。
- **`form_slug` 软引用**:发布后填,沿用 `chat_sessions.form_slug` 的弱关联语义(可空、无强外键、
  slug 删了项目不连删)。**注意**:`form_slug` 从 session 行**上移**到 project 行——一个项目一份
  表单一个 slug,而非每条会话各持一个。

### 2.2 给 `chat_sessions` 加 `project_id` + 可编辑 `title`

```sql
ALTER TABLE chat_sessions ADD COLUMN project_id TEXT;   -- 回填后逻辑上 NOT NULL(见 2.3)
ALTER TABLE chat_sessions ADD COLUMN title      TEXT;   -- 可编辑标题;NULL → 运行期推导回退
CREATE INDEX IF NOT EXISTS idx_chat_sessions_owner_project
  ON chat_sessions (owner_id, project_id);
```

> SQLite/D1 的 `ALTER TABLE ADD COLUMN` 不支持加 `NOT NULL` 无默认列到非空表,故 `project_id`
> 物理上可空、靠回填(2.3)+ 应用层保证逻辑非空。`form_slug` 列**保留**在 `chat_sessions` 上
> 一个版本以便灰度兼容(见 §6),长期真相源是 `projects.form_slug`。

### 2.3 迁移(关键:不能丢老板已有会话 / 对话)

现状每行 `chat_sessions` 的 `turns_json` 里(若 #76 之后写过)有一条
`id = "__agentaily_workspace_snapshot__"`、`kind = "workspace"` 的合成 turn,携带
`{ meta, fields }`。**迁移策略 = 「老每条会话各自成为一个单对话项目,工作区取它原快照」**:

对每一行老 `chat_sessions`:

1. **mint 一个新 `project_id`**(迁移期服务端生成 UUID;前端的 localStorage 旧 `designSessionId`
   不参与——它是 session 维度,不是 project)。
2. 从该行 `turns_json` 抽出 workspace 快照那条 turn 的 `{ meta, fields }` →
   写入新 `projects` 行的 `meta_json` / `fields_json`;把老 `form_slug` 一并迁到 `projects.form_slug`;
   `created_at` / `updated_at` 沿用该会话的时间戳。
3. 把该会话行的 `project_id` 置为这个新 project;**从 `turns_json` 里删掉那条 workspace 快照
   turn**(它已上提到 project,留着会被当成对话气泡之外的脏数据);`title` 留 NULL(运行期推导)。

> **抽取与删快照不可在纯 SQL 里干净完成**(要 parse JSON、按 sentinel id 过滤),建议迁移脚本走
> **两段式**:① 0007 SQL 只建表 + 加列 + 加索引;② 一个**一次性数据迁移**(可以是 worker 内
> 的 maintenance 端点 / 一段 wrangler d1 脚本 / Node 脚本)读出每行、JS 里 split 快照、回写
> projects + 更新 sessions。`splitWorkspaceSnapshot` 的**纯逻辑可被该脚本复用**(它在被前端废弃
> 前,迁移期还有最后一次用途)。由 implementer / release-eng 定具体载体。

**没有 #76 快照的老行**(纯 §26/§65 时代、`turns_json` 里无 workspace turn):同样 mint 一个
project,`meta_json` / `fields_json` 留 NULL(空工作区);其余同上。这些会话本就没持久化过工作区,
迁移后行为不变(进去工作区是空的,与刷新前一致)。

**不可逆性 / 回滚考量:**

- 删快照 turn 是**有损**写(老 `turns_json` 被改写)。回滚 0007 schema 容易(drop 列/表),但
  **数据迁移不可逆**——一旦把快照从 turns_json 抽走,旧前端再读就没工作区了。故:
  - **先发后端兼容版**(加列、可空、旧前端仍能跑),数据迁移放在前端切到 A' 的**同一批**或之后,
    且**迁移脚本先备份**(导出 `chat_sessions` 全表再改)。
  - 数据迁移**幂等**:重跑时跳过「已有 project_id」的行(`WHERE project_id IS NULL`),避免二次
    抽取把已清理的行再处理一遍。

### 2.4 键的变化与查询

- 单会话定位:`WHERE owner_id=? AND session_id=?` **保持可用**(session_id 仍全局唯一够定位),
  但 A' 下推荐 `WHERE owner_id=? AND project_id=? AND session_id=?` 以表达「会话属于项目」。
- 会话列表:`listChatSessions` 增 `WHERE project_id=?`(只列本项目的对话),用
  `idx_chat_sessions_owner_project`。
- 项目列表:新 `listProjects(db, ownerId)` → `WHERE owner_id=? ORDER BY updated_at DESC`,
  用 `idx_projects_owner`。

---

## 3. 契约 / 接口变化(前端 `src/core` + 后端 `workers/src`)

下面是**目标签名草案**(stub 级,**不写实现体**——留给 implementer 按 TDD)。

### 3.1 后端 `workers/src/projects.ts`(新文件,项目级工作区数据层)

```ts
/** 一个项目(= 一份表单的容器)的对外投影。meta/fields 已 JSON-parse;不含 owner_id。 */
export interface ProjectRecord {
  projectId: string;
  meta: unknown | null; // FormMeta | null
  fields: unknown[]; // UiField[]
  formSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `PUT /api/projects/:projectId` 入参:整段替换的工作区快照。 */
export interface ProjectUpsertInput {
  meta: unknown | null;
  fields: unknown[];
  formSlug?: string | null; // 缺省不清空已存(COALESCE 保留,同 §26.3 form_slug 纪律)
}

/** 项目列表项摘要(给项目切换器)。title 取 meta.title,空则回退默认。 */
export interface ProjectSummary {
  projectId: string;
  title: string; // meta.title || "未命名表单";运行期推导
  fieldCount: number; // fields 长度
  formSlug: string | null;
  updatedAt: string;
}

export function loadProject(
  db: D1Database,
  ownerId: string,
  projectId: string,
): Promise<ProjectRecord | null> {
  throw new Error("stub");
}
export function upsertProject(
  db: D1Database,
  ownerId: string,
  projectId: string,
  input: ProjectUpsertInput,
): Promise<{ projectId: string; updatedAt: string }> {
  throw new Error("stub");
}
export function listProjects(db: D1Database, ownerId: string): Promise<ProjectSummary[]> {
  throw new Error("stub");
}
export function deleteProject(
  db: D1Database,
  ownerId: string,
  projectId: string,
): Promise<boolean> {
  throw new Error("stub");
}
```

> 端点(挂 §17 owner-only,沿用 §26.1 鉴权门):
> `GET /api/projects`(列表)· `GET/PUT/DELETE /api/projects/:projectId`(单项目工作区)。
> 删项目时是否级联删其下会话由实现定;建议**级联删**(项目没了,其对话也无处可挂)。

### 3.2 后端 `workers/src/chatSessions.ts`(改签名)

- `loadChatSession` / `upsertChatSession` / `deleteChatSession`:**增 `projectId` 参数**,
  WHERE 加 `AND project_id=?`(写入时把 project_id 落进行)。
- `listChatSessions(db, ownerId, projectId)`:**增 `projectId` 参数**,`WHERE owner_id=? AND
project_id=?`,用新复合索引。
- `ChatSessionSummary` 增 `title` 字段语义变化:**优先用行里 `title` 列**,为 NULL 才回退
  `deriveSessionTitle(turns_json)`(§26.9 推导仍是回退路径,纯函数 `deriveSessionTitle` /
  `countUserTurns` **保留**)。
- **新增** `renameChatSession(db, ownerId, projectId, sessionId, title): Promise<boolean>`
  (写 `title` 列;无匹配行 → false → route 404)。
- `ChatSessionRecord` / `ChatSessionUpsertInput`:`formSlug` 字段**上移到 project**——session 行
  灰度期保留该列但长期由 project 持有(见 §6 兼容窗)。

```ts
export function loadChatSession(
  db: D1Database,
  ownerId: string,
  projectId: string,
  sessionId: string,
): Promise<ChatSessionRecord | null> {
  throw new Error("stub");
}
export function upsertChatSession(
  db: D1Database,
  ownerId: string,
  projectId: string,
  sessionId: string,
  input: ChatSessionUpsertInput,
): Promise<{ sessionId: string; updatedAt: string }> {
  throw new Error("stub");
}
export function listChatSessions(
  db: D1Database,
  ownerId: string,
  projectId: string,
): Promise<ChatSessionSummary[]> {
  throw new Error("stub");
}
export function deleteChatSession(
  db: D1Database,
  ownerId: string,
  projectId: string,
  sessionId: string,
): Promise<boolean> {
  throw new Error("stub");
}
export function renameChatSession(
  db: D1Database,
  ownerId: string,
  projectId: string,
  sessionId: string,
  title: string,
): Promise<boolean> {
  throw new Error("stub");
}
```

### 3.3 前端 `src/core/projectClient.ts`(新文件)

```ts
export const DESIGN_PROJECT_ID_KEY = "agentaily_forms_design_project"; // localStorage 活跃 project id

export interface ProjectWorkspace {
  meta: FormMeta | null;
  fields: UiField[];
}
export interface ProjectSummary {
  projectId: string;
  title: string;
  fieldCount: number;
  formSlug: string | null;
  updatedAt: string;
}

// 活跃 project id 管理(镜像 chatSessionClient 的 session-id helper,memProject 兜底)
export function getOrCreateProjectId(): string {
  throw new Error("stub");
}
export function setActiveProjectId(id: string): void {
  throw new Error("stub");
}
export function newProjectId(): string {
  throw new Error("stub");
}

// 项目级工作区 load/save(替代 #76 的 workspace 快照)
export function loadProject(projectId: string): Promise<{ project: ProjectRecord | null }> {
  throw new Error("stub");
}
export function saveProjectWorkspace(
  projectId: string,
  input: ProjectUpsertInput,
): Promise<{ projectId: string; updatedAt: string }> {
  throw new Error("stub");
}
export function listProjects(): Promise<{ projects: ProjectSummary[] }> {
  throw new Error("stub");
}
export function deleteProject(projectId: string): Promise<{ deleted: boolean }> {
  throw new Error("stub");
}
```

### 3.4 前端 `src/core/chatSessionClient.ts`(改 + 废弃)

- **废弃 / 删除**:`WORKSPACE_SNAPSHOT_ID`、`WorkspaceSnapshot`、`WorkspaceSnapshotTurn`、
  `buildWorkspaceSnapshotTurn`、`splitWorkspaceSnapshot`(整段 #76 workspace-snapshot 块)。
  工作区不再骑在 turns_json,改由 §3.3 的项目级 load/save 承载。
  > 迁移期(§2.3)`splitWorkspaceSnapshot` 的纯逻辑可被数据迁移脚本临时复用,但前端契约里删掉。
- `loadChatSession` / `saveChatTurns` / `deleteChatSession`:**增 `projectId` 参数**。
- `listChatSessions(projectId)`:**增 `projectId` 参数**(只列本项目对话)。
- **新增** `renameChatSession(projectId, sessionId, title)`。
- `ChatSessionSummary.title`:语义改为「显式标题优先,缺省回退推导」(类型不变,语义注释更新)。
- session-id helper(`getOrCreateDesignSessionId` 等)**保留**,但语义收窄为「当前**项目下**的
  活跃会话」;新建会话仍 mint 新 session_id,只是现在挂在活跃 project 下。

```ts
export function loadChatSession(
  projectId: string,
  sessionId: string,
): Promise<LoadChatSessionResult> {
  throw new Error("stub");
}
export function saveChatTurns(
  projectId: string,
  sessionId: string,
  input: SaveChatSessionInput,
): Promise<SaveChatSessionResult> {
  throw new Error("stub");
}
export function listChatSessions(projectId: string): Promise<ListChatSessionsResult> {
  throw new Error("stub");
}
export function deleteChatSession(
  projectId: string,
  sessionId: string,
): Promise<DeleteChatSessionResult> {
  throw new Error("stub");
}
export function renameChatSession(
  projectId: string,
  sessionId: string,
  title: string,
): Promise<{ renamed: boolean }> {
  throw new Error("stub");
}
```

### 3.5 前端 `src/core/router.ts`(URL 载体变化,见 §4)

- **新增** `PROJECT_PARAM = "p"` + `readProjectId(search)` / `withProjectId(search, id)`
  (镜像现有 `readSessionId` / `withSessionId`)。
- URL 变为 `?p=<projectId>&s=<sessionId>`(详见 §4 的取舍)。

---

## 4. 已 ship 契约变更清单 + 回归风险

逐条:**现在怎么说 → 改成怎么说 → 影响哪些场景 → 回归风险点**。

### 4.1 §26.2 keying 决策(PR #48)

- **现在**:会话按 `(owner_id, session_id)` keying,`session_id` 是 client-minted、顶层。
- **改成**:加项目层。**项目**按 client-minted `project_id` keying(`(owner_id, project_id)`),
  承载工作区;**会话**按 `(owner_id, project_id, session_id)` keying。理由不变(草稿前无稳定
  表单 id),只是「client-minted 稳定 id」从 session 维度上提为 **project 维度**(session 仍各有
  自己的 client-minted id,只是从属于 project)。
- **影响场景**:`chat-session-persistence.feature` 的「发布后会话仍按同一 session id 续上」→
  改为「发布后**项目**仍按同一 project id 续上,slug 关联到 **project**」。
- **回归风险**:发布关联 slug 的落点从 session 行移到 project 行(`doPublish` 里
  `persistTurn` 带 slug 的那次写,改为写 project)。**漏改会导致发布后 slug 没关联到项目**,
  「我的表单 → 继续编辑」回不到正确项目。

### 4.2 §26.9 多会话(PR #65)

- **现在**:`GET /api/chat/sessions` 列出 owner **全部**会话(全局扁平);title/turnCount 纯运行期
  推导,无 rename。
- **改成**:列表加 `WHERE project_id=?`(只列**本项目**会话);title 优先用 `title` 列、缺省回退
  推导;新增 rename 端点 `PATCH /api/chat/session/:sessionId`(或复用 PUT 带 title 字段——由
  实现定,建议独立 rename 以免和整段 upsert 混)。
- **影响场景**:`chat-multi-session.feature` 的「owner 列出自己的全部会话」→「owner 列出**当前
  项目**的全部会话」;「会话列表只含当前登录账号的会话」→ 再加「且只含当前项目」;**新增**
  「重命名一段会话」「重命名后列表显示新标题」「未命名会话回退到首条 user 消息推导」场景。
- **回归风险**:#65 的隔离测试(A 看不到 B 的会话)仍须绿;现在多一维(A 在项目 X 看不到自己
  项目 Y 的会话)。删除端点的 404 隔离语义保持。

### 4.3 url-state-persistence(PR #76)

- **现在**:`?s=<sessionId>` 单参;刷新恢复「对话 + 工作区」靠 `splitWorkspaceSnapshot` 从
  turns_json 拆出工作区。
- **改成**:URL 升为 **`?p=<projectId>&s=<sessionId>`**(决定如下)。刷新恢复:按 `?p=` 载项目级
  工作区(`loadProject`),按 `?s=` 载该会话对话(`loadChatSession`)。**废弃** workspace 快照路径。
  - **URL 取舍(已定本方案)**:`?p=` 是**主**载体(项目 = 表单 = 可分享/书签的单位),`?s=` 是
    项目内的活跃对话。缺 `?s=` → 退化到该项目最近会话(updated_at DESC)或新建。缺 `?p=` →
    `getOrCreateProjectId` 退化到当前/新建项目(同 §26.2 不报错纪律)。
- **影响场景**:`url-state-persistence.feature` 全部「会话进 URL」场景要补 `?p=` 维度:
  「进入设计器规整 `?p=&s=` 进 URL」「带参刷新恢复**项目工作区** + 会话对话」「切对话改 `?s=`
  但 `?p=` 不变、工作区不动」「切项目改 `?p=`(并落到该项目最近会话)」「后退在**对话**间
  穿梭不串、在**项目**间穿梭工作区跟着换」。
- **回归风险(最高)**:#76 的「乱序到达防护」(load-sequence token)现在要覆盖**两路异步**
  (项目工作区 + 会话对话),且要保证「切对话不重载工作区」(避免无谓闪烁/覆盖)。
  「切项目」与「切对话」是两种不同操作,URL 与重载范围不同,**测试要分别钉死**。
  设置浮层 `/settings/:tab` 与 `?p=&s=` 仍正交共存(原「设置参数与会话参数正交」场景扩成
  三者正交)。

### 4.4 form-editing(载回编辑,PR 既有)

- **现在**:「继续编辑」走 `loadFormForEdit`,编辑态会话 **ephemeral、不写 §26**;塞合成
  「已载入《×》·共 N 字段」note;退出清草稿。
- **改成**:「继续编辑」= **进入该表单对应的项目**(按 `form_slug` 反查 project,或老板的表单
  卡片直接带 project_id)。编辑态**不再 ephemeral**——它就是进了那个项目,对话照常持久化到项目
  下的会话。**去掉**合成「已载入」note(改为载该项目最近会话的真实聊天);若该项目还没有任何
  会话,则**空对话** + 已恢复的工作区(而非合成 note)。
- **影响场景**:`form-editing.feature` 的「编辑期间的对话不污染设计会话持久化」**整条要改/删**
  ——A' 下编辑对话**就该**写进项目的会话(不再隔离)。「把已发布表单载回设计器编辑 → 顶部状态
  横幅」「更新写回保留字段 id」等**保留**(那是 PATCH 写回契约,不受 A' 影响)。
- **回归风险**:`editingFormRef` 现在用来「跳过 §26 持久化」(`persistTurn` 见 editingFormRef
  非空就 skip)。A' 下这套 skip 逻辑要**拆掉**——但要小心别破坏「更新」按钮 dirty 检测与放弃保护
  (那些基于 `editBaseline`,与持久化无关,保留)。**`form_slug` → project 反查若拿不到 project**
  (老数据迁移前的表单)要有兜底:mint 一个新 project、把该 slug 关联上。

### 4.5 SPEC.md 段落

- §26 引言:补「A' 项目层」说明,指明工作区从 turns_json 快照上提到 `projects` 表。
- §26.1 端点矩阵:新增 `GET /api/projects` · `GET/PUT/DELETE /api/projects/:projectId` ·
  `PATCH /api/chat/session/:sessionId`(rename)四到五行;chat session 端点路径不变但语义加
  project 维度。
- §26.2:keying 决策补项目层(如 §4.1)。
- §26.7:`chat_sessions` 列契约加 `project_id` / `title`;**新增 §26.10「`projects` 表结构」**。
- §26.9:列表加 project 过滤 + rename。
- 删掉 §26 引言里 #76 那段「workspace 快照骑 turns_json」的描述(改为指向项目级工作区)。
- §17.1 鉴权矩阵:新项目端点 owner-only 行。

---

## 5. 前端接线变化(App.jsx 等,描述级,不写实现)

- **`projectIdRef`(新)+ `sessionIdRef`(留)**:`projectIdRef` 从 `?p=` 或
  `getOrCreateProjectId()` 解析(镜像现 `sessionIdRef` 从 `?s=` 解析的那段 397–404 行);
  `sessionIdRef` 收窄为「当前项目下的活跃会话」。
- **`modelRef`(canonical 表单模型)**:不再由 `applyRestoredSession` 从会话快照填,改由
  **载项目**(`loadProject`)填;且**工作区写库**从 `persistTurn` 里的
  `buildWorkspaceSnapshotTurn` 改为独立的 `saveProjectWorkspace(projectId, {meta, fields})`
  (工作区变更时 / 回合结束时落项目,与会话 turns 解耦)。
- **`applyRestoredSession`**:删掉 `splitWorkspaceSnapshot` 的工作区还原分支(706–724 行);
  只还原对话 turns + reseed history。工作区由载项目那条路径单独还原。
- **`persistTurn`(1018 行附近)**:不再 `buildWorkspaceSnapshotTurn` + 把快照塞进 input.turns;
  改为两次写:`saveChatTurns(projectId, sessionId, {turns, history})` + (工作区脏时)
  `saveProjectWorkspace`。slug 关联从 session 移到 project。
- **`switchSession`(824 行附近)**:只 `loadChatSession(projectId, id)` 重渲对话 + reseed history、
  改 `?s=`;**不动 `modelRef`/工作区**、不改 `?p=`。这是 A' 的核心行为(切对话工作区不变)。
- **`newChat`(800 行附近)**:`newDesignSessionId()` + 清**对话**(不清工作区);留在当前项目。
  (对比:**新项目** = `newProjectId()` + 清工作区 + 开一条新对话。)
- **`loadFormForEdit`(1091 行)**:改为「进项目」——按 form_slug 解析/关联 project_id、
  `loadProject` 填工作区、`listChatSessions(projectId)` 取最近会话载真实聊天;**删掉**
  1117–1128 行的合成 note + `setMessagesTracked([...])` 字面量。删掉 `editingFormRef` 用来
  跳过持久化的语义(`doExit` / `persistTurn` 里相关分支)。
- **SessionMenu(`src/SessionMenu.jsx`)**:`listChatSessions` 调用带 `projectId`;列表只列本项目
  会话;**新增 rename 入口**(行内编辑 / 菜单项 → `renameChatSession`)。若引入「项目切换器」,
  那是另一个 menu(列 `listProjects`),与 SessionMenu 并列——本期是否做项目切换 UI 由设计另拍
  (去 Claude Design),本文档只钉数据/契约。
- **ConversationThread**:`title` 从静态 `L("对话")` 改为**可编辑**(受控 + onCommit →
  `renameChatSession`)。具体交互(inline edit / 双击 / 菜单)走 DS 组件,设计另拍。
- **router 接线**:reflect URL 处(521 行的 `reflectSessionUrl`)扩成同时反映 `?p=` + `?s=`;
  popstate(591 行附近)区分「project 变」(重载工作区 + 最近会话)与「session 变」(只重载对话)。

---

## 6. 拆分建议(有序 PR)

这重构跨**后端契约 + migration + 数据迁移 + 前端消费 + URL + UI**,**必须拆**,且后端要能与旧
前端**灰度并存**(加列可空、新端点新增不破旧)。建议 **4 根**有序 PR:

### PR-A 后端契约 + schema(契约/迁移先,可灰度)

- 0007 migration:建 `projects` 表 + 给 `chat_sessions` 加 `project_id` / `title` + 新索引
  (全部**可空 / 新增**,不破旧前端)。
- `workers/src/projects.ts`(新数据层)+ `chatSessions.ts` 改签名(增 projectId/title,**旧签名
  保留一版重载或可选参数**以免旧 route 编排断)+ 新增 rename。
- 端点:`/api/projects*` + session rename。
- **done-gate**:新数据层单测 + 端点集成测试绿;**旧 §26/§65 测试仍绿**(旧前端路径不动)。
- **灰度**:此 PR 合后,后端同时支持「带 project_id 的新写」与「不带的旧写」(project_id 可空)。

### PR-B 一次性数据迁移(把老会话各成单对话项目)

- 迁移脚本(§2.3):每行老 `chat_sessions` → mint project、抽 #76 快照工作区写 projects、删快照
  turn、回填 project_id;幂等(只处理 `project_id IS NULL`);**先备份**。
- **done-gate**:在 staging D1 副本上跑通,抽样核对「老会话恢复后工作区与迁移前一致」;脚本幂等
  重跑无副作用。
- **依赖**:PR-A(表/列存在)。**可与 PR-A 同批发**,但脚本执行时机要卡在「PR-C 前端上线前后」
  ——避免旧前端读到已抽走快照的会话(见 §2.3 不可逆性)。

### PR-C 前端 core 契约消费(切到项目级)

- `src/core/projectClient.ts`(新)+ `chatSessionClient.ts`(增 projectId 参数 / rename /
  **删 workspace 快照块**)+ `router.ts`(`?p=` 载体)。
- App.jsx 接线(§5):projectIdRef、载项目填工作区、switchSession 不动工作区、persistTurn 拆两写、
  loadFormForEdit 进项目去合成 note、SessionMenu 带 projectId + rename、ConversationThread
  可编辑标题。
- **done-gate**:`features/` 改后的场景(§4)对应内/外环测试绿;手动 smoke「切对话工作区不变」
  「刷新 `?p=&s=` 完整恢复」「rename 持久化」。
- **依赖**:PR-A(端点)+ PR-B(老数据已迁,前端不会读到带快照的脏会话)。

### PR-D 收尾 / 兼容窗收口

- 删 `chat_sessions.form_slug` 的灰度兼容(若确认 project 已是唯一真相源)+ 删后端旧签名重载。
- 删 `splitWorkspaceSnapshot` / `buildWorkspaceSnapshotTurn` 在迁移脚本里的最后引用。
- **done-gate**:全套测试绿;无对 workspace-snapshot 符号的残留引用。
- **依赖**:PR-C 上线且稳定一段。**可选 / 可延后**——不阻塞功能,只清债。

**依赖序**:PR-A → (PR-B 与 PR-A 同批或紧随) → PR-C → PR-D。
**灰度/兼容并存**:PR-A 后端纯加性,旧前端照跑;PR-B 数据迁移要卡在 PR-C 上线窗口、先备份、幂等;
PR-C 才真正切前端到 A';PR-D 清债可延后。每根都能独立保持 CI 绿(后端测试不依赖前端、反之亦然)。

---

## 附:本方案需要 reviewer / 老板拍板的开放点

1. **URL 用 `?p=&s=` 双 query** vs **路径化**(如 `/p/:projectId?s=`)——本方案选双 query
   (与现有 `?s=` 改动最小、与 `/settings/:tab` 已正交)。
2. **删项目是否级联删其下会话**——本方案建议级联(项目没了对话无处挂),需老板确认数据语义。
3. **rename 用独立 `PATCH /api/chat/session/:sessionId`** vs 复用 PUT 带 title——建议独立。
4. **项目切换 UI**(是否本期做项目列表/切换器)要去 Claude Design 拍;本文档只钉数据 + 契约,
   UI 一律消费 `@agentaily/design-system`。
