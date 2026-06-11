# Agentaily Forms — Roadmap

> 对话式动态表单设计器：**设计 → 发布 → 收集 → 看结果**。
> 产品规格见 [SPEC.md](./SPEC.md)，运维见 [OPERATIONS.md](./OPERATIONS.md)。

---

## ✅ 已完成

### 前端（`src/`，已上线 https://form-design.agentaily.com）

- 对话式设计器：左 Agent 对话 + 右实时表单预览（MVP 走 `flow.jsx` 脚本）
- 表单工具：`add` / `update` / `remove` / `duplicate` / `reorder` field + 校验
- **markup 指向修改**：hover 高亮预览元素、点击带身份发消息到对话
- Cloudflare Pages + GitHub Actions 自动部署（push main → 自动上线；独立 yarnbcoder 账户）

### 后端（`workers/`，Hono on Cloudflare Workers + D1）

- **MVP（PR #3）**：owner 配置存取（AES-GCM 加密）、DeepSeek LLM 代理（BYOK 流式 SSE）、连接测试、提交写飞书多维表格
- **发布闭环（PR #4）**：表单发布 `POST /api/forms`、公开拉取 `GET /api/forms/:slug`、`/api/submit` 关联 form

> 后端全程双循环 TDD（spec → outer → impl → review），凭据进 vault（DeepSeek key、飞书自建应用）。

---

## 🚧 进行中

- **owner 鉴权**（密码 → session JWT）+ **数据后台**（提交列表 `GET /api/forms/:slug/submissions`） — 分支 `worktree-backend-auth`

---

## 📋 待办

### 后端

- **部署**：`wrangler d1 create` + `secret put`（`CONFIG_KEY` / `OWNER_PASSWORD` / `AUTH_SECRET`）+ `wrangler deploy` + 给 `workers/` 配独立 CI
- 多 owner / 注册（现恒单 owner `default`）
- 数据后台增强：聚合统计、分页、CSV 导出
- 公开端点限流 / 防刷；`parseField` 递归深度上限

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

_进度以各 PR 为准；架构决策见 SPEC.md 对应章节（§12–§18 为后端）。_
