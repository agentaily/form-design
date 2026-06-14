# 契约来源：SPEC §26（聊天会话后端 D1 持久化 + 刷新恢复，绑账号）。PR #48。
# 描述「设计对话跨刷新 / 跨设备恢复」的可观察行为，不重述后端表结构、防抖实现细节、
# OpenAI/UI 两份消息形状的内部映射（那些在 SPEC §26 + src/core/chatSessionClient.ts 桩里）。
#
# 关键设计取舍（SPEC §26.2，本 feature 据此措辞）：
#   * 发布前没有稳定的表单 id（slug 仅发布后才有），所以会话按【客户端生成、localStorage 持久化】
#     的稳定 design session id 绑定，键 =(owner_id, session_id)，而非按表单 id。
#   * 该 session id 跨刷新不变（同一对话续上）、跨发布不变（发布只把 slug 关联进会话行，不换 id）。
#   * 会话是 owner-only（设计对话本就走 owner-only /api/chat）：未登录【不持久化】，
#     发送触发 401 → 引导去 /signin（沿用现状，不引入 localStorage 兜底存对话正文）。
#   * 写入按【回合结束批量】落库（§4/§4.1 的 flush 时机），不是每个 token 写一次。
#
# 前端契约桩见 src/core/chatSessionClient.ts（getOrCreateDesignSessionId / loadChatSession /
# saveChatTurns + PersistedChatSession / PersistedTurn / Save·LoadChatSession DTO）；
# 设计器接线见 src/App.jsx（DesignerApp 的 messages / historyRef）。
#
# 多会话（列出 / 切换 / 删除 / 新建）+ 对话级模型芯片的行为见 features/chat-multi-session.feature
# （SPEC §26.9 / §13.6，PR #65）——本 feature 只管单会话的持久化 / 恢复。
Feature: 设计对话的持久化与刷新恢复
  作为表单作者(owner)
  我希望我和设计 Agent 的对话被记住、刷新或换设备后还能续上
  以便我不必每次重开都从头描述同一份表单

  # —— 持久化：对话回合随聊天写入后端（批量，不是每 token）——

  Scenario: 一个回合结束后把对话写入后端
    Given owner 已登录设计器
    And 该会话有一个稳定的 design session id
    When owner 发送一条消息并且 Agent 完成这一个回合
    Then 这一回合的用户消息、助手文本、工具调用都随该 session id 写入后端
    And 本次写入发生在回合结束时一次性批量提交，而不是每个流式片段写一次

  Scenario: 流式输出过程中不逐字写库
    Given owner 已登录设计器
    When 助手的回复正在逐字流式输出
    Then 流式过程中不向后端发起逐 token 的写入请求

  # —— 恢复：登录态重载页面 → 历史按原顺序恢复，可继续往下聊 ——

  Scenario: 刷新页面后对话历史按原顺序恢复
    Given owner 已登录并有一段已持久化的设计对话
    When owner 重新加载设计器页面
    Then 之前的对话回合按原始顺序重新出现在对话区
    And owner 可以接着这段对话继续发送消息

  Scenario: 恢复的对话能让 Agent 记得之前的上下文
    Given owner 刷新后看到恢复的对话历史
    When owner 发送一条依赖先前上下文的后续消息
    Then Agent 在带着已恢复的历史的前提下继续这一回合

  # —— 跨设备：同账号在另一浏览器/设备能看到该对话 ——

  Scenario: 同账号换设备打开同一会话能看到对话
    Given owner 在 A 设备上有一段已持久化的设计对话
    And owner 在 B 设备用同一账号登录并打开同一个 design session id
    When 设计器加载该会话
    Then B 设备上按原顺序显示与 A 设备相同的对话历史

  # —— keying：发布把 slug 关联进会话，但 session id 不变 ——

  Scenario: 发布表单后会话仍按同一 session id 续上
    Given owner 已登录且有一段进行中的设计对话
    When owner 发布这份表单
    And owner 随后刷新页面
    Then 对话仍按同一个 design session id 恢复
    And 该会话被关联到刚发布表单的 slug

  # —— 未登录态：不持久化 + 401 引导登录（明确定义，无未定义态）——

  Scenario: 未登录时对话不写入后端
    Given owner 未登录
    When owner 在设计器里输入并发送一条消息
    Then 不向后端发起任何会话持久化写入
    And 发送对话设计请求返回 401
    And 提示需要先登录并引导去登录页

  Scenario: 未登录刷新后不恢复任何历史
    Given owner 未登录
    When owner 加载设计器页面
    Then 不向后端发起任何会话恢复请求
    And 对话区为初始空态

  # —— 隔离 / 鉴权门控：只有 owner 能读自己的会话 ——

  Scenario: 会话恢复请求带登录态、按账号隔离
    Given owner 已登录
    When 设计器按 session id 拉取会话历史
    Then 该请求带上 owner 的登录凭证
    And 只能取回属于当前登录账号的会话

  Scenario: 会话失效时恢复请求引导重新登录
    Given owner 的登录态已过期
    When 设计器按 session id 拉取会话历史并返回 401
    Then 提示需要先登录并引导去登录页

  # —— 首次进入 / 无历史：空态不报错 ——

  Scenario: 全新会话首次进入时无历史可恢复
    Given owner 已登录且该 session id 从未持久化过对话
    When 设计器按 session id 拉取会话历史
    Then 后端返回「没有该会话」的空结果
    And 对话区显示为初始空态且不报错
