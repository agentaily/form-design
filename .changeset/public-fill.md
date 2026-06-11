---
"agentaily-forms": minor
---

公开填写页 + 数据后台（前端第 6 步，接入收尾）：轻量路由 `/f/:slug` → 答题者拉表单 schema 渲染 + `POST /api/submit` 提交（**无需登录、不带 owner token**，公开页与设计器路由隔离）；owner 在「我的表单」每项「看提交」→ `GET /api/forms/:slug/submissions`（owner Bearer）。至此前端端到端接通：设计 → 发布 → 公开填写 → 数据后台。
