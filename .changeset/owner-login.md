---
"agentaily-forms": minor
---

前端接入后端(第 3 步 · owner 登录):新增 `core/auth`(接 `POST /api/auth/login`,密码 → session token,存入 `apiClient` 的 token store,供 owner-only 请求带 `Authorization: Bearer`;无状态登出 + `isLoggedIn`)。加 owner 登录 / 账户弹窗(`auth.jsx`,全用 `@agentaily/design-system`):未登录态走密码表单、已登录态显示确认 + 登出;顶栏新增账户入口,登录态高亮。对话遇 `401` 时自动弹出登录框引导。**至此 `/api/chat` 在登录后不再 401,对话设计解锁。** 登录函数对测试可注入。
