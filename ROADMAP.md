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

> 后端全程双循环 TDD（spec → outer → impl → review），凭据进 vault（DeepSeek key、飞书自建应用、CF token、runtime secret）。

---

## 🚧 进行中

- 后端核心已补严完整 **且已部署上线**；下一步是待办里的 **前端接入** 与 **飞书端到端**
- **多租户 / 开放注册（实现体 + 单测已落，outer-loop 待 re-align）**：从单 owner（`OWNER_PASSWORD` + `owner_id='default'`）改造为开放注册的多用户——邮箱 + 密码自助注册即成 owner（注册即登录、先不验证邮箱），各自 BYOK 配置 / 表单 / 提交严格隔离。头等约束是**横向越权防护**（owner-only 的按 slug 操作 `WHERE ... AND owner_id=?`，跨 owner → 404 不暴露存在性；公开 submit 按 slug 反查 form 所属 owner 写其飞书）。**已实现**：`password.ts`（PBKDF2-HMAC-SHA256 + per-user salt + 常量时间比对）、`users.ts`（createUser/findUserByEmail/authenticateUser，含假 hash 防时序枚举）、`getFormOwner`、`index.ts` 接线（公开 `POST /api/auth/register` + 改 `POST /api/auth/login` 查 users 表、所有 owner-only handler `ownerId=session.sub` 贯穿、submissions 归属门 404、submit 反查 form owner）、前端 `LoginDialog` 双模登录/注册（DS Tabs）。inner-loop 单测全绿（`password.test.ts` / `users.test.ts` / `tenant-isolation.test.ts` + 前端 `auth.test.js`）。**待 outer-tester**：把 `*-api.test.ts` + `test/helpers.ts` 的 login 从 `OWNER_PASSWORD` re-align 成注册/登录，并实现 `tenant-isolation.feature` / `auth.feature` / `owner-login.feature` 场景。详见 SPEC §17。

---

## 📋 待办

### 后端

- 绑自定义域名 `api.form-design.agentaily.com`（可选；现走 `*.workers.dev` 默认域）
- 多 owner / 注册 —— 已挪到「进行中」（spec 就绪，待实现，详见 SPEC §17）
- 邮箱验证（`email_verified` 已预留恒 0、发信钩子预留不启用）+ 改密 / 找回密码
- 数据后台增强：聚合统计、分页、CSV 导出
- 公开端点限流 / 防刷

### 飞书端到端

- ✅ **端到端已打通（2026-06-12）**：应用用自身 `tenant_access_token` 自建多维表格（绕开「纯 API 应用加不进已有表协作者」的墙）→ `app_token`/`table_id` 配进 `/api/config`；`设计→发布→公开填写→写飞书→数据后台` 全链路在生产验证通过（含真实 UI 填写）。
- ✅ **提交自愈建列**（见上「已完成 · 后端」）——去掉了「owner 须手动预建同名列」这一步。
- 增强（待办）：发布表单时即在飞书表**预建**列（owner 发布后立刻看到完整列结构）、列类型按字段 `type` 精确映射（数字 / 单选 / 日期列，而非一律文本）、`/submissions` 按 `formSlug` 过滤（现读整张表，多表单共用一张表会混）。

### 前端接入后端（`src/`，分阶段）

- ✅ API client 层 + 对话接 `POST /api/chat`（真模型流式替换写死脚本）—— 已完成
- ✅ 登录接 `POST /api/auth/login`：`core/auth` 存 session token、owner-only 请求带 Bearer；登录 / 账户弹窗（DS），`401` 自动引导登录 —— **已完成（解锁 `/api/chat`）**
- 集成设置 modal 接 `GET/POST /api/config` + `POST /api/config/test`
- 发布 + 表单管理：`POST /api/forms` 发布；列表 / 改状态 / 删 用 `GET/PATCH/DELETE /api/forms`
- 公开填写页 + 数据后台：`GET /api/forms/:slug` 渲染 + `POST /api/submit` 提交；`GET /api/forms/:slug/submissions` 看提交

### 产品（SPEC §10 Phase 4）

- 发布态渲染：固定 schema 渲染器（默认）/ 发布时编译快照
- 公开填写页：防刷、防注入、提交落库可视化

---

_进度以各 PR 为准；架构决策见 SPEC.md 对应章节（§12–§21 为后端）。_
