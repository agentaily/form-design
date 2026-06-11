# Agentaily Forms — Roadmap

> 对话式动态表单设计器：**设计 → 发布 → 收集 → 看结果**。
> 产品规格见 [SPEC.md](./SPEC.md)，运维见 [OPERATIONS.md](./OPERATIONS.md)。

---

## ✅ 已完成

### 前端（`src/`，已上线 https://form-design.agentaily.com）

- 对话式设计器：左 Agent 对话 + 右实时表单预览（MVP 走 `flow.jsx` 脚本）
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

> 后端全程双循环 TDD（spec → outer → impl → review），凭据进 vault（DeepSeek key、飞书自建应用）。

---

## 🚧 进行中

- 后端核心已补严完整；下一步是待办里的 **部署** 与 **前端接入**

---

## 📋 待办

### 后端

- **部署**：`wrangler d1 create` + `secret put`（`CONFIG_KEY` / `OWNER_PASSWORD` / `AUTH_SECRET`）+ `wrangler deploy` + 给 `workers/` 配独立 CI
- 多 owner / 注册（现恒单 owner `default`）
- 数据后台增强：聚合统计、分页、CSV 导出
- 公开端点限流 / 防刷

### 飞书端到端

- 建多维表格 + 给应用开 `bitable` 读写权限 + 发布（可能需管理员审批）→ `app_token` / `table_id` 配进 `/api/config`

### 前端接入后端（`src/`，单独一期）

- `flow.jsx` 接 `/api/chat`（真模型替换写死脚本）
- 集成设置 modal 接 `/api/config` + `/api/config/test`
- 提交接 `/api/submit`；公开填写页接 `GET /api/forms/:slug`
- 数据后台 UI 接 `GET /api/forms/:slug/submissions`
- 登录页接 `/api/auth/login`

### 产品（SPEC §10 Phase 4）

- 发布态渲染：固定 schema 渲染器（默认）/ 发布时编译快照
- 公开填写页：防刷、防注入、提交落库可视化

---

_进度以各 PR 为准；架构决策见 SPEC.md 对应章节（§12–§21 为后端）。_
