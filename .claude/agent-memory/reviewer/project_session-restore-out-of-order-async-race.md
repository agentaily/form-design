---
name: session-restore-out-of-order-async-race
description: switchSession/mount-restore apply async loadChatSession results without re-checking active session id → cross-session transcript/workspace contamination
metadata:
  type: project
---

App.jsx 的会话恢复(`applyRestoredSession`)在 await `loadChatSession(id)` 后**不重新校验 `id === sessionIdRef.current`** 就 apply,导致**乱序异步串会话**:快速切换/Back-Forward 时,一个旧会话的 load 后于新会话 resolve → 旧会话的 turns+工作区被渲染到当前活跃会话下,随后 `persistTurn` 会把它写进新会话的 key(`(owner_id, sessionId)`),污染持久化行。

**Why:** 这是 PR #76(URL 状态持久化)manager 最在意的「不串会话」属性。reviewer 用一个延迟 resolve 的探针测试实测复现:switch A→B(不 resolve)→ popstate Back 到 A → 先 resolve A 再 resolve 旧的 B → 结果 `URL s=ds-a 但渲染的是 B 的转写`。根因是**只有 mount-restore effect 有 `cancelled` guard,`switchSession` 完全没有任何 generation/token/重校验**;mount effect 的 `cancelled` 也只在 unmount 时置位,switch 打断 mount-load 同样会乱序 apply。

**How to apply:** 审查任何「按 id 异步拉取再 apply 到共享 ref/state」的恢复逻辑时,await 之后 apply 之前必须重新比对 id 是否仍是当前活跃 id(或用单调 generation 计数器,apply 时丢弃过期世代)。`switchSession` 和 mount-restore effect 两处都要修。集成测试若 mock 同步/顺序 resolve 永远测不出来——要用可控延迟的 deferred promise 制造乱序。相关:[[d1-list-ordering-timestamp-tie-flake]] 也是异步顺序假设问题。
