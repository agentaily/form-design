# 契约来源：PR #76（URL 状态持久化 —— 把 app 内「有状态的视图」反映进 URL，刷新/深链/分享自动恢复）。
# 续 §26（设计对话持久化，PR #48）+ §26.9（多会话，PR #65）+ §12/§14/§17（设置浮层）：
# 这些 feature 已保证「对话写进后端、能列出/切换会话、设置是路由反映的浮层」；本 feature 只新增一层
# 可观察行为 —— 把【哪一段会话】【设置在哪个 tab】反映进 URL，使刷新/深链/前进后退都落回同一状态。
#
# 不重述：会话表结构、转写持久化时机、设置浮层的开合实现 —— 那些在 §26 / §26.9 / §12-§17 的 feature
# 与 src/core/chatSessionClient.ts、src/settings.jsx、src/App.jsx 的桩里。
#
# 关键契约（本 feature 据此措辞，落点 src/core/router.ts 纯函数 + App.jsx 接线）：
#   * 设计会话进 URL 的载体是 query 参数 `?s=<sessionId>`（与 §26.2 的客户端稳定 session id 同值）。
#     根路由 `/` 承载设计器；`?s=` 与设置路径 `/settings/:tab` 正交（可共存）。
#   * 设置 tab 进 URL 的载体是路径段 `/settings/account` | `/settings/integrations`；裸 `/settings`
#     退化为默认 tab（集成）。未知 tab 段或更深的路径不是设置路由（退化到设计器，不半开浮层）。
#   * URL 无 `?s=` 或值非法 → 退化到当前/新建会话（getOrCreate），不报错；首次进入会把解析出的
#     session id 规整进 URL（replaceState，不新增历史项），使其可分享/可书签。
#   * 切换/新建会话改 URL（pushState，故浏览器后退可回到上一段会话）；前进/后退切回对应会话，
#     绝不把 A 会话的转写串到 B 会话。
#
# 飞书多维表格选择「进 URL」当前无可落 UI：DS 0.10.0 / §16.9 后飞书集成只配 App ID + App Secret，
# 表格在发布时由后端 per-form 自动创建（无「切表」侧边栏），故本 feature 不含飞书表场景（见 PR #76 说明）。
Feature: app 内有状态的视图反映进 URL，刷新/深链/前进后退自动恢复
  作为表单作者(owner)
  我希望当前所在的设计会话与设置 tab 体现在地址栏里
  以便我刷新不丢、能把当前状态分享/加书签、并用浏览器前进后退在会话间穿梭

  # —— 设计会话进 URL：初始化给独立 URL，刷新完整恢复对话 + 工作区 ——

  Scenario: 进入设计器时把当前会话规整进 URL
    Given owner 已登录进入设计器且地址栏没有会话参数
    When 设计器解析出当前的 design session id
    Then 地址栏被规整为带上该会话的 `?s=<sessionId>` 参数
    And 这次规整不新增浏览器历史项（replaceState）

  Scenario: 带会话参数的 URL 刷新后完整恢复对话与工作区
    Given owner 已登录且地址栏带着某段已持久化会话的 `?s=<sessionId>`
    When owner 刷新设计器页面
    Then 设计器以该 session id 为活跃会话
    And 该会话的对话历史按原顺序重新出现在对话区
    And 该会话已生成的表单工作区（标题/字段/编辑态）随之恢复
    And owner 可以接着这段会话继续发送消息

  Scenario: URL 没有会话参数时退化到当前/新建会话且不报错
    Given owner 已登录进入设计器且地址栏没有会话参数
    When 设计器加载
    Then 设计器退化为 getOrCreate 出的当前会话（或新建一段）
    And 不报错

  Scenario: 会话参数为非法/未持久化的值时退化为空态而不串内容
    Given 地址栏带着一个本 owner 名下从未持久化过的 `?s=<sessionId>`
    When owner 加载设计器页面
    Then 设计器以该 id 为活跃会话但拉取得到空结果
    And 对话区显示为初始空态且不报错

  # —— 新建 / 切换 / 前进后退：URL 跟随活跃会话，绝不串会话 ——

  Scenario: 新建会话时把新会话写进 URL 并新增历史项
    Given owner 正在某段会话里
    When owner 新建一段会话
    Then 地址栏更新为新会话的 `?s=<新sessionId>`
    And 浏览器新增一条历史项，使后退能回到上一段会话

  Scenario: 切换会话时 URL 改为目标会话
    Given owner 名下有另一段已持久化的会话
    When owner 从最近会话菜单切换到那段会话
    Then 地址栏更新为那段会话的 `?s=<sessionId>`
    And 该会话的转写按原顺序载回对话区

  Scenario: 浏览器后退切回上一段会话且不串内容
    Given owner 先在会话 A、又切换到会话 B
    When owner 点击浏览器后退
    Then 地址栏回到会话 A 的 `?s=<A的sessionId>`
    And 对话区恢复为会话 A 的转写
    And 会话 B 的转写不出现在会话 A 的对话区里

  # —— 设置 tab 进 URL：深链/刷新回到对应 tab，关闭回到进入前页面 ——

  Scenario: 打开设置把当前 tab 反映进 URL
    Given owner 在设计器里
    When owner 打开「集成」设置
    Then 地址栏变为 `/settings/integrations`
    And 设计器在浮层下方保持挂载（未卸载）

  Scenario: 在设置里切换 tab 同步更新 URL
    Given owner 已打开设置浮层且在「集成」tab
    When owner 切到「账户」tab
    Then 地址栏更新为 `/settings/account`

  Scenario: 深链到某设置 tab 刷新后直接落在该 tab
    Given 地址栏是 `/settings/account`
    When owner 加载页面
    Then 设置浮层以「账户」tab 打开
    And 关闭设置后回到设计器（保留当前会话参数）

  Scenario: 裸 /settings 退化为默认 tab
    Given 地址栏是 `/settings`
    When owner 加载页面
    Then 设置浮层以默认的「集成」tab 打开

  Scenario: 设置参数与会话参数正交共存
    Given 地址栏是 `/settings/integrations?s=<sessionId>`
    When owner 关闭设置浮层
    Then 回到设计器根路径并仍带着 `?s=<sessionId>`
    And 该会话的工作区在浮层关闭后依旧可见
