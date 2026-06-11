Feature: LLM 代理 POST /api/chat 用 owner key 直连 DeepSeek
  作为表单 owner
  我想让对话式表单设计走后端代理而不是浏览器直连
  以便用我自己已配置的 DeepSeek 额度，且我的 key 永不出现在浏览器侧

  背景：owner 的 DeepSeek key 已由集成配置加密存入 D1，代理在 Worker 内解密后
  只用于发往上游的 Authorization 头；上游是 https://api.deepseek.com 的 OpenAI 兼容
  /chat/completions，代理把上游的流式响应原样透传回前端。

  Scenario: owner 已配 key 时代理用其 key 调上游并流式返回
    Given 一个已配置 DeepSeek key 的 owner
    When 前端向 /api/chat 发送一组对话消息
    Then 代理用该 owner 的 key 作为上游 Authorization 调用 DeepSeek
    And 代理向上游请求时开启流式
    And 响应以 text/event-stream 流式透传上游内容

  Scenario: tools 被原样透传给上游
    Given 一个已配置 DeepSeek key 的 owner
    When 前端向 /api/chat 发送带 tools 的对话消息
    Then 上游请求体里包含原样透传的 tools
    And 上游请求体里包含原样透传的 messages

  Scenario: owner 未配 key 时返回 409 且不打上游
    Given 一个从未配置 DeepSeek key 的 owner
    When 前端向 /api/chat 发送一组对话消息
    Then 响应状态码为 409 并提示 owner 未配置 DeepSeek
    And 代理没有向上游发起任何请求

  Scenario: messages 缺失时返回 400 且不打上游
    Given 一个已配置 DeepSeek key 的 owner
    When 前端向 /api/chat 发送缺少 messages 的请求
    Then 响应状态码为 400
    And 代理没有向上游发起任何请求

  Scenario: 上游报错时返回错误且不泄漏 owner key
    Given 一个已配置 DeepSeek key 的 owner
    And 上游 DeepSeek 将以错误状态码响应
    When 前端向 /api/chat 发送一组对话消息
    Then 代理返回可辨识的错误响应
    And 错误响应里不包含 owner 的明文 DeepSeek key

  Scenario: model 缺省时上游请求使用默认 deepseek-chat
    Given 一个已配置 DeepSeek key 但未指定 model 的 owner
    When 前端向 /api/chat 发送一组对话消息
    Then 上游请求体里的 model 为 deepseek-chat

  Scenario: 已配 model 时上游请求使用 owner 的 model
    Given 一个已配置 DeepSeek key 且指定了 model 的 owner
    When 前端向 /api/chat 发送一组对话消息
    Then 上游请求体里的 model 为 owner 配置的 model
