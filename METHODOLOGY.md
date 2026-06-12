# Agentaily Forms — 研发驱动范式

> 本项目怎么被「驱动」着造出来。不是任务清单，是方法论。
> 能力地图见 [ROADMAP.md](./ROADMAP.md)，产品规格见 [SPEC.md](./SPEC.md)，
> sub agent 分工见 [`.claude/agents/README.md`](./.claude/agents/README.md)。

---

## 一句话

> **路线图定方向 → 规格 / BDD / 契约定边界 → 双循环 TDD（sub agent 分工）把它做对 →
> 按规模选并行拓扑（fleet / Workflow）、按输入选适配器（design-sync）。**

关键认知:下面这些**不是「选一个」的互斥选项,而是分了 4 层的一个栈**。
它们是组合关系,不是竞争关系。**主轴恒定**(第 1+2 层 always-on),
**拓扑与输入按挡位挂**(第 3+4 层按情况选)。把它们摆成「该用哪种」会绕进去 ——
正确的问法是「每一层各用什么」。

---

## 第 1 层 · 规划 / 对齐层(定义 WHAT)

一条收敛漏斗,每往下一层就更可执行:

| 阶段              | 载体                                        | 作用                                                                              |
| ----------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| **路线图驱动**    | [`ROADMAP.md`](./ROADMAP.md)                | 以**能力**为粒度的地图:已完成 / 进行中 / 待办。回答「系统能做什么、下一步做什么」 |
| **规格驱动**      | [`SPEC.md`](./SPEC.md)                      | 能力展开成产品规格 + 架构决策                                                     |
| **行为驱动(BDD)** | [`features/*.feature`](./features)(Gherkin) | 规格落成**可执行的验收契约** —— 全员对着它干                                      |
| **契约优先**      | `src/core` 类型 / 接口 / 工具 schema        | 接口先于实现钉死                                                                  |

> BDD 是方法论,不是某一层测试。`features/` 是「系统做什么」的唯一真相源,
> 下面各测试级别只是在不同**海拔**去 _realize_ 这些行为(详见 README「Testing」)。

## 第 2 层 · 执行层(HOW:双循环 TDD by sub agent)

契约立好后,由职责单一、最小权限的 sub agent 分工承载。权威来源是
[`.claude/agents/README.md`](./.claude/agents/README.md),此处只给骨架:

```
intent / handoff ─► spec-architect ─► features/ + 契约 ─┐
                    design-syncer ──► design deltas      │
                                                         ▼
                          implementer  ◄── 契约 ──►  outer-tester
                      (内环: 码 + 单测 red→green→refactor)  (外环: 集成 + e2e)
                                        └───────┬────────┘
                                                ▼
                                          reviewer  (独立对抗,只读)
                                                ▼
                                          release-eng  (CI / Pages / release)
```

四条铁律:

- **契约优先交接** —— agent 之间交 artifact(features / 类型 / 结构化报告),不交散文。
- **独立验证** —— `reviewer` ≠ `implementer`;reviewer 只读且对抗,不给自己打分。
- **内环不拆** —— 同一个 `implementer` 写失败测试和实现,red→green→refactor 太紧,不能交接。
- **最小权限** —— 工具权限即边界(reviewer 没有 Write)。

## 第 3 层 · 并发拓扑层(用多大并行度推进)

这层是真正在「选」的地方,按任务规模选:

- **同会话编排**(Workflow / in-session sub agent)—— 共享上下文 + 共享计费,
  适合**一条 feature 内部** fan-out(多角度找 / 审 / 验)。
- **跨会话舰队**(`claude-fleet` skill)—— 多 git worktree + 多终端,独立 CLI 实例**真并行**,
  适合 ROADMAP 里**互不冲突的多个 feature 同时推**(本项目前端 / 后端 fleet 即如此)。

> 并行需要隔离:并发的 implementer 跑在各自的 worktree 里,避免互相覆盖共享文件。

## 第 4 层 · 外部输入适配层(驱动从哪来)

- **design-sync**(`design-sync` skill + `design-syncer` agent)—— Claude Design handoff
  → 三方 diff 合进代码、**保留本地工程改动**、冲突上报而非覆盖、刷新 `.design-baseline/`。
  把「设计交付」也变成一种**受控的驱动输入**,而不是手抄。

---

## 怎么挂挡(决策表)

| 情况                         | 挂什么                             |
| ---------------------------- | ---------------------------------- |
| 改一行 / 小修                | 都不挂,直接干(主轴仍在:有测试就补) |
| 单 feature,要审要验          | **Workflow**(同会话 fan-out)       |
| 多 feature 互不冲突,要真并行 | **fleet**(多 worktree + 多终端)    |
| 有 Claude Design 交付        | 走 **design-sync**                 |
| 无设计输入                   | 跳过第 4 层                        |

无论挂哪个挡,**第 1+2 层(契约优先的双循环 TDD)始终在**。它是骨架,不是选项。

---

_谁 ship 或改变一个能力,就在同一次改动里更新 [ROADMAP.md](./ROADMAP.md);
谁改变研发流程本身,就更新本文件。细节链 SPEC / agents/README,不复述。_
