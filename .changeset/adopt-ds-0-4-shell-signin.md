---
"agentaily-forms": minor
---

设计同步：前端 UI 全面上移到上游 `@agentaily/design-system`（`^0.2.0 → ^0.6.0`）。

把本地手搓的页面外壳 / 对话线程 / 账户控件 / 登录 / 指向修改换成上游组件——`DesignerShell`（双栏外壳 + 拖拽 + 移动端切换）、`ConversationThread`（纯渲染 + `controller`，对接现有 §4.1 `core/queue.ts` MessageQueue，富消息走 `renderTurn`）、`AccountControl`（账户下拉：我的表单 / 集成设置 / 退出登录）、`SignInPage`、`MarkupLayer`、统一 `Icon`、布局 token `--bar-h/--topbar-h`。

**登录从应用内弹窗改为独立 `/signin` 路由页**（`src/signin.jsx` = DS `SignInPage` 接真实 `core/auth`）；未登录触发受限操作会跳转登录页并在回跳后续跑（intent 经 sessionStorage 跨页）。删除 `src/auth.jsx`、`src/markup.jsx` 及整段手写外壳 / 线程 / markup 的 CSS。

**集成设置改为独立 `/settings` 路由页**（`src/settings.jsx` = `SettingsScreen`）：DS 纯展示连接卡 `DeepSeekCard` + `FeishuCard` + form-design 自己的保存栏 / 后端 400 逐字回显 / 门禁，接真 BYOK 后端 `core/configClient`（掩码不重交 §12.4、401→/signin、逐连接测试）；删除本地 `SettingsDialog`。**登录页 `SignInPage` 用上游 `error`/`submitting` seam**，删本地 `.d-signin-error` 浮层兜底。logo 字标光标随 DS 默认（`BrandMark` cursor 默认 false）消失。

这两处经**向 DS 上游反馈两轮 seam**落地：0.5.0 加 `SignInPage` error/submitting + `IntegrationSettings` 受控 seam；0.6.0 进一步把集成设置**拆成纯展示连接卡**（组件零 localStorage/状态/保存/门禁，全归调用方）+ 删除旧 `IntegrationSettings` + `BrandMark` 默认去光标。全程经 claude.ai/design 对话设计 → `design-sync` 落地（见全局 skill `design-via-claude-design`）。
