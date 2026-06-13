---
"agentaily-forms": minor
---

设置浮层(route-reflected overlay)+ 账户 tab(显示名)+ profile 后端 + chrome 逐组件对齐(承接 #51,handoff `IAZjvUx78` 完整版)

把「设置」从独立 `/settings` 路由页改为**设计器内浮起浮层**(`src/settings.jsx` → `SettingsOverlay`,DS 0.8.0 `SettingsSheet` 双 tab:账户 + 集成),叠在设计器之上**不卸载它**。打开浮层经 `history.pushState` **反映 `/settings` URL**,但页面不跳转;✕ / Esc / 浏览器后退关闭并复原进入前的页面状态(**route-reflected overlay,非删路由**)。`App.jsx` 因此不再在路由分流里 branch `/settings`,只用它决定浮层初始开合(deep-link)。

新增**账户 tab**:头像/邮箱 + 可编辑**显示名** + 退出登录。显示名走**真实 profile 后端**,非 localStorage 假桩:

- 新 Worker 端点 `PUT /api/auth/profile`(owner-only,JWT sub):写 `displayName`(trim;空→NULL 清空;> 64 字 → 400),返回与 `/api/auth/me` 同形的 `{ email, emailVerified, displayName }`。
- `GET /api/auth/me` 扩为返回 `displayName`。
- D1 迁移 `workers/migrations/0004_owner_display_name.sql`:`ALTER TABLE users ADD COLUMN display_name TEXT`(可空,空=回退用邮箱)。
- 前端 `core/auth.ts` 加 `updateProfile(displayName)` + `CurrentUser.displayName`;账户表单走 `Form.useForm` + `SettingsSaveBar`(显式保存,`maxLength` 客户端先拦),401 → 引导登录。

逐组件对齐 handoff 的 chrome:账户下拉「集成设置」改插头图标 + 排在「我的表单」之上(带分隔线)、顶栏加 `BrandMark` + 面包屑左对齐、预览区桌面切换换显示器(monitor)图标。集成 tab 的 BYOK 配置/测试/掩码/400 回显接线不变(§12/§14)。SPEC §17.13 / §12 / §14。
