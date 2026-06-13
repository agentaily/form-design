---
name: d1-submissions-architecture-turn
description: PR-2 翻转提交主存到 D1、飞书降为可选后台同步；POST /api/submit 与 submissions 读路径的 wire shape 都变了，前端故意未改、留给 PR-6
metadata:
  type: project
---

PR-2(分支 `autopilot/fd-d1-submissions`)把提交数据主存从「owner 飞书多维表格」翻转到 **D1**，飞书降为 best-effort 后台同步(`c.executionCtx.waitUntil(syncSubmissionToFeishu(...))`，仅当 owner 配了飞书)。

**Why:** 用户主线「内部先有存储,飞书只做外部同步」——提交永不因飞书未配/故障而丢。已与产品负责人确认干净起步、零回填(prod 自测态、单 owner)。

**How to apply(审 PR-6 / 前端时):** 两处 wire shape 变了，但本 PR 边界**不碰前端**(已在 SPEC §18 + commit body 记录留给 PR-6):

- `POST /api/submit` 成功体:`{ ok, recordId }` → `{ ok, id }`。
- `GET /api/forms/:slug/submissions` 每条:`{ recordId, fields, createdTime? }` → `{ id, answers:[{label,value}], createdAt, feishu:{recordId,syncedAt,error} }`。

前端 `src/core/publicClient.ts`(`SubmitResult`)/`submissionsClient.ts`(`Submission`)仍是旧形状,`src/submissions-view.jsx` 读 `s.recordId`/`s.fields`/`s.createdTime`——这些改版后运行时全 `undefined`(数据后台每行渲染空)。**typecheck 抓不到**:`publicFetch<T>`/`apiFetch<T>` 直接 cast JSON 到 `T` 不校验。PR-6 必须对齐这三处。审 PR-6 时确认它真的改了 `Submission` 投影 + view 的字段访问。

**还有个未修的健壮性缺口(本 PR 报为 major,未 block):** submit 在写完 D1 主存之后、为决定是否调度后台同步,**同步**调用了 `importConfigKey` + `getOwnerConfig`(index.ts ~830-831)。`getOwnerConfig` 在密文/CONFIG_KEY 不匹配时会抛(config.ts 文档化),会让一条**已落 D1** 的提交返回 500——违反「D1 写成功后绝不变错误码」。应把 config 读+调度包进 try/catch 吞掉,或整体挪进 waitUntil。
