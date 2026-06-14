---
name: conn-test-spec-vs-feature-drift
description: PR #72 改了 /api/config/test 行为(请求体收待测凭据)但没改 SPEC §14.1，feature 文件改了——SPEC 与代码相反
metadata:
  type: project
---

PR #72 把 `POST /api/config/test` 从「只测已存配置、不在请求体收凭据」改成「按卡 · 接受请求体传入待测凭据(verify-before-save) · 凭据未传回退已存」。feature 文件(`features/integration-settings.feature` + `workers/features/conn-test.feature`)同步改了,但 **SPEC.md §14 没改**——§14.1 line 674/676 仍白纸黑字写「**不**在请求体里收凭据」「MVP 不接收请求体里的临时凭据... 请求体为空(或被忽略)」,§14.1 内部流程图(line 686-698)仍只画「读已存 → 探两块」,与实际相反。

**Why:** 项目 CLAUDE.md 硬约束「谁 ship 或改变一个能力,同一次改动更新 ROADMAP/SPEC」「文档与代码同步」。feature 是 BDD 真相源(已对齐),但 SPEC 是产品+架构真相源,现在主动误导后来人。

**How to apply:** 审查任何改后端端点契约 / BYOK 凭据流向的 PR 时,grep SPEC.md 对应小节,确认行为描述、流程图、安全小节(§14.5)都跟代码一致。这是 PR #72 唯一的 major finding(非运行时 bug,全部 776+480 测试绿)。相关 [[project_d1-submissions-architecture-turn]](同类:wire/行为改了文档/前端故意滞后)。
