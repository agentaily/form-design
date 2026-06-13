---
"agentaily-forms": minor
---

依赖升级 + 聊天 markdown 闭环:`@agentaily/design-system` `^0.6.0 → ^0.7.0`,助手回复改为消费上游新增的 `<Markdown>` 组件渲染。

此前聊天里助手回复用 `<p>{m.text}</p>` 纯文本渲染,model 输出的 markdown(列表 / 加粗 / 链接 / 代码块 / 标题)以原始语法显示。0.7.0 上游补了 `<Markdown>` 原语(解析成节点树后只发 React 元素、绝不 `dangerouslySetInnerHTML`,link scheme 净化、image 不加载——XSS-safe),`src/chat.jsx` 的助手文本气泡改用 `<Markdown content={m.text} />`,markdown 正确排版渲染,`<Suggestions>` 兄弟节点保持不变。补一条集成测试断言助手 markdown 消息渲染成对应 DOM(`<ul><li>` / `<strong>`)而非原文,并覆盖 `javascript:` 链接被净化。
