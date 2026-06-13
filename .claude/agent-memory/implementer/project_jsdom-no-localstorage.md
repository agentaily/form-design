---
name: jsdom-no-localstorage
description: form-design 的 vitest/jsdom 测试环境不提供 localStorage 全局——单测要自己 stub
metadata:
  type: project
---

form-design 前端的 vitest 配置用 `environment: "jsdom"`，但**该环境不提供 `localStorage` 全局**：`globalThis.localStorage` / `window.localStorage` / 裸 `localStorage` 在干净的测试里全是 `undefined`（node 还会打印 `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided`）。

**Why:** 这正是 `src/core/apiClient.ts` 的 `getToken`/`setToken` 把每次 localStorage 访问都裹在 try/catch + 内存镜像（`memToken`）的原因——生产里浏览器有 localStorage，但测试环境没有，代码必须对「storage 不可用」鲁棒。任何复刻这一模式的模块（如 `src/core/chatSessionClient.ts` 的 `getOrCreateDesignSessionId` 的 `memSessionId` 镜像）同理。

**How to apply:** 写碰 localStorage 的 `tests/unit/*` 时，**别假设 jsdom 给了可用的 localStorage**。要测「读/写/复用」用一个自己的 fake：`vi.stubGlobal("localStorage", { getItem, setItem, removeItem, clear })`（一个 Map 兜底的内存实现）；要测「storage 不可用兜底」就 stub 一个每次访问都 throw 的对象。afterEach 用 `vi.unstubAllGlobals()` 还原。别用 `vi.stubEnv` 之外再去 `localStorage.clear()`（会 `Cannot read properties of undefined`）。
