# Agentaily Forms — Roadmap

> 对话式动态表单设计器：**设计 → 发布 → 收集 → 看结果**。
> 产品规格见 [SPEC.md](./SPEC.md)，运维见 [OPERATIONS.md](./OPERATIONS.md)，
> 研发驱动范式见 [METHODOLOGY.md](./METHODOLOGY.md)。

---

## ✅ 已完成

### 前端（`src/`，已上线 https://form-design.agentaily.com）

- 对话式设计器：左 Agent 对话 + 右实时表单预览
- **API client 层**（`core/apiClient` + `core/sse`）：fetch 封装 + `VITE_API_BASE` + Bearer token 注入 + SSE 流解析
- **对话接真后端 `POST /api/chat`**：DeepSeek 流式（OpenAI 协议）替换写死脚本；`core/designerLoop` 单回合 ReAct（自愈）+ `core/designerTools`（UI 字段模型工具：set_meta / add / update / remove / duplicate / reorder）；对话引擎对测试可注入
- 表单工具：`add` / `update` / `remove` / `duplicate` / `reorder` field + 校验
- **markup 指向修改**：hover 高亮预览元素、点击带身份发消息到对话
- **连续发送（缓冲区）**：处理中可继续输入，消息收进缓冲区、下一轮一次性合并处理（SPEC §4.1，`core/queue.ts` + 顶部 DS `Queue` 组件）
- **表单校验走 DS `Form.useForm`**：按类型规则（必填 + 邮箱 + 11 位手机号）、提交即定位首个错误、实时纠错（依赖 `@agentaily/design-system` 0.2.0）
- **响应式适配**：≤720px 单列 + 对话/预览分段切换器、头部压缩、分享收成图标；≤380px 仅留 logo
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

> 后端全程双循环 TDD（spec → outer → impl → review），凭据进 vault（DeepSeek key、飞书自建应用、CF token、runtime secret、Resend key）。

---

## 🚧 进行中

- 后端核心 + **多租户/开放注册** + **邮箱鉴权（验证 / 找回密码）** + **飞书端到端** 均**已上线**（见「已完成」）。当前推进方向是**待办**里的**前端接入剩余三块**（集成设置 modal / 发布 + 表单管理 / 公开填写页 + 数据后台接后端）与**飞书增强**（预建列 / 列类型映射 / 按 `formSlug` 过滤）。

---

## 📋 待办

### 后端

- 绑自定义域名 `api.form-design.agentaily.com`（可选；现走 `*.workers.dev` 默认域）
- **表单新提交通知（未来，先不做 · 以后再说）**：owner 的表单收到新回复时给 owner 发邮件通知。**必须按天聚合 + 每表单可开关**（默认关）——「每条提交即发」量随访客流量不可控、会冲破 Resend 免费档变贵；按天聚合后量级 = 活跃表单数 × 天，基本恒在免费档内。复用已上线的 Resend 发信基建（见「已完成」邮箱验证条 / 全局 skill `email-auth-resend`），改动落在公开 submit 路径，需配通知开关等产品决策，故单独一轮做。
- 数据后台增强：聚合统计、分页、CSV 导出
- 公开端点限流 / 防刷

### 飞书端到端

- ✅ **端到端已打通（2026-06-12）**：应用用自身 `tenant_access_token` 自建多维表格（绕开「纯 API 应用加不进已有表协作者」的墙）→ `app_token`/`table_id` 配进 `/api/config`；`设计→发布→公开填写→写飞书→数据后台` 全链路在生产验证通过（含真实 UI 填写）。
- ✅ **提交自愈建列**（见上「已完成 · 后端」）——去掉了「owner 须手动预建同名列」这一步。
- 增强（待办）：发布表单时即在飞书表**预建**列（owner 发布后立刻看到完整列结构）、列类型按字段 `type` 精确映射（数字 / 单选 / 日期列，而非一律文本）、`/submissions` 按 `formSlug` 过滤（现读整张表，多表单共用一张表会混）。

### 前端接入后端（`src/`，分阶段）

- ✅ API client 层 + 对话接 `POST /api/chat`（真模型流式替换写死脚本）—— 已完成
- ✅ 登录接 `POST /api/auth/login`：`core/auth` 存 session token、owner-only 请求带 Bearer；登录 / 账户弹窗（DS），`401` 自动引导登录 —— **已完成（解锁 `/api/chat`）**
- ✅ 找回密码 + 邮箱验证前端：`LoginDialog`「忘记密码？」子态（中性防枚举）、`/reset-password?token=` 改密落地页、`/verify-email?status=` 结果落地页、设计器「邮箱未验证 · 重新发送」banner（依 `GET /api/auth/me` 真状态、跨刷新权威）—— **已完成**
- 集成设置 modal 接 `GET/POST /api/config` + `POST /api/config/test`
- 发布 + 表单管理：`POST /api/forms` 发布；列表 / 改状态 / 删 用 `GET/PATCH/DELETE /api/forms`
- 公开填写页 + 数据后台：`GET /api/forms/:slug` 渲染 + `POST /api/submit` 提交；`GET /api/forms/:slug/submissions` 看提交

### 产品（SPEC §10 Phase 4）

- 发布态渲染：固定 schema 渲染器（默认）/ 发布时编译快照
- 公开填写页：防刷、防注入、提交落库可视化

---

_进度以各 PR 为准；架构决策见 SPEC.md 对应章节（§12–§21 为后端）。_
