# Agentaily Forms — Roadmap

> 对话式动态表单设计器：**设计 → 发布 → 收集 → 看结果**。
> 产品规格见 [SPEC.md](./SPEC.md)，运维见 [OPERATIONS.md](./OPERATIONS.md)，
> 开发文档（研发驱动范式）见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

---

## ✅ 已完成

### 前端（`src/`，已上线 https://form-design.agentaily.com）

- 对话式设计器：左 Agent 对话 + 右实时表单预览
- **API client 层**（`core/apiClient` + `core/sse`）：fetch 封装 + `VITE_API_BASE` + Bearer token 注入 + SSE 流解析
- **对话接真后端 `POST /api/chat`**：DeepSeek 流式（OpenAI 协议）替换写死脚本；`core/designerLoop` 单回合 ReAct（自愈）+ `core/designerTools`（UI 字段模型工具：set_meta / add / update / remove / duplicate / reorder）；对话引擎对测试可注入
- 表单工具：`add` / `update` / `remove` / `duplicate` / `reorder` field + 校验
- **markup 指向修改**：hover 高亮预览元素、点击带身份发消息到对话（DS `MarkupLayer`，靠 preview 上的 `data-mk-*`）
- **连续发送（缓冲区）**：处理中可继续输入，消息收进缓冲区、下一轮一次性合并处理（SPEC §4.1，`core/queue.ts`；缓冲区 UI 由 DS `ConversationThread` 的 `controller` 渲染）
- **表单校验走 DS `Form.useForm`**：按类型规则（必填 + 邮箱 + 11 位手机号）、提交即定位首个错误、实时纠错（依赖 `@agentaily/design-system` 0.2.0）
- **响应式适配**：≤720px 单列 + 对话/预览分段切换器、头部压缩、分享收成图标；≤380px 仅留 logo
- **设计系统组件全面上移（DS 0.2.0 → 0.6.0，2026-06-12；含两轮向 DS 反馈 seam）**：把本地手搓的页面外壳 / 对话线程 / 账户控件 / 登录 / 集成设置 / 指向修改全部换成上游 DS 组件——`DesignerShell`（双栏外壳 + 拖拽 + 移动端切换）、`ConversationThread`（纯渲染 + `controller`，对接现有 §4.1 `core/queue.ts`，富消息用 `renderTurn` 配 `Reasoning/ToolCall/Suggestions/Message`）、`AccountControl`（账户下拉：我的表单 / 集成设置 / 退出登录）、`SignInPage`（**登录改独立 `/signin` 路由页**，原 `LoginDialog` 弹窗删除；受限操作未登录 → 跳登录页 + 回跳续跑，intent 经 sessionStorage 跨页）、`MarkupLayer`、统一 `Icon`、布局 token `--bar-h/--topbar-h`。删 `src/auth.jsx`/`src/markup.jsx` + 整段手写外壳 / 线程 / markup 的 CSS（app.css 1028→约 560 行）。**集成设置改为独立 `/settings` 路由页**（`src/settings.jsx` = `SettingsScreen`）：DS 纯展示连接卡 `DeepSeekCard` + `FeishuCard` + form-design 自己的保存栏 / **后端 400 逐字回显** / 门禁，接真 BYOK 后端 `core/configClient`（掩码不重交 §12.4、401→/signin、逐连接测试），删 `SettingsDialog`；**`SignInPage` 用上游 `error`/`submitting` seam**、logo 字标光标随 DS 默认（`BrandMark` cursor=false）消失。这两处经**向 DS 反馈两轮 seam**落地（0.5.0：SignInPage error/submitting + IntegrationSettings 受控 seam；0.6.0：集成设置**拆成纯展示连接卡**、删旧 `IntegrationSettings`、BrandMark 默认去光标）。全程经 **claude.ai/design 对话设计 → `design-sync` 落地**，不再手搓（沉淀为全局 skill `design-via-claude-design`；上游发版 + 破坏性变更下游通知流程见 design-system 的 `RELEASE.md`）。
- **DS 升级 0.6 → 0.8（随上游发版流过来，design-sync 落地）**：0.7.0 聊天气泡接 DS `<Markdown>` 渲染（PR #49）；**0.8.0 集成设置区重构为浮层组件链**（PR #51，handoff `IAZjvUx78` + 上游 0.8.0 breaking）——`SettingsPage`（已删）→ `SettingsSheet`（浮层 settings 页骨架）› `IntegrationSettings`（集成分区:hero + 就绪栏 + 连接卡槽，children 模式塞真实接线的 `DeepSeekCard`/`FeishuCard`）+ 底部 `SettingsSaveBar`（显式保存,GitHub 模型,接现有 dirty/save/400 显示）。仍是 **`/settings` 路由 + 真实 BYOK 后端 + 401→/signin** 不变；删 `showUsageCap` 用法、`.s-*`→`.ax-*` 由 DS 内部收敛。范围内只做集成区——**「下拉浮起无路由 + 账户 tab（显示名）+ profile 后端」另拆后续 PR**（用户拍板暂缓）。
- Cloudflare Pages + GitHub Actions 自动部署（push main → 自动上线；独立 yarnbcoder 账户）

