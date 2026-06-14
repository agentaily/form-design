# 契约来源：SPEC §26.9（多会话列表 + 删除 + 新建 / 切换）与 §13.6（对话级模型芯片）。PR #65。
# 续 features/chat-session-persistence.feature（§26 单会话持久化 / 恢复）——keying 不变（仍按
# 客户端生成的稳定 design session id，键 =(owner_id, session_id)，§26.2）；本 feature 只描述
# 「一个 owner 同时有多段对话」时新增的可观察行为：列出 / 切换 / 删除 / 新建，以及对话级选模型。
#
# 不重述：会话表结构、title/turnCount 的运行期推导算法细节、新建/切换的前端编排实现——那些在
# SPEC §26.9 + workers/src/chatSessions.ts（listChatSessions / deleteChatSession /
# deriveSessionTitle / countUserTurns）+ src/core/chatSessionClient.ts（listChatSessions /
# deleteChatSession + ChatSessionSummary）+ src/core/chatModels.ts（CHAT_MODELS）的桩里。
#
# 关键契约（本 feature 据此措辞）：
#   * 列表只含本 owner 名下的会话（WHERE owner_id=?），按最近更新在前排序（§26.9）。
#   * 列表项 title = 首条 user 消息文本（trim+截断 40 字），turnCount = user 回合数（§26.9）。
#   * 删除按 (owner_id, sessionId) 隔离：删自己的 → 成功；删不属于自己/不存在的 → 404（§26.8/§26.9）。
#   * 对话级模型芯片选中值经 POST /api/chat 的 per-request `model` 参数进代理，白名单兜底（§13.6）。
Feature: 设计对话的多会话管理与对话级模型选择
  作为表单作者(owner)
  我希望同时维护多段设计对话、在它们之间切换与删除、并为每段对话选用模型
  以便我能并行设计多份表单、清掉不要的草稿对话、按需用通用或推理模型

  # —— 列表：按账号隔离，最近在前，标题/轮数从转写推 ——

  Scenario: owner 列出自己的全部会话（最近更新在前）
    Given owner 已登录且名下有多段已持久化的设计对话
    When owner 拉取自己的会话列表
    Then 返回该 owner 名下的全部会话
    And 列表按最近更新时间排序，最近的在最前

  Scenario: 会话列表项展示从对话推出的标题与轮数
    Given owner 名下有一段会话，其首条用户消息是「帮我做一个活动报名表」
    When owner 拉取会话列表
    Then 该会话项的标题取自首条用户消息的文本（trim 后超长截断）
    And 该会话项的轮数等于该会话里用户回合的数量

  Scenario: 损坏或无用户消息的会话回退为默认标题
    Given owner 名下有一段会话其转写为空或没有用户回合
    When owner 拉取会话列表
    Then 该会话项的标题回退为「新会话」
    And 该会话项的轮数为 0

  Scenario: 会话列表只含当前登录账号的会话
    Given owner A 与 owner B 各自名下都有已持久化的设计对话
    When owner A 拉取自己的会话列表
    Then 列表只包含 A 名下的会话
    And 列表不包含 B 的任何会话

  Scenario: owner 名下没有任何会话时返回空列表
    Given owner 已登录但名下没有任何已持久化的设计对话
    When owner 拉取自己的会话列表
    Then 返回一个空的会话列表
    And 不报错

  # —— 删除：按账号隔离，删自己的成功、删别人的/不存在的 404 ——

  Scenario: owner 删除自己的一段会话
    Given owner 名下有一段已持久化的会话
    When owner 删除该会话
    Then 删除成功
    And 该会话不再出现在 owner 的会话列表里

  Scenario: 删除不属于自己的会话返回 404
    Given owner A 已登录
    And 存在一段属于 owner B 的会话
    When owner A 尝试用 B 那段会话的 id 发起删除
    Then 返回 404 「会话不存在」
    And B 的那段会话不受影响、依旧存在

  Scenario: 删除从不存在的会话返回 404
    Given owner 已登录
    When owner 删除一个自己名下从未存在过的会话 id
    Then 返回 404 「会话不存在」

  # —— 新建 / 切换：清空当前工作区开新对话 / 载回另一段对话 ——

  Scenario: 新建会话清空当前对话工作区并开新 session
    Given owner 正在设计器里进行一段对话
    When owner 新建一段会话
    Then 对话工作区被清空为初始空态
    And 后续对话写入一个新的 design session id，不覆盖原会话

  Scenario: 切换到另一段会话载回该会话的转写
    Given owner 名下有另一段已持久化的会话
    When owner 切换到那段会话
    Then 该会话的对话历史按原顺序重新出现在对话区
    And owner 可以接着那段对话继续发送消息

  # —— 对话级模型芯片：选中值经 per-request model 进代理 ——

  # 型号有两个名:界面上的「显示名」(DeepSeek-V4-Flash) 与发上游的「API model id」。DeepSeek 的
  # OpenAI 兼容端点对 model id 大小写敏感、未知 id 直接 400,故 wire 值必须是小写真 id
  # (deepseek-v4-flash / deepseek-v4-pro)。owner 选的是显示名 (label),发出去的是小写 id (wire)。
  Scenario Outline: 对话级选用模型后请求带上该型号对应的小写 API id
    Given owner 已登录设计器
    When owner 为当前对话选用模型 "<label>"
    And owner 在该对话里发送一条消息
    Then 发往对话代理的请求带上 model 参数 "<wire>"

    Examples:
      | label             | wire              |
      | DeepSeek-V4-Flash | deepseek-v4-flash |
      | DeepSeek-V4-Pro   | deepseek-v4-pro   |

  # 前端:模型选择器默认选中 V4-Flash,故每次发送都带上当前(默认)型号的小写 id——由 App 集成测试 realize。
  Scenario: 未显式切换型号时对话仍带上默认型号 V4-Flash 的小写 id
    Given owner 已登录设计器且未手动切换对话模型
    When owner 在该对话里发送一条消息
    Then 发往对话代理的请求带上默认型号的小写 id "deepseek-v4-flash"

  # 后端:代理收到不带 per-request model 的请求时回退,并把 owner 保存的(可能是旧驼峰显示名脏数据的)
  # model 归一化成合法小写 id 再发上游——由 workers chat-api 测试 realize。
  Scenario: 对话请求未带 per-request 模型时代理回退到 owner 保存的模型 / 默认(归一化成小写 id)
    Given owner 已配置 DeepSeek 凭据
    When 对话代理收到一个不带 per-request model 参数的请求
    Then 代理用 owner 保存的模型或全局默认模型兜底,并归一化成合法小写 id "deepseek-v4-flash" 再发上游

  Scenario: 代理拒绝不在白名单内的对话级模型
    Given owner 已登录设计器
    When 对话请求带上一个不在白名单内的 model 值
    Then 代理拒绝该请求并返回 400 「unsupported model」
    And 不向上游 LLM 转发该请求
