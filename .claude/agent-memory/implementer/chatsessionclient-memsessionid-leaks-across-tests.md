---
name: chatsessionclient-memsessionid-leaks-across-tests
description: chatSessionClient 的模块级 memSessionId 镜像跨 vitest 用例残留;断言「当前活跃会话」要避免依赖具体 id
metadata:
  type: project
---

`src/core/chatSessionClient.ts` 用一个**模块级** `let memSessionId` 做 localStorage 的内存镜像(私有模式/沙箱兜底,仿 apiClient 的 memToken)。`setActiveDesignSessionId` / `getOrCreateDesignSessionId` 都读写它。

**坑:** vitest 同一文件里多个 it 共享这个模块单例。前一个用例调了 `switchSession(x)` / `setActiveDesignSessionId(x)`(经 App 或直接),`memSessionId` 就留成 `x`;`afterEach` 只清 localStorage(`removeItem(DESIGN_SESSION_ID_KEY)`),**清不掉这个内存镜像**。下个用例挂载 App 时 `getOrCreateDesignSessionId()` 返回上次残留的 id → `sessionIdRef.current` 变成上一段会话 id → SessionMenu 里那一行被当成「当前活跃」(打勾、无删除按钮)。

**How to apply:** 测多会话 UI(SessionMenu 列表/删除)时,**别断言「ds-other 那行有删除按钮」这种依赖具体哪段是 active 的写法**。改成「取第一个有删除按钮的行(`getAllByRole('button',{name:'删除会话'})[0]`),读它的 `data-session-id`,删它,再断言 `deleteChatSession` 收到那个 id」——与哪段恰好 active 解耦。涉及 [[project_jsdom-no-localstorage]](本仓 jsdom 不给 localStorage 全局,单测要自己 stub fake)。
