# Agentaily Forms — 项目约定

对话式表单设计器(**设计 → 发布 → 收集 → 看结果**)。导航:
README(怎么跑/接线)· [SPEC.md](./SPEC.md)(产品+架构)· [ROADMAP.md](./ROADMAP.md)(能力地图)·
[METHODOLOGY.md](./METHODOLOGY.md)(研发驱动范式)· [OPERATIONS.md](./OPERATIONS.md)(运维)·
[`.claude/agents/README.md`](./.claude/agents/README.md)(sub agent 分工)。

## 工作流纪律

- **接到会改代码的任务,先从 `main` 切一个 feature 分支再动手,提交走 PR。** 不要把改动直接堆在
  `main` 的工作区里。纯问答 / 探索 / 只读调研不必开分支。
- 单线任务用 **branch** 隔离即可,不必开 worktree;**worktree 留给多实例并行**(`claude-fleet`,
  每任务一 worktree + 一终端)。
- **只在用户要求时** commit / push。commit 与 PR 标题用 conventional commits 带 scope,
  与现有历史一致(`feat(frontend): …` / `fix(e2e): …` / `ci(deploy): …`)。
- 谁 ship 或改变一个能力,**同一次改动**更新 [ROADMAP.md](./ROADMAP.md);谁改变研发流程本身,
  更新 [METHODOLOGY.md](./METHODOLOGY.md)。文档不复述,链 SPEC / agents/README。

## 硬约束

- **UI 一律消费 [`@agentaily/design-system`](https://github.com/agentaily/design-system)**,
  不手搓组件;升级随上游流过来。`src/app.css` 只放布局,值引用 DS token。
- `src/core/` 是 **TypeScript strict**、framework-agnostic、**test-first(TDD)** —— 先写失败单测再写实现。
- **双循环 TDD / BDD**:[`features/*.feature`](./features) 是行为契约的唯一真相源;
  `tests/unit`(内环)+ `tests/integration` & `e2e`(外环)只是在不同海拔 realize 它。
  分工与铁律见 [agents/README](./.claude/agents/README.md)(契约优先交接 · reviewer 独立只读 · 内环不拆 · 最小权限)。
- **凭证进 vault,绝不硬编码、不进 agent context**;BYOK 架构(owner 自带 DeepSeek + 飞书 key)见 SPEC §12–§21。

## 跑起来

`npm run dev`(5173)· `npm run typecheck`· `npm test`(unit + BDD,jsdom)· `npm run test:e2e`(Playwright)·
`npm run test:all`。后端 `cd workers && npx wrangler dev`,前端用 `VITE_API_BASE` 指过去。
