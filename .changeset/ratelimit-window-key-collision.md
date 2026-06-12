---
"agentaily-forms": patch
---

fix(ratelimit): 限流计数键编进 windowSeconds，根治 submit 整点边界「分钟/小时双窗相撞」误限

`POST /api/submit` 同时挂了分钟（60s / 10）与小时（3600s / 100）两个固定窗口。KV 计数键原为
`rl:<bucket>:<hash(ip)>:<windowStart>`，**键里不含窗口长度**。当墙钟落在整点后头一分钟内
（`now % 3600 < 60`）时，分钟窗的 `floor(now/60)*60` 与小时窗的 `floor(now/3600)*3600` 都等于
该整点时刻，两窗口的 `windowStart` 撞成同一个值 → 共用一个计数键 → 每次提交被**双计** → 分钟
限额（10）在第 ~5 次真实提交就被打满、误回 429。线上约 1.67% 概率（每小时头一分钟）偶发误限，
也是 `workers/test/rate-limit-api.test.ts` 那组 submit 测试 flaky（`expected 429 not to be 429`）的根因。

修复：计数键追加 `windowSeconds` 段 → `rl:<bucket>:<hash(ip)>:<windowStart>:<windowSeconds>`，让分钟桶
与小时桶即便 `windowStart` 相同也落不同键、互不串计。行为契约（`features/rate-limit.feature`）不变，
新增一条针对整点边界相撞的确定性回归单测。SPEC §25.3。
