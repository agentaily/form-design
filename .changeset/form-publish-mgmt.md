---
"agentaily-forms": minor
---

发布 + 表单管理（前端第 5 步）：发布按钮接真 `POST /api/forms`（设计器 meta+fields → 高熵 slug + 公开填写链接 `/f/:slug`），替换 #8 的本地占位；「我的表单」面板接 `GET/PATCH/DELETE /api/forms` —— 列出表单、改状态（发布↔关闭）、删除（带确认）。owner-only（Bearer），401 引导登录，面板关闭态不发请求。
