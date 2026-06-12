# 发布手册 · Agentaily Forms

面向**发布/上线**的手册:CI/CD 全景、数据库迁移、运行时 secret、以及每次重大变更的发布清单。日常运维(hooks、本地开发、故障排查、vault 凭据取法)见 [OPERATIONS.md](./OPERATIONS.md);产品/架构规格见 [SPEC.md](./SPEC.md)。

> **一句话**:前端与后端**独立部署**,都靠 push `main` 自动上线;数据库 schema 是声明式真相,数据迁移走 `workers/migrations/` 手动执行。

---

## 0. 发布全景

| 组件             | 部署目标                    | 触发                             | 工作流                  | 线上地址                                      |
| ---------------- | --------------------------- | -------------------------------- | ----------------------- | --------------------------------------------- |
| 前端(`src/`)     | **Cloudflare Pages**        | push `main`                      | `deploy-cloudflare.yml` | https://form-design.agentaily.com             |
| 前端(`src/`)     | GitHub Pages(并行备份)      | push `main`                      | `deploy.yml`            | https://agentaily.github.io/form-design/      |
| 后端(`workers/`) | **Cloudflare Workers + D1** | push `main` 且 `workers/**` 变更 | `deploy-workers.yml`    | https://form-design-api.agentaily.workers.dev |
| 版本/Release     | Git tag + GitHub Release    | push `main`                      | `release.yml`           | —                                             |

> ⚠️ 前端目前**双目标部署**(CF Pages + GitHub Pages 各跑一条)。生产真身是 **CF Pages**(`form-design.agentaily.com`,build 时 `VITE_API_BASE` 指向线上后端);GitHub Pages 那条是历史遗留的并行部署,其构建**不注入** `VITE_API_BASE`,接不到后端。如不再需要,可删 `deploy.yml`(见 §7 待办)。

---

## 1. CI/CD 工作流

全部 Node 22 + `npm ci`,定义在 `.github/workflows/`。

