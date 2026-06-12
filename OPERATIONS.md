# 运维手册 · Agentaily Forms

对话式表单设计器（前端应用）的运维与协作手册。产品/架构规格见 [SPEC.md](./SPEC.md)，使用说明见 [README.md](./README.md)。

---

## 0. 速查

| 项       | 值                                                                    |
| -------- | --------------------------------------------------------------------- |
| 线上地址 | https://agentaily.github.io/form-design/                              |
| 仓库     | https://github.com/agentaily/form-design                              |
| 默认分支 | `main`                                                                |
| 本地开发 | `npm install && npm run dev` → http://localhost:5173                  |
| 部署方式 | push 到 `main` → GitHub Actions 构建并发布到 GitHub Pages（无需手动） |
| 包性质   | **私有应用**（`private: true`），不发布到 npm                         |

---

## 1. 这是什么

- **应用本体**（`src/`）：左对话 / 右表单预览的设计器。当前对话是**写死的脚本**（`src/flow.jsx`），不是真 LLM。
- **SPEC 核心**（`src/core/`，TypeScript）：按 [SPEC.md](./SPEC.md) 实现的、与框架无关的可测核心——VFS、schema、工具执行器、消息队列、srcdoc 渲染、Agent loop。是接入真模型时的地基。
- **设计系统**：所有 UI 来自已发布的 npm 包 [`@agentaily/design-system`](https://github.com/agentaily/design-system)，上游更新自动跟随。

---

## 2. 本地开发

```bash
npm install          # 安装依赖；postinstall 的 prepare 会装好 git hooks
npm run dev          # 开发服务器 http://localhost:5173
```

### npm 脚本一览

| 脚本                      | 作用                                                    |
| ------------------------- | ------------------------------------------------------- |
| `dev`                     | Vite 开发服务器（base `/`）                             |
| `build`                   | 生产构建到 `dist/`（base `/form-design/`，给 Pages 用） |
| `preview`                 | 本地预览生产构建                                        |
| `typecheck`               | `tsc --noEmit`（仅类型检查 `src/core`）                 |
| `format` / `format:check` | Prettier 写入 / 校验                                    |
| `test`                    | Vitest：单元 + 集成（jsdom，集成层实现 `features/`）    |
| `test:watch`              | Vitest watch                                            |
| `test:e2e`                | Playwright 端到端（真实浏览器）                         |
| `test:all`                | Vitest + Playwright                                     |
| `changeset`               | 新增一条变更集（版本/changelog 用）                     |

---

## 3. Git Hooks（lefthook）

`prepare` 脚本在 `npm install` 时自动 `lefthook install`。配置见 [`lefthook.yml`](./lefthook.yml)。

| 钩子           | 动作                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| **pre-commit** | 对暂存文件跑 `prettier --write` 并重新暂存；改动了 `.ts` 时跑 `typecheck` |
| **pre-push**   | 跑 `test`（Vitest）+ `build`                                              |

- 手动跑：`npx lefthook run pre-commit`。
- 临时跳过（应急）：`git commit --no-verify` / `git push --no-verify`。请少用。

---

## 4. 测试

**BDD 是方法论，不是一个分层。** `features/` 是全局行为规格（Gherkin 活文档），各测试层级只是在不同高度去*实现*这些行为(双环 TDD:BDD/验收外环 + 单元 TDD 内环)。「行为」和「层级」是两条正交的轴。

- **`features/`**：全局行为规格（`*.feature`，Given/When/Then）。系统该做什么的唯一真相,各层引用它。
- **`tests/unit/`**：内环单元测试,覆盖每个 `src/core` 模块 + 原型纯逻辑。行为风格 `describe/it`,**不套 Gherkin**(给微观断言套 feature 高仪式低收益)。
- **`tests/integration/`**：组件 & 跨模块测试,用 `@amiceli/vitest-cucumber` + Testing Library _实现_ features(搭表单、填写校验提交、Agent 自愈)。
- **`e2e/`**：Playwright 在真实浏览器实现 feature 场景(搭表单 → 校验 → 发布)。
  - 本地默认用系统 Chrome（`channel: "chrome"`，无需下载）。
  - 没有系统 Chrome（如 CI）：`PW_USE_BUNDLED=1` + `npx playwright install --with-deps chromium`。

> 写新测试的顺序:先在 `features/` 写/找到对应行为 → 再在合适的层级(unit / integration / e2e)实现它。单元测试保持行为命名即可,不必每条都配 `.feature`。

---

## 5. CI/CD 工作流

`.github/workflows/`，全部用 Node 22 + `npm ci`。

| 工作流        | 触发               | 做什么                                                                                                       |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `ci.yml`      | push `main` / PR   | `verify` job：`prettier --check` → `typecheck` → `test` → `build`；`e2e` job：Playwright（bundled chromium） |
| `deploy.yml`  | push `main` / 手动 | 构建并发布到 GitHub Pages                                                                                    |
| `release.yml` | push `main`        | Changesets：开 / 更新「Version Packages」PR，或在其合并后打 tag + 建 GitHub Release                          |

---

## 6. 部署到 GitHub Pages

- **机制**：`deploy.yml` 跑 `npm run build` → `upload-pages-artifact`（`dist/`）→ `deploy-pages`。
- **base 路径**：站点在 `https://agentaily.github.io/form-design/` 子路径下，所以 `vite.config.js` 在 `build` 时设 `base: "/form-design/"`，否则 JS/CSS 会 404。
- **Pages 配置**：Source = GitHub Actions（已开启）。
- **手动触发**：Actions → "Deploy app to Pages" → Run workflow，或 `gh workflow run deploy.yml`。

---

## 7. 版本与发布（Changesets）

本仓库是**私有应用，不发 npm**。Changesets 在这里只管 **版本号 + CHANGELOG + GitHub Release**；应用的「上线」是 Pages 部署。配置见 [`.changeset/config.json`](./.changeset/config.json)（`privatePackages.tag/version` 开启，所以私有包也能打 tag）。

**日常流程**

1. 改动值得记录时：`npm run changeset` → 选 patch/minor/major + 写一行摘要 → 把 `.changeset/*.md` 跟代码一起提交。
2. 合到 `main` 后 `release.yml` 自动开一个 **「Version Packages」PR**（消费 changeset、bump `package.json`、写 `CHANGELOG.md`）。
3. 合并那个 PR → `release.yml` 跑 `changeset tag` 打 tag 并创建 **GitHub Release**。

> 不要手改版本号或 changelog——加 changeset，让机器人来做。
>
> 一次性前置：仓库 Settings → Actions → General 需允许「Allow GitHub Actions to create and approve pull requests」，否则 Version PR 开不出来。

---

## 8. 故障排查

| 症状                          | 多半是                 | 处理                                                                  |
| ----------------------------- | ---------------------- | --------------------------------------------------------------------- |
| Pages 打开白屏 / 资源 404     | base 路径不对          | 确认 `vite.config.js` 的 `base` 是 `/form-design/`；改仓库名要同步改  |
| Playwright 本地报找不到浏览器 | 没系统 Chrome          | 设 `PW_USE_BUNDLED=1` 并 `npx playwright install chromium`            |
| pre-push 卡住/失败            | `test` 或 `build` 没过 | 本地先 `npm test && npm run build` 修绿；勿习惯性 `--no-verify`       |
| `prettier --check` 在 CI 红   | 没格式化               | 本地 `npm run format` 后再提交                                        |
| Version PR 没出现             | Actions 无建 PR 权限   | 开启上面第 7 节的 PR 权限设置                                         |
| 设计系统组件样式丢失          | 没 import 样式         | 确认 `src/main.jsx` 里 `import "@agentaily/design-system/styles.css"` |

---

## 9. 常见运维任务 Cookbook

```bash
# 跑全部检查（提交前自查）
npm run format && npm run typecheck && npm test && npm run build

# 端到端（真实浏览器）
npm run test:e2e

# 新增一条变更集
npm run changeset

# 手动触发部署 / 查看运行
gh workflow run deploy.yml
gh run list --limit 5
gh run watch <run-id>

# 本地预览生产构建（注意 base 是 /form-design/）
npm run build && npm run preview
```

---

## 10. 设计同步（Claude Design → 代码）

设计稿在 Claude Design 里迭代，用 **`design-sync` 技能**（用户级，`~/.claude/skills/design-sync/`）把每次 handoff 同步进本仓库，**不覆盖本地工程改动**。

- **机制**：三方合并 —— `base`（上次同步的基线，存在 `.design-baseline/`）↔ `new`（新 handoff）↔ `local`（当前实现）。只把 `base→new` 真正变化的设计增量映射进来；`local` 独有的东西（`src/core` TS、`tests/`、CI、lefthook/changeset、tweak 过的默认值、消费 npm 包而非内联 `_ds`）原样保留；落到本地改动上的冲突会先问、不静默覆盖。
- **基线**：`.design-baseline/`（git-ignored，含 `BASELINE.md` 记录来源 URL/design id/日期）。每次成功同步后由技能覆盖更新。
- **怎么用**：把新的 `https://api.anthropic.com/v1/design/h/<id>` 链接发给我，或自己 `/design-sync`。设计系统组件用法走 `agentaily-design` 技能 + `@agentaily/design-system` 包，不重新内联 `_ds_bundle.js`。

---

## 11. 关键约定回顾

- **代码格式**由 Prettier 统一（printWidth 100）；`SPEC.md` 不被格式化（见 `.prettierignore`）。
- **`src/core` 是 TypeScript 且 strict**；应用 UI 仍是 JSX 原型。
- **UI 一律复用** `@agentaily/design-system`，不手写组件。
- **不自建后端**：真模型走 BYOK 浏览器直连，答题数据走托管 BaaS（详见 SPEC.md §8）。
- **发布即部署**：push `main` 自动上 Pages；版本/Release 由 Changesets 管。

---

## 12. 后端运维（Workers + D1）

后端是 `workers/` 子包（Hono on Cloudflare Workers + D1），与前端**独立部署**。规格见 SPEC.md §12–§21；**发布/迁移流程见 [RELEASE.md](./RELEASE.md)**。

### 速查

| 项            | 值                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| 线上 API      | **https://form-design-api.agentaily.workers.dev**                                                                  |
| 健康检查      | `GET /health` → 200                                                                                                |
| CF 账户       | yarnbcoder@gmail.com（account_id `e6ce8ba3…`，与前端 Pages 同账户）                                                |
| Worker 名     | `form-design-api`（workers.dev 子域名 `agentaily`）                                                                |
| D1 数据库     | `form-design-db`（id `9666fb73-…`，APAC，表 `users` / `owner_config` / `forms`）                                   |
| 部署凭据      | vault `credentials/cloudflare-yarnbcoder-workers-deploy`（Workers Scripts:Edit + D1:Edit + Account Settings:Read） |
| 运行时 secret | vault `credentials/form-design-workers-runtime`（`CONFIG_KEY` / `AUTH_SECRET`；`OWNER_PASSWORD` 已废弃）           |
| 资源台账      | vault `resources/cloudflare/worker/form-design-api`、`resources/cloudflare/d1/form-design-db`                      |

### CI/CD

`.github/workflows/deploy-workers.yml`：push `main` 且 `workers/**`（或本 workflow）变更时自动 `wrangler deploy`。
用 GitHub secret **`CLOUDFLARE_WORKERS_API_TOKEN`**（独立于 Pages 的 `CLOUDFLARE_API_TOKEN`）+ 共享 `CLOUDFLARE_ACCOUNT_ID`。手动触发：`gh workflow run deploy-workers.yml -R agentaily/form-design`。

### 本地手动部署 / 运维

在 `workers/` 内，凭据从 vault 内联取（明文不进上下文）：

```bash
cd workers && npm ci
export CLOUDFLARE_API_TOKEN="$(jq -r .values.api_token ~/.claude/skills/vault/data/credentials/cloudflare-yarnbcoder-workers-deploy.json)"
export CLOUDFLARE_ACCOUNT_ID="e6ce8ba37ac129ecb40227f2025d4fa6"

npx wrangler deploy                                              # 部署
npx wrangler d1 execute form-design-db --remote --file=schema.sql -y   # 重建/迁移表
npx wrangler secret list                                        # 查 secret（不显值）
npx wrangler tail                                               # 实时日志
```

### Secret 管理

运行时 secret 用 `wrangler secret put`（**需 Worker 已部署存在**），值从 vault 经 stdin 灌入、不回显：

```bash
jq -r .values.config_key ~/.claude/skills/vault/data/credentials/form-design-workers-runtime.json \
  | npx wrangler secret put CONFIG_KEY
# AUTH_SECRET 同理（vault key: auth_secret）
```

- `CONFIG_KEY`：AES-GCM 主密钥，加密 owner 的 DeepSeek/飞书凭据落 D1。**轮换会使已存密文无法解密**——换前需让 owner 重填配置。
- `AUTH_SECRET`：session JWT（HS256）签名密钥。轮换会让所有已签发 token 失效（owner 需重新登录）。
- ~~`OWNER_PASSWORD`~~：**已废弃**（多用户改造后不再用于登录，每个 owner 是 `users` 表里的真实行）。可保留不管或 `wrangler secret delete OWNER_PASSWORD` 清理。详见 [RELEASE.md](./RELEASE.md) §4。

### 故障排查

| 症状                                  | 多半是                       | 处理                                                                                                                 |
| ------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 部署报 `workers.dev subdomain` 未注册 | 账户首次用 Workers           | dashboard 打开 Workers & Pages 落地页自动建，或 `PUT /accounts/:id/workers/subdomain`                                |
| `secret put` 报 script not found      | Worker 还没部署              | 先 `wrangler deploy` 再设 secret                                                                                     |
| owner-only 端点 401                   | 缺/过期 JWT                  | 先 `POST /api/auth/login`（`{email,password}`）拿 token，再带 `Authorization: Bearer`；无账号先 `/api/auth/register` |
| 提交不写飞书                          | 表单未发布 / 必填缺 / 配置缺 | 查表单 status、必填项、owner `/api/config`（app_token/table_id）                                                     |
