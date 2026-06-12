# 发布手册 · Agentaily Forms

面向**发布/上线**的手册:CI/CD 全景、数据库迁移、运行时 secret、以及每次重大变更的发布清单。日常运维(hooks、本地开发、故障排查、vault 凭据取法)见 [OPERATIONS.md](./OPERATIONS.md);产品/架构规格见 [SPEC.md](./SPEC.md)。

> **一句话**:前端与后端**独立部署**,都靠 push `main` 自动上线;schema 迁移(`workers/migrations/`)随部署由 `wrangler d1 migrations apply` 自动上,一次性数据 backfill(`workers/runbooks/`)手动跑。

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

| 工作流                  | 触发                                    | 做什么                                                                                                                                                                                                                     |
| ----------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                | push `main` / **PR**                    | 三个 job:`verify`(`prettier --check` → `typecheck` → `test` 前端 Vitest → `build`)、`e2e`(Playwright bundled chromium,`PW_USE_BUNDLED=1`)、`workers`(后端子包 `typecheck` + vitest;**无 path filter,每个 PR 都跑**,#20 起) |
| `deploy-cloudflare.yml` | push `main` / 手动                      | `build`(`DEPLOY_BASE=/`、`VITE_API_BASE=线上后端`)→ `pages deploy`。用 secret `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`                                                                                             |
| `deploy-workers.yml`    | push `main` 且 `workers/**` 变更 / 手动 | **先** `d1 migrations apply --remote`(自动建/改表)**再** `wrangler deploy`。用 secret `CLOUDFLARE_WORKERS_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`                                                                             |
| `deploy.yml`            | push `main` / 手动                      | 构建发布到 GitHub Pages(见 §0 的双部署说明)                                                                                                                                                                                |
| `release.yml`           | push `main`                             | Changesets:开/更新「Version Packages」PR,或合并后打 tag + 建 GitHub Release                                                                                                                                                |

**关键认知**:

- `deploy-workers.yml` 用 `paths: workers/**` 过滤 —— **只改前端不会触发后端部署**,反之亦然。
- 后端 vitest(`workers/test/*`)由 `ci.yml` 的 `workers` job 在**每个 PR** 跑(无 path filter,#20 起),与前端一道作为分支保护必需检查 —— 后端改动不会再漏测。
- 手动触发:`gh workflow run deploy-workers.yml -R agentaily/form-design`(其余同理)。

---

## 2. 标准发布流程(happy path)

1. **开 PR** → `ci.yml` 跑绿(prettier/typecheck/test/build/e2e)。
2. **合并到 `main`** → 自动:
   - 前端 → CF Pages(+ GitHub Pages)重新构建上线;
   - 若改了 `workers/**` → 后端先 `d1 migrations apply` 自动迁移 schema,再 `wrangler deploy` 上线。
3. **版本/Release**(可选但建议):`npm run changeset` 写一条变更集随代码提交 → 合并后 `release.yml` 开「Version Packages」PR → 合并它 → 自动打 tag + GitHub Release。

> 不手改版本号/CHANGELOG —— 加 changeset 让机器人来做。详见 OPERATIONS.md §7。

---

## 3. 数据库迁移(D1)

D1 库 `form-design-db`(id `9666fb73-…`)。**Schema 演进走 wrangler 迁移(自动),数据 backfill 走 runbook(手动)**,两类分清楚。

### 3.1 Schema 迁移 — `workers/migrations/*.sql`(自动)

- **机制**:wrangler 官方 `d1 migrations`。`migrations/` 下按编号排序的 `.sql`(如 `0001_initial_schema.sql`),由 `wrangler d1 migrations apply` 按序、幂等应用,并在 `d1_migrations` 表里记「哪些跑过了」—— 重复 apply 是 no-op。
- **自动**:`deploy-workers.yml` 在每次部署**前**自动 `wrangler d1 migrations apply --remote`(expand-first:schema 就绪了新代码才上)。「代码上了、表没建」那种洞由此堵死。
- **当前迁移**:`0001_initial_schema.sql` —— `users` / `owner_config` / `forms` 三表(均 `CREATE TABLE IF NOT EXISTS`,故首次 apply 到已有表也安全)。
- **加一条迁移**(含改列):
  ```bash
  cd workers
  npx wrangler d1 migrations create form-design-db "add xxx column"  # 生成 migrations/000N_add_xxx_column.sql
  # 编辑该文件写 ALTER TABLE …(改列也走这里,不再受 CREATE TABLE IF NOT EXISTS 改不了已存在表的限制)
  npx wrangler d1 migrations apply form-design-db --local            # 本地验证
  # push → CI 在部署前自动 apply --remote
  ```
- **测试**:`workers/test/helpers.ts` 把 `migrations/*.sql` 灌进 miniflare D1(与 prod 同一份 schema)。新增 schema 迁移后,在该文件的 `SCHEMA_MIGRATIONS` 数组追加一行 import。

### 3.2 数据 backfill — `workers/runbooks/*.sql`(手动)

一次性的**数据**搬迁(非 schema)。**不**进 `migrations/`、**不**被 CI 自动跑 —— 它们常依赖运行时参数(如某账号的 user id)、且只跑一次。手动按 runbook 执行,执行后在文件头标注状态。

| runbook                     | 何时                                         | 作用                                                                                       |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `migrate-default-owner.sql` | 单租户 → 多用户上线(✅ 已于 2026-06-12 执行) | 把历史 `owner_id='default'` 的 `owner_config` / `forms` 转给首个注册 owner(`yarnb@qq.com`) |

执行(模板,把占位换成真实 user id 后):

```bash
cd workers
npx wrangler d1 execute form-design-db --remote --file=runbooks/<name>.sql -y
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

> ✅ **已于 2026-06-12 完成**(首个账号 `yarnb@qq.com`,迁了 1 config + 4 forms)。留作记录 + 同类 bootstrap 的模板。按序执行,因为数据 backfill 要先有真实 user id。
>
> 注:**当时 schema 是手动 `wrangler d1 execute --file=schema.sql` 建的**;本 PR 起 schema 已改由 `deploy-workers.yml` 的 `d1 migrations apply` 自动建,下面第 1 步已更新为新方式。

1. **部署后端** → 合并到 `main` 自动跑 `deploy-workers.yml`:**先** `wrangler d1 migrations apply --remote`(建 `users` 表等 schema)**再** `wrangler deploy`。无需手动建表。
2. **注册首个账号**(成为承接历史数据的 owner)—— 直接在 `form-design.agentaily.com` 注册,或:
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
4. **填进 runbook 并执行**:把 `runbooks/migrate-default-owner.sql` 里的 `REPLACE_WITH_REAL_USER_ID` 换成第 3 步的真实 UUID,然后:
   ```bash
   npx wrangler d1 execute form-design-db --remote --file=runbooks/migrate-default-owner.sql -y
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

后端改动(CI 的 `workers` job 也会跑,本地先自查更快):

```bash
cd workers && npx vitest run && npx tsc --noEmit                   # 全绿
```

本地端到端起站(真实后端):

```bash
# 后端
cd workers
npx wrangler d1 migrations apply form-design-db --local   # 首次:按迁移建本地 schema
npx wrangler dev --port 8787 --local                      # 读 .dev.vars
# 前端(另开一个 shell,仓库根)
VITE_API_BASE=http://localhost:8787 npx vite --port 5173
```

浏览器开 http://localhost:5173 → 注册 → (BYOK 填 DeepSeek/飞书)→ 建表 → 发布 → `/f/:slug` 填写;再注册第二账号验证隔离。

---

## 7. 回滚

- **前端**:`git revert` 那次提交 → push `main`,CF Pages/GH Pages 自动重建。或 CF dashboard 里把 Pages 回退到上一个 deployment。
- **后端**:重新部署上一个绿的提交(`git revert` 后自动触发,或本地 `wrangler deploy` 旧代码)。Workers 也支持 `wrangler rollback`(回退到上一个版本)。
- **数据库**:迁移是**单向前进**的,无自动回滚。schema 迁移要回退需写一条新的反向迁移(如 `DROP COLUMN`);数据 backfill(如 `runbooks/migrate-default-owner.sql` 把 `owner_id` 从 `default` 改走)要回退需手写反向 `UPDATE` —— 谨慎,且仅在确无新 owner 写入时安全。

---

## 8. 待办 / 已知项

- **前端双部署**:`deploy.yml`(GitHub Pages)与 `deploy-cloudflare.yml`(CF Pages)并存,生产以 CF Pages 为准。GH Pages 那条不注入 `VITE_API_BASE`、接不到后端,建议择机删除 `deploy.yml`。
- ~~后端 CI 缺位~~:已解决 —— #20 给 `ci.yml` 加了 `workers` job(后端 typecheck + vitest,无 path filter,每个 PR 都跑)。
- **邮箱验证 / 找回密码**:`users.email_verified` 字段与发信钩子已预留(SPEC §17.11),接 Resend 后启用。
