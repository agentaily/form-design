Feature: 助手回复里的 markdown 渲染成排版后的 HTML
  作为表单作者
  我想让助手回复里的 markdown(列表 / 加粗 / 链接 / 代码)显示成排版后的样子
  以便对话可读,而不是看到一堆 *、- 之类的原始语法

  Scenario: 助手文本消息把 markdown 渲染成 DOM(而非原文)
    Given 一条助手消息的文本是包含列表与加粗的 markdown
    When 把这条消息渲染到对话里
    Then 列表渲染成 <ul><li>
    And 加粗渲染成 <strong>
    And 页面上看不到原始的 markdown 语法字符

  Scenario: 助手 markdown 里的危险链接被净化(无 XSS)
    Given 一条助手消息的文本里带一个 javascript: 协议的链接
    When 把这条消息渲染到对话里
    Then 该链接的 href 不是 javascript: 协议
