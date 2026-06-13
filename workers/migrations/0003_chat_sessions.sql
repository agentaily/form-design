-- chat_sessions — 设计对话的持久化转写（按 owner + design session 隔离）。
-- 见 SPEC.md §26（后端 · 设计对话持久化 + 刷新恢复）。PR #48。
--
-- 用途：设计器左侧的对话（§4 ReAct loop）本只活在浏览器内存里（messages + historyRef，
--   刷新即丢）。本表把一段设计对话随聊天写进 D1，登录态重载 / 换设备时按原顺序恢复、可继续
--   往下聊。每个 (owner_id, session_id) 一行；回合结束批量整段 PUT upsert（§26.4）。
--
-- keying（§26.2 load-bearing 取舍）：会话按【客户端生成、localStorage 持久化的稳定
--   design session id】绑定，键 = (owner_id, session_id)。发布前没有稳定表单 id（slug 仅
--   发布后才有），所以不按表单 keying；发布只把 slug 关联进 form_slug，session id 不变。
--
-- 隔离（§26.8，沿用 §17.9 纪律）：复合主键 (owner_id, session_id) 让「同一 session id 在
--   不同 owner 名下互不相干」——隔离不靠运行期过滤，靠键本身。GET/PUT 数据层一律
--   WHERE owner_id=? AND session_id=?（owner_id = session JWT 的 sub）。A 即便猜到 B 的
--   session_id 也读不到 B 的对话（查不到 → { session: null }，不暴露 B 有这段对话）。
--
-- 绝不存凭据（§26.6）：turns_json / history_json 只是两份对话转写，绝不承载 DeepSeek key /
--   飞书 secret（那些在 owner_config，§12）。

CREATE TABLE IF NOT EXISTS chat_sessions (
  owner_id     TEXT NOT NULL,    -- owner 的真实 user id（users.id，§17.11）；隔离键
  session_id   TEXT NOT NULL,    -- 客户端生成的稳定 design session id（§26.2）
  turns_json   TEXT NOT NULL,    -- 序列化的 PersistedTurn[]（UI 回合，按原顺序，§26.6）
  history_json TEXT NOT NULL,    -- 序列化的 ChatMessage[]（OpenAI LLM 历史，含 system，§26.6）
  form_slug    TEXT,             -- 发布后关联的 forms.slug（§26.2 软引用）；未发布为 NULL，可空
  created_at   TEXT NOT NULL,    -- ISO-8601，首次写入
  updated_at   TEXT NOT NULL,    -- ISO-8601，每次写入刷新
  PRIMARY KEY (owner_id, session_id)
);

-- 按 owner 列出其全部会话（多会话列表留 follow-up，§26.2；索引先建好为之预留）。
CREATE INDEX IF NOT EXISTS idx_chat_sessions_owner ON chat_sessions (owner_id);
