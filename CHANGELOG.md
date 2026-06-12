# agentaily-forms

## 0.4.1

### Patch Changes

- [#23](https://github.com/agentaily/form-design/pull/23) [`0d82d50`](https://github.com/agentaily/form-design/commit/0d82d50b15c8bd2f91881d2bddbe3deb29a94773) Thanks [@yarnovo](https://github.com/yarnovo)! - 发版机器人组织化:复用组织级 GitHub App `agentaily-release-bot` + 组织级 secret(可见性 selected)开 Version PR 并 auto-merge,新仓接入只需勾两个列表。OPERATIONS.md §7 一次性前置同步为组织级口径。

## 0.4.0

### Minor Changes

- [#13](https://github.com/agentaily/form-design/pull/13) [`62d1881`](https://github.com/agentaily/form-design/commit/62d18810725cb7e8572359a9ff020f38d05e7635) Thanks [@yarnovo](https://github.com/yarnovo)! - 发布 + 表单管理（前端第 5 步）：发布按钮接真 `POST /api/forms`（设计器 meta+fields → 高熵 slug + 公开填写链接 `/f/:slug`），替换 [#8](https://github.com/agentaily/form-design/issues/8) 的本地占位；「我的表单」面板接 `GET/PATCH/DELETE /api/forms` —— 列出表单、改状态（发布↔关闭）、删除（带确认）。owner-only（Bearer），401 引导登录，面板关闭态不发请求。

- [#8](https://github.com/agentaily/form-design/pull/8) [`c10a2cc`](https://github.com/agentaily/form-design/commit/c10a2ccd5ee77f6bdaab24860c405c2760a869f8) Thanks [@yarnovo](https://github.com/yarnovo)! - 前端接入后端(第 1+2 步):新增 API client 层(`core/apiClient` + `core/sse`,fetch 封装 + `VITE_API_BASE` + Bearer token + SSE 流解析),并把对话设计器接到真后端 `POST /api/chat`——用 DeepSeek 流式(OpenAI 协议)替换写死脚本,客户端跑单回合 ReAct(`core/designerLoop`,自愈 + 安全阀)并就地执行 UI 字段模型工具(`core/designerTools`:set_meta / add / update / remove / duplicate / reorder),结果实时渲染到预览。对话引擎对测试可注入。

- [#12](https://github.com/agentaily/form-design/pull/12) [`56f7e85`](https://github.com/agentaily/form-design/commit/56f7e8515d5bc3ab265758550d77a7cc65cd3636) Thanks [@yarnovo](https://github.com/yarnovo)! - 集成设置 modal（前端第 4 步）：owner 配置 DeepSeek key + 飞书凭据 —— 接 `GET/POST /api/config`（掩码回显、未改的密钥不回写）+ `POST /api/config/test`（连接测试逐条显示）。owner-only（Bearer），401 引导登录，关闭态不发请求。

- [#11](https://github.com/agentaily/form-design/pull/11) [`f50816c`](https://github.com/agentaily/form-design/commit/f50816ca73c3f1a21438dc0e82ba7921b97dcc36) Thanks [@yarnovo](https://github.com/yarnovo)! - 前端接入后端(第 3 步 · owner 登录):新增 `core/auth`(接 `POST /api/auth/login`,密码 → session token,存入 `apiClient` 的 token store,供 owner-only 请求带 `Authorization: Bearer`;无状态登出 + `isLoggedIn`)。加 owner 登录 / 账户弹窗(`auth.jsx`,全用 `@agentaily/design-system`):未登录态走密码表单、已登录态显示确认 + 登出;顶栏新增账户入口,登录态高亮。对话遇 `401` 时自动弹出登录框引导。**至此 `/api/chat` 在登录后不再 401,对话设计解锁。** 登录函数对测试可注入。

- [#14](https://github.com/agentaily/form-design/pull/14) [`7e3841c`](https://github.com/agentaily/form-design/commit/7e3841cbcd0493e3a837cb513272ed290dc1229c) Thanks [@yarnovo](https://github.com/yarnovo)! - 公开填写页 + 数据后台（前端第 6 步，接入收尾）：轻量路由 `/f/:slug` → 答题者拉表单 schema 渲染 + `POST /api/submit` 提交（**无需登录、不带 owner token**，公开页与设计器路由隔离）；owner 在「我的表单」每项「看提交」→ `GET /api/forms/:slug/submissions`（owner Bearer）。至此前端端到端接通：设计 → 发布 → 公开填写 → 数据后台。

## 0.3.0

### Minor Changes

- [`af1d64a`](https://github.com/agentaily/form-design/commit/af1d64a2b8b78c29ee144ae5636cbaaf40ccec61) Thanks [@yarnbcoder-lgtm](https://github.com/yarnbcoder-lgtm)! - 新增「指向修改」元素定位:在预览里 hover 高亮某个元素并显示其身份(label · kind),点击后输入修改要求,以 `〔label · kind〕…` 前缀直接发送到左侧 Agent 对话——精确定位,不必再用文字描述「右侧那个提交按钮」。顶栏 logo 同步为真正的 Agentaily mark(角标 + 光标方块)。

## 0.2.0

### Minor Changes

- [`c907a6e`](https://github.com/agentaily/form-design/commit/c907a6e6b96b73843f9dc3a603dce43246e0cd32) Thanks [@yarnbcoder-lgtm](https://github.com/yarnbcoder-lgtm)! - Add duplicate-field: clone a field (fresh ids, deep copy) via the duplicate_field tool.

- [`c186edb`](https://github.com/agentaily/form-design/commit/c186edb0b97d71a51bca7944935d0be6cdc631b5) Thanks [@yarnbcoder-lgtm](https://github.com/yarnbcoder-lgtm)! - Tooling & ops: TypeScript `src/core`, Vitest (TDD) + Gherkin BDD + Playwright E2E, lefthook git hooks, Prettier, GitHub CI, GitHub Pages deploy, Changesets-based versioning, and a root OPERATIONS.md.
