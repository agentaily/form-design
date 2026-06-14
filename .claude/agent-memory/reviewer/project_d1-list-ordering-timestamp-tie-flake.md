---
name: d1-list-ordering-timestamp-tie-flake
description: D1 列表端点 ORDER BY updated_at 无次级 tiebreak,同毫秒写入时排序未定义 → 负载相关 flaky 假红
metadata:
  type: project
---

后端 D1 列表端点若 `ORDER BY <ts> DESC` 且 `<ts>` 用 `new Date().toISOString()`(毫秒分辨率)、
**无确定性次级排序键**,则多行在**同一毫秒**写入时相对顺序未定义——SQLite 对相等键不保证稳定序。
测试若断言精确顺序(`toEqual([...])`)会在并行/CPU 争抢下偶发假红。

**Why:** PR #65 `listChatSessions`(`workers/src/chatSessions.ts`)`ORDER BY updated_at DESC` 即此形;
三个连续 PUT 落同一毫秒 → 顺序断言实测在 `chat-session-api.test.ts + chat-api.test.ts` 并跑首轮挂、
单文件 8/8 过。这是负载相关 flaky,不是稳定 bug——与 [[concurrent-vitest-cpu-contention-false-red]]
同家族(本项目惯犯)。

**How to apply:** 评审任何「列出 + 按时间排序」的 D1 端点时,查 ORDER BY 有没有次级 tiebreak
(`, session_id DESC` / `, rowid`)。没有就既是产品抖动(真实列表顺序会跳)又是测试 flake 源,报 high。
看到「按时间排序」的精确顺序断言挂,先怀疑时间戳打平,别当真红 rerun。
