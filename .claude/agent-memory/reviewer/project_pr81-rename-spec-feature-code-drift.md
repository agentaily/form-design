---
name: pr81-rename-spec-feature-code-drift
description: PR #81 (A' PR-A) rename 端点的 SPEC/feature/code 三方漂移 + data-layer 签名漂移 + stale base 复活已删文件
metadata:
  type: project
---

PR #81(A' 「项目↔对话」重构 PR-A,后端契约 + 0007 migration)审查发现一组 doc-code 漂移,**代码+测试自洽且更优,但 SPEC/feature 文本与之矛盾**:

1. **rename 的 `updated_at` 语义反了**:SPEC §26.9(SPEC.md:2162)说 rename「顺带刷 `updated_at`」,但 `renameChatSession`(chatSessions.ts)**故意不刷** updated_at(rename 不该顶列表顺序),API 测试 `projects-api.test.ts` "DOES NOT reorder the list" 还断言了不刷。代码对、SPEC 文本错。
2. **清空 title 行为反了**:SPEC §26.9(SPEC.md:2164)+ feature 场景「把会话标题清空后回退到推导标题」说空/null title→写 NULL→回退推导;但 PATCH route 对空/whitespace title **返回 400「title 不能为空」**,API 测试也断言 400。该 feature 场景描述的是**代码未实现**的行为(且与测试冲突)。
3. **data-layer 签名漂移**:SPEC §26.9 数据层契约段写 `deleteChatSession(db, ownerId, projectId, sessionId)` / `renameChatSession(db, ownerId, projectId, sessionId, title)`(projectId 当**前置必填**位),但实现是 **projectId 可选 trailing 参**(`deleteChatSession(db, ownerId, sessionId, projectId?)`)。验收铁律要的就是「可选 trailing」(旧调用方零回归),所以**代码对、SPEC 段落措辞错**。

**Why:** 这是 [[conn-test-spec-vs-feature-drift]] 同类——改后端契约的 PR 易让 SPEC/feature 文本与最终实现漂移。本根验收铁律明确要 doc-code 同步(§5)。

**How to apply:** 审 form-design 后端契约 PR,grep SPEC 对应小节的「数据层契约」段 + feature 场景,逐字比实现的函数签名/错误码/字段语义;别只看端点矩阵那几行。三方(SPEC 散文 / feature 场景 / code+test)有一方不一致就报,优先信 code+test(它们自洽且能跑)。

**另:stale base 复活已删文件** — pr81 分支 merge-base = a8ee2d4(在 #82 之前),#82 删了 `.claude/agents/pr-analyst.md`,本分支树里仍有它 → 直接合会复活该文件、revert #82。合前必 rebase 到当前 origin/main(同 [[rerebase-before-finalize-fleet-main-advances]])。

**✅ 本 PR 已全部收口(worker 收尾,非未决项):** 三处漂移按「优先信 code+test」对齐了 SPEC/feature —— rename 改为「不刷 updated_at」、空 title 改为「→400 不落库」(feature「清空回退推导」场景换成「空标题被拒 400」)、data-layer 签名段改为可选 trailing `projectId?`;并已 `git rebase origin/main` 消除 pr-analyst.md 复活。留此条作**复盘教训**(后端契约 PR 收尾要逐字比三方),不是 main 上的待修项。
