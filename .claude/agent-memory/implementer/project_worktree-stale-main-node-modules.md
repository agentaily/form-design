---
name: worktree-stale-main-node-modules
description: form-design worktree 无自有 node_modules 时会向上解析到主 checkout 的过期依赖，build/集成测试假红
metadata:
  type: project
---

form-design 的 `.claude/worktrees/<pr>/` 若没跑过 `npm ci`，顶层 **没有自己的 node_modules**；node/vite 会沿目录树向上解析到**主 checkout** `/Users/yarnb/agentaily/form-design/node_modules` —— 而主 checkout 的依赖可能**滞后于 worktree 的 package-lock.json**。

**这次现象：** worktree lockfile 锁 `@agentaily/design-system@0.10.0`，但主 checkout 装的是 **0.6.0**。结果 `npm run build` 报 `"Markdown" is not exported by @agentaily/design-system`（chat.jsx 引的 0.10 新导出在 0.6 里没有），大批 `tests/integration/*.spec.jsx` 因 `ConversationThread`/DS 组件 = `undefined` 而崩。**这些都不是源码 bug** —— 是依赖漂移的假红（[[local-dep-drift-false-red]] 的 worktree 版）。

**Why:** worktree 共享主仓 .git，但 node_modules 不是 git 跟踪物；不在 worktree 里单独装，就吃主仓的（可能旧的）那份。

**How to apply:**

- 在 worktree 里 build/跑前端测试**假红**且报「DS 某导出缺失 / 组件 undefined」时，先 `grep '"version"' node_modules/@agentaily/design-system/package.json` 对比 worktree `package-lock.json` 锁的版本——不一致就是漂移。
- 修法：在 **worktree 目录**跑 `npm ci`（只填 worktree 自己的 node_modules，不碰主 checkout 源码）。postinstall 的 `lefthook install` 会因 worktree 的 git hooksPath 冲突报错失败，但**包已装好**，build/test 不受影响，可忽略。
- 装完 worktree 顶层 node_modules 后，之前给 `workers/node_modules` 做的软链可能被覆盖，按 [[form-design-worktree-workers-node-modules]] 重新软链主仓 `workers/node_modules`。
- 别用 `--no-verify` 或改源码去「绕」这种假红；先核实是版本漂移。
