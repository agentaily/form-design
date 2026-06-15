---
name: chat-session-keying-decision
description: 设计对话持久化按客户端生成的稳定 design session id 绑定(owner_id, session_id),不按表单 id——因为发布前没有稳定表单 id
metadata:
  type: project
---

设计对话持久化(SPEC §26, PR #48)的 keying 决策:会话按【客户端生成、localStorage 持久化的稳定 `designSessionId`】绑定,数据键 = `(owner_id, session_id)`,**不**按表单 id。

**Why:** 发布前没有稳定表单 id——`slug` 仅在 `POST /api/forms` 发布后生成(§16.3),发布前表单模型只在前端 `modelRef.current`。对话先于表单存在(owner 可能还没建字段就开聊),所以不能用表单给会话 keying。客户端生成 id 零往返、未登录也能先持有(只是不写库)、跨刷新稳定。

**How to apply:**

- 发布**不换** session id;只把生成的 slug 关联进会话行(`chat_sessions.form_slug`,软引用、可空、无强外键)。「同一段对话先没表单后发布」始终是同一行。
- 持久化是 owner-only(沿用 §13 `/api/chat` 的门);未登录态 = 不持久化 + 现状 401 引导去 /signin,**不**引入 localStorage 兜底存对话正文(唯一进 localStorage 的是 session id)。
- 存**两份**转写:UI 回合 `PersistedTurn[]`(给人看,chat.jsx 形状) + LLM 历史 `ChatMessage[]`(给模型看,含 system),因为二者形状不同、不能无损互推(§7 已把 chat 与 llmMessages 分开)。
- 写入时机:回合结束批量 `PUT`(整段替换 last-write-wins,单 owner 单消费者 §4.1),绝不每 token 写。
- 多会话(列表/切换)留 follow-up;复合主键已为多行预留。

契约落在:`src/core/chatSessionClient.ts`(类型 + 三个 stub)、`features/chat-session-persistence.feature`、SPEC §26 + §17.1 矩阵新增两行。相关:[[form-design-byok-feishu-architecture]] 同属这套 Cloudflare+D1+owner 隔离后端。
