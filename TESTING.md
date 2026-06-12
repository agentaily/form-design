# Testing — Agentaily Forms

这个项目**怎么设计测试**:分层、框架技术选型、护栏。和 [`.claude/agents/README.md`](./.claude/agents/README.md) 的双循环 TDD 方法论配套 —— 测试是 `implementer`(内环)/`outer-tester`(外环)把行为契约 [`features/*.feature`](./features) realize 出来、并在护栏上自动拦回归的方式。

> 测试真相源。改测试策略 / 选型 / 护栏 → 同一次改动更新本文件(文档与代码同步纪律)。规格见 [SPEC.md](./SPEC.md)、开发法见 [DEVELOPMENT.md](./DEVELOPMENT.md)、运维见 [OPERATIONS.md](./OPERATIONS.md)。

## 测试分层(海拔:多而快在下,少而真在上)

| 层               | 框架                                              | 测什么                                                                        | 位置                  | 谁写                     | 跑在哪道闸             |
| ---------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------- | ------------------------ | ---------------------- |
| **unit**         | vitest(jsdom)                                     | `src/core` 纯逻辑单元(behavior-styled `describe/it`,AAA;不为每断言写 Gherkin) | `tests/unit/*`        | implementer              | pre-push + CI `verify` |
| **BDD 行为契约** | `@amiceli/vitest-cucumber` ← `features/*.feature` | 系统该做什么(**唯一真相源**)                                                  | `features/`           | spec-architect           | CI `verify`            |
| **integration**  | vitest-cucumber + `@testing-library/react`        | 组件 / 跨模块协作(渲染真组件、断行为)                                         | `tests/integration/*` | outer-tester             | CI `verify`            |
| **e2e**          | Playwright(真 chromium)                           | 用户真实走一遍(build → validate → publish)                                    | `e2e/*`               | outer-tester             | CI `e2e`               |
| **后端 workers** | `@cloudflare/vitest-pool-workers`(真 workerd)     | Workers + D1 后端(`workers/` 子包)                                            | `workers/test/*`      | implementer/outer-tester | CI `workers`           |

## 框架技术选型(为什么这么选)

- **单测 → vitest**:和 Vite 同生态、快、jsdom 跑前端逻辑;`src/core` 是 strict TS、framework-agnostic,单测贴着它。
- **BDD → Gherkin `features/` + `@amiceli/vitest-cucumber`**:行为可执行、business-readable,内外环都对着它 —— 它是契约真相源,不是事后补的测试。
- **集成 → `@testing-library/react/pure`**:渲染真实组件断行为(不是快照 trivia);`/pure` 关掉自动 cleanup,因为 `@amiceli` 把每个 step 当独立 test 跑,需手动在 `AfterEachScenario` 清。
- **e2e → Playwright**:跨浏览器真实路径;本地用系统 Chrome(`channel: "chrome"`),CI 无系统 Chrome → bundled chromium(`PW_USE_BUNDLED=1`)。
- **后端 → `@cloudflare/vitest-pool-workers`**:在**真 workerd** 里跑(不是 mock),D1 用本地 miniflare,最贴近线上 Workers 运行时。

## 护栏(质量门:纵深防御,便宜在前、权威在后)

| 阶段   | 闸                                                                                                      | 拦什么                        |
| ------ | ------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 写时   | plan 模式 + 先写失败测试                                                                                | 方向错 / 实现错               |
| 提交时 | lefthook `pre-commit`:`prettier --write`(staged)+ `typecheck`(改 .ts(x) 时)                             | 格式乱 / 类型错               |
| 推送时 | lefthook `pre-push`:`npm test`(unit+BDD) + `npm run build`                                              | 单测红 / 构建坏               |
| PR 时  | CI 三个**必需检查** `verify`(prettier/typecheck/test/build) · `e2e` · `workers` + 独立 `reviewer` agent | 集成/e2e 回归、后端、设计偏差 |
| 合并时 | branch protection:三必需检查绿 + `enforce_admins`(管理员也守)                                           | 带病进 main                   |

- lefthook 由 `package.json` 的 `"prepare": "lefthook install"` 在 `npm install` 时**自动挂**,新机器零配置。
- `--no-verify` 能跳过本地 hook → 所以**本地是体验(快)、CI 才是权威(不可绕)**,两者都要。
- ⚠️ Version PR 坑:changesets 的 `changeset-release/main` PR 只改版本号,CI 跳重型 step 但 **job 照常报绿**(必需检查不能 pending,否则死锁 auto-merge)——别改成 job 级 skip。

## 本地一条命令验完(done 的定义)

```bash
# 前端
npm run typecheck && npm test && npm run build
# 相关时再跑 e2e
npm run test:e2e            # 或 npm run test:all(vitest + playwright)
# 后端子包
cd workers && npm run typecheck && npm test
```

## 约定 / 坑(this repo)

- 每个外环测试**映射一个 `features/` 场景** —— `loadFeature(path.join(here, "../../features/<name>.feature"))`,匹配 Gherkin 步骤,别断言 trivia。
- 集成测试用 **fake timers + `vi.runAllTimersAsync()`** 驱动脚本化 runner,settle 后用 `getBy*` 断言。
- 文案查询有歧义时**收窄**(`{ exact: true }` 或容器 locator),别让 `getByText` 撞多个。
- Playwright:本地 `channel: "chrome"`、CI `PW_USE_BUNDLED=1`。
- 后端 D1:vitest-pool-workers 自动给本地 miniflare D1;迁移走 `workers/migrations/*.sql`(部署前 `wrangler d1 migrations apply` 自动应用,见 OPERATIONS / deploy-workers.yml)。
