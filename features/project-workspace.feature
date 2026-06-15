# 契约来源：SPEC §26.10（项目级工作区，A' 「项目 ↔ 对话」重构）+ §26.7 / §26.9（chat_sessions
# 加 project_id / title + 会话 rename + 可选 project 过滤）+ §17.1（鉴权矩阵新增 projects 四端点
# + PATCH rename）。A' 重构 PR-A（后端契约 + 0007 migration，加性灰度），PR #81。
# 方案母本见 docs/refactor-project-conversation.md。
#
# 描述「项目级共享工作区 + 会话归到项目下」的【后端可观察】行为（owner-only，api 海拔），不重述
# 表结构 DDL、JSON 序列化细节、UI 接线——那些在 SPEC §26.10 + workers/src/projects.ts
# （loadProject / upsertProject / listProjects / deleteProject）+ workers/src/chatSessions.ts
# （listChatSessions 带可选 projectId / renameChatSession）的桩里。
#
# 关键设计取舍（SPEC §26.10，本 feature 据此措辞）：
#   * 一个「项目」= 一份表单的容器，承载项目级共享工作区（meta + fields）；项目下多条会话共编
#     同一份表单，切对话不动工作区（工作区上提到项目级，A' 对 #76「工作区骑 turns_json」的纠正）。
#   * 项目按【client-minted UUID project_id】绑定，键 =(owner_id, project_id)——同 §26.2 keying
#     不绑表单的根本原因（草稿发布前没稳定 slug），只是把稳定 id 从 session 上提到 project。
#   * PR-A 纯加性 / 灰度：新表 / 新列可空、新端点加性；旧前端不传 project_id 仍按 (owner_id,
#     session_id) 工作。前端真正切到项目级工作区在 PR-C，本 feature 只钉 PR-A 的后端行为。
#   * 删项目【级联删其下会话】（老板拍定的数据语义）；rename 用独立 PATCH（不复用 PUT 带 title）。
#   * 全部 owner-only（沿用 §26.1 鉴权门）：无 token → 401；跨 owner 读 / 删 → 空 / 404（不暴露存在性）。
#
# 多会话列表 / 切换 / 删除 / 对话级模型芯片的既有行为见 features/chat-multi-session.feature
# （§26.9 / §13.6，PR #65）——本 feature 只管 A' 新增的项目级工作区 + 会话归属 / rename。
Feature: 项目级共享工作区与会话归属（A' 后端契约）
  作为表单作者(owner)
  我希望一份表单的工作区被记在「项目」这一层、其下的多条对话共编同一份表单
  以便我切换对话时右侧表单不变、还能给对话起名、按项目组织我的草稿

  Background:
    Given 一个已注册并登录的 owner

  # —— 项目工作区 save → load round-trip ——

  Scenario: 保存项目工作区后原样读回
    Given owner 有一个项目 id
    When owner 把表单 meta 与字段保存到该项目工作区
    And owner 读回该项目工作区
    Then 返回的 meta、字段与发布关联 slug 与保存时一致
    And 字段顺序与内容原样保留

  Scenario: 读一个从未存过的项目工作区返回空
    Given owner 持有一个自己名下从未保存过的项目 id
    When owner 读取该项目工作区
    Then 返回项目为空（project 为 null）
    And 不报错也不是 404

  Scenario: 重新保存整段替换项目工作区
    Given owner 已有一个保存过工作区的项目
    When owner 用新的 meta 与字段再次保存该项目工作区
    Then 再次读回时返回的是最新一次保存的 meta 与字段
    And 不会与旧版本字段混在一起

  Scenario: 保存时不带 slug 不清空已关联的 slug
    Given owner 的项目已关联一个已发布表单的 slug
    When owner 保存该项目工作区但本次不带 slug
    Then 该项目仍保留原先关联的 slug

  # —— 列项目：按更新时间倒序，标题 / 字段数运行期推导 ——

  Scenario: owner 列出自己的全部项目（最近更新在前）
    Given owner 名下有多个已保存工作区的项目
    When owner 拉取自己的项目列表
    Then 返回该 owner 名下的全部项目
    And 列表按最近更新时间排序，最近的在最前

  Scenario: 项目列表项的标题取自 meta 标题，字段数取自字段长度
    Given owner 有一个项目其 meta 标题是「活动报名表」且有 3 个字段
    When owner 拉取项目列表
    Then 该项目项的标题是「活动报名表」
    And 该项目项的字段数是 3

  Scenario: 没有标题的项目回退为默认标题
    Given owner 有一个项目其 meta 没有标题
    When owner 拉取项目列表
    Then 该项目项的标题回退为「未命名表单」

  Scenario: owner 名下没有任何项目时返回空列表
    Given owner 名下没有任何项目
    When owner 拉取自己的项目列表
    Then 返回一个空的项目列表
    And 不报错

  # —— 跨 owner 隔离：A 的项目 B 看不到 / 读不到 ——

  Scenario: 项目列表只含当前登录账号的项目
    Given owner A 与 owner B 各自名下都有已保存的项目
    When owner A 拉取自己的项目列表
    Then 列表只包含 A 名下的项目
    And 列表不包含 B 的任何项目

  Scenario: 读不属于自己的项目返回空
    Given 存在一个属于 owner B 的项目
    When owner A 用 B 那个项目 id 读取项目工作区
    Then 返回项目为空（project 为 null）
    And 不暴露该项目属于 B

  # —— 删项目：级联删其下会话 ——

  Scenario: 删除项目级联删除其下的全部会话
    Given owner 有一个项目，其下挂着若干已持久化的会话
    When owner 删除该项目
    Then 删除成功
    And 该项目不再出现在 owner 的项目列表里
    And 原先挂在该项目下的那些会话也都不复存在

  Scenario: 删除不属于自己的项目返回 404
    Given 存在一个属于 owner B 的项目
    When owner A 用 B 那个项目 id 发起删除
    Then 返回 404 「项目不存在」
    And B 的那个项目及其会话不受影响、依旧存在

  Scenario: 删除从不存在的项目返回 404
    Given owner 已登录
    When owner 删除一个自己名下从未存在过的项目 id
    Then 返回 404 「项目不存在」

  # —— 会话 rename：改 title，列表显示新标题，置空回退推导 ——

  Scenario: owner 重命名一段会话
    Given owner 名下有一段已持久化的会话
    When owner 把该会话重命名为「活动报名表 v2」
    Then 重命名成功
    And 之后在会话列表里该会话显示为「活动报名表 v2」

  Scenario: 重命名后显式标题优先于从对话推导的标题
    Given owner 有一段会话其首条用户消息是「帮我做一个报名表」
    When owner 把该会话重命名为「我的活动表」
    Then 会话列表里该会话的标题是「我的活动表」而不是从首条用户消息推导的标题

  Scenario: 未命名会话的标题回退到首条用户消息推导
    Given owner 有一段从未被显式命名的会话，其首条用户消息是「帮我做一个报名表」
    When owner 拉取会话列表
    Then 该会话的标题回退为从首条用户消息推导的标题

  Scenario: 把会话标题改成空 / 纯空白被拒（400，不落库）
    Given owner 有一段已被命名的会话
    When owner 尝试把该会话标题改成空字符串或纯空白
    Then 返回 400 「title 不能为空」
    And 该会话原标题不受影响（不落库）

  Scenario: 重命名不属于自己的会话返回 404
    Given 存在一段属于 owner B 的会话
    When owner A 用 B 那段会话的 id 发起重命名
    Then 返回 404 「会话不存在」
    And B 的那段会话标题不受影响

  # —— 会话按项目过滤（可选）：传 project_id 只列本项目会话 ——

  Scenario: 按项目过滤只列出该项目下的会话
    Given owner 有两个项目，各自下面都挂着已持久化的会话
    When owner 拉取某一个项目下的会话列表
    Then 列表只包含该项目下的会话
    And 不包含另一个项目下的会话

  Scenario: 不带项目过滤时仍列出 owner 全部会话（灰度兼容）
    Given owner 名下在不同项目下都有已持久化的会话
    When owner 不带项目过滤拉取会话列表
    Then 返回该 owner 名下的全部会话

  # —— owner-only 鉴权门：无 token → 401 ——

  Scenario: 匿名访客读项目工作区被拒
    Given 一个未登录的访客
    When 访客尝试读取某个项目工作区
    Then 返回 401 未授权
    And 不返回任何项目数据

  Scenario: 匿名访客列项目被拒
    Given 一个未登录的访客
    When 访客尝试拉取项目列表
    Then 返回 401 未授权

  Scenario: 匿名访客重命名会话被拒
    Given 一个未登录的访客
    When 访客尝试重命名某段会话
    Then 返回 401 未授权
