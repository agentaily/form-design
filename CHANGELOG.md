# agentaily-forms

## 0.8.1

### Patch Changes

- [#41](https://github.com/agentaily/form-design/pull/41) [`6044e4d`](https://github.com/agentaily/form-design/commit/6044e4d30a56a57baae4afb802d533426c6bdea4) Thanks [@yarnovo](https://github.com/yarnovo)! - fix(ratelimit): 限流计数键编进 windowSeconds，根治 submit 整点边界「分钟/小时双窗相撞」误限

  `POST /api/submit` 同时挂了分钟（60s / 10）与小时（3600s / 100）两个固定窗口。KV 计数键原为
  `rl:<bucket>:<hash(ip)>:<windowStart>`，**键里不含窗口长度**。当墙钟落在整点后头一分钟内
  （`now % 3600 < 60`）时，分钟窗的 `floor(now/60)*60` 与小时窗的 `floor(now/3600)*3600` 都等于
  该整点时刻，两窗口的 `windowStart` 撞成同一个值 → 共用一个计数键 → 每次提交被**双计** → 分钟
  限额（10）在第 ~5 次真实提交就被打满、误回 429。线上约 1.67% 概率（每小时头一分钟）偶发误限，
  也是 `workers/test/rate-limit-api.test.ts` 那组 submit 测试 flaky（`expected 429 not to be 429`）的根因。

  修复：计数键追加 `windowSeconds` 段 → `rl:<bucket>:<hash(ip)>:<windowStart>:<windowSeconds>`，让分钟桶
  与小时桶即便 `windowStart` 相同也落不同键、互不串计。行为契约（`features/rate-limit.feature`）不变，
  新增一条针对整点边界相撞的确定性回归单测。SPEC §25.3。

## 0.8.0

### Minor Changes

- [#37](https://github.com/agentaily/form-design/pull/37) [`930d655`](https://github.com/agentaily/form-design/commit/930d6558f6f681fd82ca59cefdc11779145875c9) Thanks [@yarnovo](https://github.com/yarnovo)! - 设计同步：前端 UI 全面上移到上游 `@agentaily/design-system`（`^0.2.0 → ^0.6.0`）。

  把本地手搓的页面外壳 / 对话线程 / 账户控件 / 登录 / 指向修改换成上游组件——`DesignerShell`（双栏外壳 + 拖拽 + 移动端切换）、`ConversationThread`（纯渲染 + `controller`，对接现有 §4.1 `core/queue.ts` MessageQueue，富消息走 `renderTurn`）、`AccountControl`（账户下拉：我的表单 / 集成设置 / 退出登录）、`SignInPage`、`MarkupLayer`、统一 `Icon`、布局 token `--bar-h/--topbar-h`。

  **登录从应用内弹窗改为独立 `/signin` 路由页**（`src/signin.jsx` = DS `SignInPage` 接真实 `core/auth`）；未登录触发受限操作会跳转登录页并在回跳后续跑（intent 经 sessionStorage 跨页）。删除 `src/auth.jsx`、`src/markup.jsx` 及整段手写外壳 / 线程 / markup 的 CSS。

  **集成设置改为独立 `/settings` 路由页**（`src/settings.jsx` = `SettingsScreen`）：DS 纯展示连接卡 `DeepSeekCard` + `FeishuCard` + form-design 自己的保存栏 / 后端 400 逐字回显 / 门禁，接真 BYOK 后端 `core/configClient`（掩码不重交 §12.4、401→/signin、逐连接测试）；删除本地 `SettingsDialog`。**登录页 `SignInPage` 用上游 `error`/`submitting` seam**，删本地 `.d-signin-error` 浮层兜底。logo 字标光标随 DS 默认（`BrandMark` cursor 默认 false）消失。

  这两处经**向 DS 上游反馈两轮 seam**落地：0.5.0 加 `SignInPage` error/submitting + `IntegrationSettings` 受控 seam；0.6.0 进一步把集成设置**拆成纯展示连接卡**（组件零 localStorage/状态/保存/门禁，全归调用方）+ 删除旧 `IntegrationSettings` + `BrandMark` 默认去光标。全程经 claude.ai/design 对话设计 → `design-sync` 落地（见全局 skill `design-via-claude-design`）。

- [#39](https://github.com/agentaily/form-design/pull/39) [`5572a9c`](https://github.com/agentaily/form-design/commit/5572a9c8334329494d2afb8b6573e94676d76866) Thanks [@yarnovo](https://github.com/yarnovo)! - feat(feishu): 改字段标签 → 同步改飞书对应列名(不新建列、不丢数据)

  owner 在设计器里把某字段的 `label` 改了再保存,系统就去 owner 的飞书多维表格把**那一列改名** —— 而不是像以前那样按新标签**新建一列**、把旧列连同已收数据丢下(数据分家)。

  - **定位**:编辑时按字段稳定 `id` 配对「旧/新」字段定义(`id` 不变、`label` 变 = 改名);旧 `label` 即飞书那列现在的名字,据此定位、调飞书 `PUT .../fields/{field_id}` 改名(带回列原 type,只改名不改类型)。不引入持久映射表。
  - **顺序**:编辑 `waitUntil` 里**先改名、后预建**(改名后预建看到列已存在即跳过,绝不按新 label 重复建列)。
  - **best-effort**:owner 未配飞书 / 连不上 / 改名失败 → 编辑仍 `200`、静默跳过(只记 `err.name`、不记凭据)。冲突(撞名 / 旧列找不到 / 单条失败)逐项跳过、互不影响。
  - **v1 范围**:只改名。删字段 → 飞书那列**保留不动**(绝不删已收数据);改类型 / 排序不同步(留 follow-up)。

  SPEC §16.8.7 + `features/feishu-column-rename.feature`。

## 0.7.0

### Minor Changes

- [#34](https://github.com/agentaily/form-design/pull/34) [`74e2f8c`](https://github.com/agentaily/form-design/commit/74e2f8c7f2119a92d9775781a4b76261ca614550) Thanks [@yarnovo](https://github.com/yarnovo)! - feat(ratelimit): 公开端点限流 / 防刷(KV 固定窗口,超限 429 + Retry-After,fail-open)

  给 4 个公开端点加按 IP 的限流,在 BYOK 架构下堵住「匿名访客刷爆共享资源」的口子:

  - **`POST /api/submit`**:10/分钟 + 100/小时(护 owner 飞书写额度)。
  - **`POST /api/auth/register`**:5/小时;**`POST /api/auth/password-reset/request`**:4/小时(护那把**共享 Resend key**——被刷一波打满免费档,全员收不到验证/重置信)。
  - **`POST /api/auth/login`**:10/分钟(防密码爆破)。

  实现:Cloudflare **KV 固定窗口**计数,键 `rl:<bucket>:<SHA256(ip)>:<windowStart>`(**只存 IP 的哈希,不存原始 IP**),超限回 `429 { error }` + `Retry-After`,**KV 故障 fail-open**(限流器自身故障不拖垮正常请求)。挂在 `cors()` 之后、绝不碰 owner-only / `/health` / OPTIONS 预检;`/api/chat` 烧 owner 自己 DeepSeek 额度,不限。SPEC §25 + `features/rate-limit.feature`。

## 0.6.0

### Minor Changes

- [#32](https://github.com/agentaily/form-design/pull/32) [`557a31e`](https://github.com/agentaily/form-design/commit/557a31ea1ab1d851fe73ae2741ceb6b6d99ac135) Thanks [@yarnovo](https://github.com/yarnovo)! - feat(feishu): 发布即按字段类型在飞书预建对应列 + 提交按列类型写值

  - **发布 / 编辑表单即预建列**:发布(`POST /api/forms`)/ 编辑(`PATCH …/:slug` 改 fields)时,按字段 `type` 在 owner 飞书多维表格预建对应类型的列(数字 / 日期 / 单选 / 多选列,而非一律文本),owner 发布后立刻看到完整且类型正确的结构。
  - **best-effort**:owner 未配飞书 / 飞书连不上 / 换 token 失败 / 建列失败 → 发布仍 `201`,预建经 `waitUntil` 后台静默跳过(只记 `err.name`、绝不记凭据)。
  - **提交按列真实类型写值**:`POST /api/submit` 先 `listBitableColumns` 拿每列真实类型再格式化值(数字→number、日期→毫秒戳、多选→数组),兜旧文本列 / 类型漂移;脏数字 / 坏日期省略该格不整条失败。
  - **自愈升级**:§15.8 自愈从「一律文本列」升级为「按字段 `type` 建对应类型列」,且缺列按字段映射类型格式化值、摊平 `group` 子字段。
  - 单一真相源 `FIELD_TYPE_TO_BITABLE`(建列与写值共用);SPEC §16.8 / §15.8 升级。

## 0.5.1

### Patch Changes

- [#28](https://github.com/agentaily/form-design/pull/28) [`d26b2b2`](https://github.com/agentaily/form-design/commit/d26b2b2fb3b31aa2391f1fa52feece54df505bec) Thanks [@yarnovo](https://github.com/yarnovo)! - fix(auth): 验证邮件确认链接指向 worker 自身 origin,而非前端域

  注册 / 重发的验证邮件里 `verify-email/confirm` 链接此前拼成 `APP_BASE_URL`(前端域 `form-design.agentaily.com`)+ `/api/...`,但该确认端点在 worker 上、前端站不 serve `/api`,点开是死链(落到 SPA fallback、验证不了)。改用请求自身 origin(`new URL(c.req.url).origin`)——链接 host 必须是浏览器能到达本 API 的那个 host,将来绑自定义域也自动跟随。reset 邮件指向前端落地页,仍用 `APP_BASE_URL`(正确)。加回归断言锁住验证链接 host。

## 0.5.0

### Minor Changes

- [#26](https://github.com/agentaily/form-design/pull/26) [`b5db68b`](https://github.com/agentaily/form-design/commit/b5db68b9af610ffdca755825045d2540abc8a9f8) Thanks [@yarnovo](https://github.com/yarnovo)! - feat: 邮箱注册验证 + 找回密码,真实发信接入 Resend

  - **注册软验证**:注册即 best-effort 发验证邮件(发信失败不挂注册),点链接置 `email_verified=1`,不门禁功能;前端「邮箱未验证 · 重新发送」banner 依 `GET /api/auth/me` 真状态、跨刷新权威。
  - **找回密码**:发起永远 200 防邮箱枚举、确认凭一次性 reset token 重置密码;前端 `/reset-password` 落地页。
  - **防占座别人邮箱**:注册去重改为「未验证可覆盖 / 已验证锁死」。
  - 一次性 token 只存 SHA-256、单次使用、限时(verify 24h / reset 1h),新表 `auth_tokens`(D1 migration 0002)。
  - 发信走 Resend 纯 HTTP API(无 SDK),已验证发件域 `mail.agentaily.com`,`RESEND_API_KEY` 走 Worker secret。

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
