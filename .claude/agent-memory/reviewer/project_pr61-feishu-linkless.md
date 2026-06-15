---
name: pr61-feishu-linkless-uncommitted
description: PR-4 (pr61 飞书 link-less) 的实现是未提交工作树改动,不是 commit;审查要 diff HEAD 而非 origin/main
metadata:
  type: project
---

审 PR-4(分支 `autopilot/fd-feishu-linkless`,worktree `pr61`)时:**真正的实现改动在未提交的工作树里**(`git diff HEAD`,20 个文件),分支上唯一的 commit `cc8e1da` 只是空工单(manager git-plumbing 造的 ticket 提交)。

**Why:** `git diff origin/main..HEAD` 只显示 DS 降级 + `.sb-tablewrap` sticky CSS —— 那是因为本分支基于 merge-base `9b184e2`(早于 #63),而 origin/main 已合了 #63(撤 sticky 兜底 + bump DS ^0.10.1)。这个 diff 是 #63 落 main 未落本分支造成的**噪音**,跟 PR-4 无关。差点据此误判「PR-4 实现不存在」。

**How to apply:** 审这类 autopilot 工单分支,先 `git status` 看工作树,实现在未提交改动里就 `git diff HEAD` 审;别只信 `git diff origin/main`。落地前 implementer 需:(1) rebase 到含 #63 的 origin/main(避免把 sticky 兜底/DS 降级带回),(2) 把工作树改动正式 commit。相关:[[d1-submissions-architecture-turn]]。
