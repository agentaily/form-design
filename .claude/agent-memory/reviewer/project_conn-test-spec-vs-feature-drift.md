---
name: conn-test-spec-vs-feature-drift
description: 改后端端点契约的 PR 容易只改 feature 漏改 SPEC——审查时必 grep SPEC 对应小节(PR #72 conntest 实例,已在同 PR 修复)
metadata:
  type: project
---

PR #72 把 `POST /api/config/test` 从「只测已存配置、不在请求体收凭据」改成「按卡 · 接受请求体传入待测凭据(verify-before-save) · 凭据未传回退已存」。feature 文件(`features/integration-settings.feature` + `workers/features/conn-test.feature`)第一刀就同步改了,但 **SPEC.md §14 漏改**——§14.1 仍写「**不**在请求体里收凭据」「MVP 不接收请求体里的临时凭据... 请求体为空」、内部流程图仍只画「读已存 → 探两块」,与实际相反。**reviewer 揪出后已在同一 PR 修复**(重写 §14.1 请求形状 + 流程图 + §14.5 安全,ROADMAP 记一条),这是 PR #72 唯一的 major finding(非运行时 bug,776+480 测试全绿)。

**Why:** 项目 CLAUDE.md 硬约束「谁 ship 或改变一个能力,同一次改动更新 ROADMAP/SPEC」「文档与代码同步」。feature 是 BDD 真相源,但 SPEC 是产品+架构真相源——只改 feature 漏改 SPEC 会让 SPEC 主动误导后来人。

**How to apply:** 审查任何改后端端点契约 / BYOK 凭据流向的 PR 时,grep SPEC.md 对应小节,确认行为描述、流程图、安全小节都跟代码一致——尤其当 PR 已改了 `features/*.feature`(说明是行为契约变更),八成对应 SPEC 小节也得改。相关 [[project_d1-submissions-architecture-turn]](同类:wire/行为改了文档/前端故意滞后)。
