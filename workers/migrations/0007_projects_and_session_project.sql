-- projects + chat_sessions.project_id / title — 「项目 ↔ 对话」状态模型 A'。
-- 见 SPEC.md §26（后端 · 设计对话持久化）/ docs/refactor-project-conversation.md §2。PR-A。
--
-- 用途（A' 模型）：一个「表单」= 一个「项目」。项目是容器，承载一份**共享的**工作区模型
--   （meta + fields）；项目下可开多条对话（会话），它们编辑同一份表单。切对话只换左侧聊天线索，
--   右侧工作区不变。现状（§26 + #76）里「工作区快照骑在每条会话的 turns_json」与此意图相反，
--   A' 把工作区上提到**项目级**，落进新 `projects` 表。
--
-- 本 migration（PR-A）**纯加性、只建结构、不迁数据**：建 `projects` 表 + 给 `chat_sessions`
--   加 `project_id` / `title` 两个**可空**列 + 复合索引。SQLite/D1 的 ALTER TABLE ADD COLUMN
--   不支持给非空表加 NOT NULL 无默认列，故两列物理可空、靠应用层保证逻辑非空（灰度兼容：旧前端
--   不带 project_id 写入 → 绑 NULL，照常工作）。把老会话各自迁成单对话项目的**一次性数据迁移**
--   见 PR-B（要 parse turns_json、按 sentinel id 抽快照，不能在纯 SQL 里干净完成）。
--
-- keying / 隔离（沿用 §26.8 纪律）：projects 复合主键 (owner_id, project_id)，project_id 是
--   client-minted UUID（crypto.randomUUID，高熵不可猜）；隔离靠键本身、不靠运行期过滤。
--   form_slug 从 session 行上移到 project 行——一个项目一份表单一个 slug（软引用，可空，无强外键）。

-- 项目（= 一份表单的容器，承载项目级工作区）。meta_json / fields_json 可空（owner 进项目还没建
-- 字段就能存在一个空项目，正是 §26.2 keying 不绑表单 slug 的同一根本原因，只是上提到项目）。
CREATE TABLE IF NOT EXISTS projects (
  project_id  TEXT NOT NULL,    -- client-minted UUID（A'.1）；草稿期即生成，不依赖表单 slug
  owner_id    TEXT NOT NULL,    -- owner 真实 user id（users.id，§17.11）；隔离键
  meta_json   TEXT,             -- 序列化 FormMeta（title / description）；空项目可 NULL
  fields_json TEXT,             -- 序列化 UiField[]（项目级工作区字段）；空项目可 NULL
  form_slug   TEXT,             -- 发布后软引用 forms.slug；未发布 NULL，可空，无强外键
  created_at  TEXT NOT NULL,    -- ISO-8601，首次写入
  updated_at  TEXT NOT NULL,    -- ISO-8601，每次写入刷新（列表按它 DESC 排）
  PRIMARY KEY (owner_id, project_id)
);

-- 按 owner 列出其全部项目（项目切换器），用 idx_projects_owner。
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_id);

-- 给 chat_sessions 加 project_id（会话归属项目；回填后逻辑上 NOT NULL，物理可空靠应用层保证）。
ALTER TABLE chat_sessions ADD COLUMN project_id TEXT;
-- 可编辑会话标题；NULL → 运行期回退到 §26.9 推导（首条 user 消息截断）。
ALTER TABLE chat_sessions ADD COLUMN title TEXT;

-- 按 (owner_id, project_id) 列出本项目的会话（会话列表只列当前项目，§2.4）。
CREATE INDEX IF NOT EXISTS idx_chat_sessions_owner_project ON chat_sessions (owner_id, project_id);