### 后端（`workers/`，Hono on Cloudflare Workers + D1）

- **MVP（PR #3）**：owner 配置存取（AES-GCM 加密）、DeepSeek LLM 代理（BYOK 流式 SSE）、连接测试、提交写飞书多维表格
- **发布闭环（PR #4）**：表单发布 `POST /api/forms`、公开拉取 `GET /api/forms/:slug`、`/api/submit` 关联 form
- **鉴权 + 数据后台（PR #5）**：`POST /api/auth/login`（密码 → session JWT）+ `requireAuth` 保护 owner-only 端点、`GET /api/forms/:slug/submissions`（读飞书提交列表）
- **补严**：CORS（白名单跨域）、提交校验（表单状态门 + 必填校验，脏 / 未发布不写飞书）、表单管理 CRUD（`GET /api/forms` 列表 · `PATCH` 改状态 · `DELETE`）、安全收尾（常量时间密码比较、字段递归深度上限、飞书探测 `res.ok`）
- **部署上线（2026-06-11）**：后端已上线 **https://form-design-api.agentaily.workers.dev** —— D1 `form-design-db`（APAC）建库 + 建表、3 个 runtime secret（`CONFIG_KEY`/`AUTH_SECRET`/`OWNER_PASSWORD`）已设、`wrangler deploy` 跑通、独立 CI `deploy-workers.yml`（push main 且 `workers/**` 变更自动部署）。独立 yarnbcoder 账户，Workers+D1 token 与运行时 secret 均进 vault。冒烟测试全绿（health 200 / 公开拉取 404 / 登录对 200 错 401）。详见 [OPERATIONS.md](./OPERATIONS.md) §12。
- **飞书列自动创建 · 自愈（SPEC §15.8）**：`POST /api/submit` 写记录遇目标表缺列（飞书 `code 1254045`）时自动补建缺失列（文本列，重复列 `1254014` 幂等）再重试一次，提交不再因「表里没有对应列」而失败；稳态（列已存在）零额外开销，不预检字段端点。owner 不必再手动在飞书表预建与表单字段同名的列。
- **多租户 / 开放注册（PR #22，已上线）**：单 owner（`OWNER_PASSWORD` + `owner_id='default'`）→ 开放注册多用户——邮箱 + 密码自助注册即成 owner（注册即登录），各自 BYOK 配置 / 表单 / 提交严格隔离。头等约束**横向越权防护**（owner-only 按 slug 操作 `WHERE … AND owner_id=?`，跨 owner → 404 不暴露存在性；公开 submit 按 slug 反查 form 所属 owner 写其飞书）。`password.ts`（PBKDF2 + per-user salt + 常量时间比对 + 防时序枚举）/ `users.ts` / `getFormOwner` / `index.ts` 接线 + 前端 `LoginDialog` 双模。inner + outer 全绿（`tenant-isolation.test.ts` / `tenant-isolation-api.test.ts` 管越权 · `auth-api.test.ts` 走 register/login · `tests/integration/owner-login.spec.jsx`）。详见 SPEC §17。
- **邮箱验证 + 找回密码（PR #26 + #28，2026-06-12 已上线 + 生产端到端验证）**：真实事务邮件走 **Resend**（纯 HTTP、无 SDK，发件域 `mail.agentaily.com` 已验证；`RESEND_API_KEY` 进 Worker secret）。**邮箱软验证**（注册即 best-effort 发验证信、点链接置 `email_verified=1`、不门禁功能；注册去重改**未验证可覆盖 / 已验证锁死**防占座）+ **找回密码**（发起永远 200 防枚举、确认凭一次性 reset token）+ `GET /api/auth/me`（banner 跨刷新拿真状态）。一次性 token 只存 SHA-256、单次、限时（verify 24h / reset 1h，新表 `auth_tokens`）。前端「忘记密码」子态 + `/reset-password` / `/verify-email` 落地页 + 未验证 banner。内外环测试 + 独立评审全过；线上验证：注册→真实验证信 Resend delivered→confirm→`emailVerified=1`。详见 SPEC §22–§24 / §17.2 / §17.12；配方沉淀为全局 skill `email-auth-resend`。
- **飞书列按字段类型预建 + 类型化写值（2026-06-12）**：发布 / 编辑表单时即在 owner 飞书表**按字段 `type` 预建对应类型的列**（数字 / 日期 / 单选 / 多选列,而非一律文本),owner 发布后立刻看到完整且类型正确的结构;**best-effort**(未配飞书 / 连不上 / 建列失败 → 发布仍 `201`、`waitUntil` 后台静默跳过、只记 `err.name` 不记凭据)。提交按列**真实**类型格式化写值(方案 a:先 `listBitableColumns`);§15.8 自愈升级为「按字段 type 建对应类型列」兜底(且缺列按字段映射类型格式化值、摊平 `group` 子字段)。单一真相源 `FIELD_TYPE_TO_BITABLE`。inner + outer 全绿(`feishu-schema.test.ts` + `feishu-typed-columns-api.test.ts` 18 场景)+ 独立评审(揪出并修了 2 个自愈类型/分组 bug)。SPEC §16.8 / §15.8 升级。
- **公开端点限流 / 防刷（2026-06-12）**：4 个公开端点(`POST /api/submit` / `register` / `login` / `password-reset/request`)挂 Cloudflare **KV 固定窗口** per-IP 限流,超限 `429 + Retry-After`,**KV 故障 fail-open**(限流器自己挂了不拖垮正常请求)。护 owner 飞书写额度 + 共享 Resend 免费档(防被刷爆→全员收不到验证/重置信)+ 登录防爆破。键只存 `SHA256(ip)`(不存原始 IP);限额 submit 10/min·100/h、register 5/h、pwreset 4/h、login 10/min;owner-only / `/health` / OPTIONS 不限(§11 各烧自己额度的不限流)。inner + outer 全绿(`ratelimit.test.ts` + `rate-limit-api.test.ts`,证明「429 = handler 不执行」)+ 独立评审 ship。**线上验证**:连打 login → 429 触发(20 连打 10×429)。SPEC §25。**已知局限(best-effort,非铁壁)**:① KV 最终一致性 + 读缓存,连打时会「漏到约 2 倍配额」才挡(SPEC §25.2 容差;miniflare 强一致所以测试没暴露);② per-IP 挡得住「单 IP 一键脚本」,但挡不住分布式/耐心(register 5/h/**IP** × 多 IP / 多时段仍可超 Resend 100/天)。**follow-up / 加固**见待办。
- **改字段标签 → 同步飞书列改名（2026-06-12）**：owner 在设计器改某字段 `label` 再保存 → 系统去飞书把**那一列改名**(而非按新标签新建一列、把旧列连同已收数据丢下/分家)。定位靠字段稳定 `id` 配对 + 旧 `label` 即列名(不建持久映射表);编辑路径 `waitUntil` 里**先改名后预建**(改名后预建看到列已存在即跳过、不重复建);best-effort(未配飞书 / 连不上 / 改名失败 → 编辑仍 `200` 静默跳过、不记凭据)。**v1 只改名**:删字段 → 列保留不动(**绝不删已收数据**)、改类型 → 列不动(§16.8.4 兜值)、排序不同步。inner(`computeFieldRenames` 含同 label / 分组 edge)+ outer(`feishu-column-rename-api.test.ts` 17 场景)全绿 + 独立评审 ship(揪出并修了「旧 schema 同 label 字段漏判改名→丢数据」edge)。SPEC §16.8.7。**follow-up**:删列 / 改类型 / 排序同步、字段 `id`↔飞书 `field_id` 持久映射(比靠旧 label 更扛漂移)、改名+预建合用一次 token/list(现各读一次)。

> 后端全程双循环 TDD（spec → outer → impl → review），凭据进 vault（DeepSeek key、飞书自建应用、CF token、runtime secret、Resend key）。

---

## 🚧 进行中

- **设计对话持久化 + 刷新恢复（PR #48，绑账号）**：把设计器左侧对话（UI 回合 `messages` + LLM 历史 `historyRef`，本只活在浏览器内存、刷新即丢）随聊天写进后端 D1，登录态重载 / 换设备时按原顺序恢复、可继续往下聊。会话按【客户端生成、localStorage 持久化的稳定 `designSessionId`】绑定，键 = `(owner_id, session_id)`（发布前没稳定表单 id，故不按表单 keying；发布只把 slug 关联进会话行，id 不变）。未登录 = 不持久化（沿用现状 401→/signin）；写入按**回合结束批量**整段 `PUT`（绝不每 token）。新增 D1 表 `chat_sessions`（migration `0003`，复合主键）+ owner-only `GET/PUT /api/chat/session/:sessionId`。**已完成**：前端 client（`src/core/chatSessionClient.ts`：`getOrCreateDesignSessionId` / `loadChatSession` / `saveChatTurns` / `toPersistedTurns`）+ App 接线（`src/App.jsx`：登录态 load-on-mount 恢复两份转写、turn-end best-effort save、发布关联 slug）+ 后端（`workers/src/chatSessions.ts` + 路由）；内环单测 + workers API 测试全绿。**待**：outer-tester 的 integration/e2e realize（`features/chat-session-persistence.feature`）+ 评审 + CI 绿后合。SPEC [§26](./SPEC.md)。
- 上一批后端能力（飞书列按类型预建 / **改字段标签同步** / 公开端点限流）均已上线（见「已完成」）。
- **下一步候选（待办）**：飞书增强剩余（`listBitableColumns` >100 列分页、list 故障时降级到无类型写值而非 502、`/submissions` 按 `formSlug` 过滤）、数据后台增强（CSV 导出 / 分页 / 统计）、**限流加固**（小时窗 429 外环补测、双窗 `Retry-After` 取较大值;**Durable Objects 替 KV** 求强一致、精确无漏限流；**全局 Resend 日发送封顶** —— 无论多少 IP，当天总发送够 N 封即停，直接护住 100/天那条线，补 per-IP 挡不住分布式的缺口）。

---

## 📋 待办

### 后端

- 绑自定义域名 `api.form-design.agentaily.com`（可选；现走 `*.workers.dev` 默认域）
- **表单新提交通知（未来，先不做 · 以后再说）**：owner 的表单收到新回复时给 owner 发邮件通知。**必须按天聚合 + 每表单可开关**（默认关）——「每条提交即发」量随访客流量不可控、会冲破 Resend 免费档变贵；按天聚合后量级 = 活跃表单数 × 天，基本恒在免费档内。复用已上线的 Resend 发信基建（见「已完成」邮箱验证条 / 全局 skill `email-auth-resend`），改动落在公开 submit 路径，需配通知开关等产品决策，故单独一轮做。
- 数据后台增强：聚合统计、分页、CSV 导出

### 飞书端到端

- ✅ **端到端已打通（2026-06-12）**：应用用自身 `tenant_access_token` 自建多维表格（绕开「纯 API 应用加不进已有表协作者」的墙）→ `app_token`/`table_id` 配进 `/api/config`；`设计→发布→公开填写→写飞书→数据后台` 全链路在生产验证通过（含真实 UI 填写）。
- ✅ **提交自愈建列**（见上「已完成 · 后端」）——去掉了「owner 须手动预建同名列」这一步。
- ✅ **发布即预建列 + 列类型精确映射（2026-06-12）**：发布 / 编辑表单时即在飞书表按字段 `type` 预建对应类型列（数字 / 单选 / 日期 / 多选列而非一律文本）+ 提交按列真实类型写值 + 自愈升级。见「已完成 · 后端」；SPEC [§16.8](./SPEC.md) + [§15.8 升级](./SPEC.md)。
- 增强（待办）：`/submissions` 按 `formSlug` 过滤（现读整张表，多表单共用一张表会混）。

### 前端接入后端（`src/`，分阶段）

- ✅ API client 层 + 对话接 `POST /api/chat`（真模型流式替换写死脚本）—— 已完成
- ✅ 登录接 `POST /api/auth/login`：`core/auth` 存 session token、owner-only 请求带 Bearer；登录 / 账户弹窗（DS），`401` 自动引导登录 —— **已完成（解锁 `/api/chat`）**
- ✅ 找回密码 + 邮箱验证前端：`LoginDialog`「忘记密码？」子态（中性防枚举）、`/reset-password?token=` 改密落地页、`/verify-email?status=` 结果落地页、设计器「邮箱未验证 · 重新发送」banner（依 `GET /api/auth/me` 真状态、跨刷新权威）—— **已完成**
- ✅ 集成设置 modal 接 `GET/POST /api/config` + `POST /api/config/test`：`settings.jsx`（掩码回显 / 不重交密文 §12.4 / 401 引导登录 / 逐条测连接）+ `core/configClient.ts` —— **已完成**（`integration-settings.spec.jsx` / `app-settings-login.spec.jsx`）
- ✅ 发布 + 表单管理：`forms-panel.jsx` + `PublishFeedback` + `core/formsClient.ts`（发布 `POST /api/forms`、列表 / 改状态 / 删 `GET/PATCH/DELETE /api/forms`）—— **已完成**（`form-publish-mgmt.spec.jsx` / `app-forms-login.spec.jsx`）
- ✅ 公开填写页 + 数据后台：`public-form.jsx`（`/f/:slug` 渲染 + `POST /api/submit`，`core/publicClient.ts`，不带 Bearer）+ `submissions-view.jsx`（`GET /api/forms/:slug/submissions`，`core/submissionsClient.ts`）—— **已完成**（`public-fill.spec.jsx` / `fill-and-submit.spec.jsx` / `data-dashboard.spec.jsx`）

### 产品（SPEC §10 Phase 4）

- 发布态渲染：固定 schema 渲染器（默认）/ 发布时编译快照
- 公开填写页：防刷、防注入、提交落库可视化

---

_进度以各 PR 为准；架构决策见 SPEC.md 对应章节（§12–§21 为后端）。_