| 工作流                  | 触发                                    | 做什么                                                                                                                                                                   |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ci.yml`                | push `main` / **PR**                    | `verify`:`prettier --check` → `typecheck` → `test`(前端 Vitest)→ `build`;`e2e`:Playwright(bundled chromium,`PW_USE_BUNDLED=1`)。**注:前端 CI,不含 `workers/` 的 vitest** |
| `deploy-cloudflare.yml` | push `main` / 手动                      | `build`(`DEPLOY_BASE=/`、`VITE_API_BASE=线上后端`)→ `pages deploy`。用 secret `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`                                           |
| `deploy-workers.yml`    | push `main` 且 `workers/**` 变更 / 手动 | `cd workers && wrangler deploy`。用 secret `CLOUDFLARE_WORKERS_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`                                                                      |
| `deploy.yml`            | push `main` / 手动                      | 构建发布到 GitHub Pages(见 §0 的双部署说明)                                                                                                                              |
| `release.yml`           | push `main`                             | Changesets:开/更新「Version Packages」PR,或合并后打 tag + 建 GitHub Release                                                                                              |

**关键认知**:

- `deploy-workers.yml` 用 `paths: workers/**` 过滤 —— **只改前端不会触发后端部署**,反之亦然。
- 后端的 vitest(`workers/test/*`)目前**不在 CI 里**自动跑;改 `workers/` 时请本地 `cd workers && npx vitest run` 自查(见 §6 清单)。
- 手动触发:`gh workflow run deploy-workers.yml -R agentaily/form-design`(其余同理)。

---

## 2. 标准发布流程(happy path)

1. **开 PR** → `ci.yml` 跑绿(prettier/typecheck/test/build/e2e)。
2. **合并到 `main`** → 自动:
   - 前端 → CF Pages(+ GitHub Pages)重新构建上线;
   - 若改了 `workers/**` → 后端 `wrangler deploy` 上线。
3. **版本/Release**(可选但建议):`npm run changeset` 写一条变更集随代码提交 → 合并后 `release.yml` 开「Version Packages」PR → 合并它 → 自动打 tag + GitHub Release。

> 不手改版本号/CHANGELOG —— 加 changeset 让机器人来做。详见 OPERATIONS.md §7。

---

## 3. 数据库迁移(D1)

D1 库 `form-design-db`(id `9666fb73-…`)。两类「迁移」分清楚:

### 3.1 Schema(声明式真相)— `workers/schema.sql`

- 全是 `CREATE TABLE IF NOT EXISTS`,**幂等**:重复执行安全,只建缺的表。
- 表:`users`(多用户账号)、`owner_config`(BYOK 凭据,按 owner 隔离)、`forms`(已发布表单,按 owner 隔离)。
- **何时跑**:新增表/列后,对线上库执行一次。
  ```bash
  cd workers
  npx wrangler d1 execute form-design-db --remote --file=schema.sql -y
  ```
- ⚠️ `IF NOT EXISTS` **不会改已存在的表结构**。给已存在的表**加列**,得手写 `ALTER TABLE` 放进 `workers/migrations/`(见下),不能指望改 `schema.sql` 自动生效。

### 3.2 数据迁移 — `workers/migrations/`

有序、一次性的数据/结构变更脚本(命名 `NNN-描述.sql`,`001` 隐含 = 初始 `schema.sql`)。手动按序执行,执行后记录在 CHANGELOG / 本节。

| 脚本                            | 何时                            | 作用                                                                                          |
| ------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `002-migrate-default-owner.sql` | 单租户 → 多用户上线时**一次性** | 把历史 `owner_id='default'` 的 `owner_config` / `forms` 数据转给首个注册的真实 owner(详见 §5) |

执行:

```bash
cd workers
npx wrangler d1 execute form-design-db --remote --file=migrations/002-migrate-default-owner.sql -y
```

> 本地 dev 同理,把 `--remote` 换 `--local`。本地起站见 §6。

---

## 4. 运行时 Secret

三个用 `wrangler secret put` 设(**需 Worker 已部署存在**),值从 vault 经 stdin 灌、不回显(取法见 OPERATIONS.md §12)。

| secret           | 状态          | 用途                                                | 轮换影响                                                                                                                                                 |
| ---------------- | ------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONFIG_KEY`     | ✅ 活跃       | AES-GCM 主密钥,加密 owner 的 DeepSeek/飞书凭据落 D1 | **轮换使已存密文无法解密** —— 换前让 owner 重填配置                                                                                                      |
| `AUTH_SECRET`    | ✅ 活跃       | session JWT(HS256)签名密钥                          | 轮换使所有已签发 token 失效(owner 需重新登录)                                                                                                            |
| `OWNER_PASSWORD` | ⚠️ **已废弃** | (旧)单租户全局登录密码                              | 多用户改造后**不再用于登录** —— 每个 owner 是 `users` 表里的真实行(邮箱 + per-user 密码哈希)。可保留不管,或 `wrangler secret delete OWNER_PASSWORD` 清理 |

本地 `wrangler dev`:secret 放 `workers/.dev.vars`(已 gitignore;throwaway 值,绝非生产密钥)。

---

## 5. 本次发布清单:单租户 → 多用户(一次性)

> 这是把多租户改造推上线的**专属一次性流程**。务必按序,因为迁移脚本要先有真实 user id。

1. **部署后端**(建 `users` 表)。合并到 `main` 自动跑 `deploy-workers.yml`;或手动:
   ```bash
   cd workers && npx wrangler deploy
   npx wrangler d1 execute form-design-db --remote --file=schema.sql -y   # 建 users 表(幂等)
   ```
2. **注册首个账号**(成为承接历史数据的 owner):
   ```bash
   curl -X POST https://form-design-api.agentaily.workers.dev/api/auth/register \
     -H 'content-type: application/json' \
     -d '{"email":"你的邮箱","password":"你的密码(≥8)"}'
   ```
3. **查到该账号的 user id**:
   ```bash
   npx wrangler d1 execute form-design-db --remote \
     --command "SELECT id, email FROM users ORDER BY created_at LIMIT 1"
   ```
4. **填进迁移脚本并执行**:把 `migrations/002-migrate-default-owner.sql` 里的 `REPLACE_WITH_REAL_USER_ID` 换成第 3 步的真实 UUID,然后:
   ```bash
   npx wrangler d1 execute form-design-db --remote --file=migrations/002-migrate-default-owner.sql -y
   ```
5. **验证**:用首个账号登录前端 → 「我的表单」应看到历史已发表单;「集成设置」应看到历史 DeepSeek/飞书配置(掩码回显);旧的 `/f/:slug` 公开链接仍可填。
6. **(可选)清理**:`npx wrangler secret delete OWNER_PASSWORD`。

迁移后:任何人可在 `form-design.agentaily.com` 自助注册成新 owner,各自数据严格隔离(横向越权防护见 SPEC §17.9)。

---

## 6. 发布前自查清单

前端改动:

```bash
npm run format && npm run typecheck && npm test && npm run build   # 全绿
npm run test:e2e                                                   # 真实浏览器(本地需系统 Chrome)
```

后端改动(CI 不自动跑,务必本地跑):

```bash
cd workers && npx vitest run && npx tsc --noEmit                   # 全绿
```

本地端到端起站(真实后端):

```bash
# 后端
cd workers
npx wrangler d1 execute form-design-db --local --file=schema.sql -y   # 首次:灌本地 schema
npx wrangler dev --port 8787 --local                                 # 读 .dev.vars
# 前端(另开一个 shell,仓库根)
VITE_API_BASE=http://localhost:8787 npx vite --port 5173
```

浏览器开 http://localhost:5173 → 注册 → (BYOK 填 DeepSeek/飞书)→ 建表 → 发布 → `/f/:slug` 填写;再注册第二账号验证隔离。

---

## 7. 回滚

- **前端**:`git revert` 那次提交 → push `main`,CF Pages/GH Pages 自动重建。或 CF dashboard 里把 Pages 回退到上一个 deployment。
- **后端**:重新部署上一个绿的提交(`git revert` 后自动触发,或本地 `wrangler deploy` 旧代码)。Workers 也支持 `wrangler rollback`(回退到上一个版本)。
- **数据库**:迁移是**单向前进**的,无自动回滚。`002` 只是改 `owner_id`,真要回退需手写反向 `UPDATE`(把对应 owner 的行改回 `'default'`)—— 谨慎,且仅在确无第二个 owner 写入时安全。

---

## 8. 待办 / 已知项

- **前端双部署**:`deploy.yml`(GitHub Pages)与 `deploy-cloudflare.yml`(CF Pages)并存,生产以 CF Pages 为准。GH Pages 那条不注入 `VITE_API_BASE`、接不到后端,建议择机删除 `deploy.yml`。
- **后端 CI 缺位**:`workers/test/*` 未进 `ci.yml`,改后端靠本地自查。后续可加一个 `working-directory: workers` 的 vitest job。
- **邮箱验证 / 找回密码**:`users.email_verified` 字段与发信钩子已预留(SPEC §17.11),接 Resend 后启用。
