Feature: 多租户数据隔离 + 横向越权防护
  作为系统
  我要保证每个 owner 只能看见 / 操作自己名下的配置、表单、提交数据
  以便 owner A 永远无法读取、修改、删除、或窥探 owner B 的数据

  背景：系统开放注册的多用户（§17）。每个 owner 用其真实 user id（session JWT 的 sub）
  隔离数据；owner_config / forms 的 owner_id 是真实 user id。owner-only 端点按 sub 过滤。
  关键安全约定（§17.9）：owner-only 的按 slug 操作，对「slug 不存在」与「slug 存在但不属于你」
  必须返回同一个 404——绝不用 403 或不同响应，否则会泄漏别人表单的存在性。
  涉及两个 owner：A 与 B，各自用不同邮箱注册、各自登录拿到自己的 token。

  # --- 列表 / 配置：互不可见 ----------------------------------------------------

  Scenario: 两个 owner 的表单列表互不可见
    Given owner A 与 owner B 各自注册并登录
    And A 发布了一份表单
    And B 发布了一份表单
    When A 用自己的 token 列出表单
    Then 列表只含 A 自己发布的表单
    And 列表不含 B 发布的任何表单

  Scenario: 两个 owner 的集成配置互相隔离
    Given owner A 与 owner B 各自注册并登录
    And A 保存了自己的 DeepSeek 配置
    When B 用自己的 token 读取集成配置
    Then B 读到的是 B 自己的配置（A 配置前为未配置的空骨架）
    And B 读不到 A 的任何配置值

  Scenario: 一个 owner 保存配置不影响另一个 owner 的配置
    Given owner A 与 owner B 各自注册并登录
    And A 与 B 各自保存了不同的 DeepSeek 配置
    When A 重新读取自己的配置
    Then A 读到的仍是 A 自己保存的那份
    And A 的配置不被 B 的保存覆盖

  # --- 横向越权：A 拿 B 的 slug ------------------------------------------------

  Scenario: A 用 B 的 slug 改表单状态返回 404
    Given owner A 与 owner B 各自注册并登录
    And B 发布了一份表单，得到 slug S
    When A 用自己的 token PATCH slug S 改状态
    Then 响应状态码为 404
    And B 的那份表单状态未被改动

  Scenario: A 用 B 的 slug 删表单返回 404
    Given owner A 与 owner B 各自注册并登录
    And B 发布了一份表单，得到 slug S
    When A 用自己的 token DELETE slug S
    Then 响应状态码为 404
    And B 的那份表单仍然存在

  Scenario: A 用 B 的 slug 看提交返回 404
    Given owner A 与 owner B 各自注册并登录
    And B 发布了一份表单，得到 slug S
    When A 用自己的 token 拉取 slug S 的提交列表
    Then 响应状态码为 404
    And 没有读取任何飞书配置、没有打飞书上游

  Scenario: 跨 owner 的 404 与不存在的 slug 不可区分（不暴露存在性）
    Given owner A 与 owner B 各自注册并登录
    And B 发布了一份表单，得到一个真实存在但归 B 的 slug S
    When A 分别用一个不存在的 slug 与 B 的真实 slug S 请求 PATCH / DELETE / 看提交
    Then 两种情况都返回 404
    And 两种情况的响应不可区分（不泄漏 S 确实存在）

  # --- 看提交：从 D1 主存读回当前 owner 自己的提交（架构转向 PR-2）-------------

  Scenario: owner 看提交读回的是自己 D1 里的提交
    Given owner A 与 owner B 各自注册并登录
    And A 与 B 各发布一份表单
    And A 的表单与 B 的表单各收到一份内容不同的提交
    When A 拉取自己那份表单的提交列表
    Then 只返回 A 自己表单的提交（从 D1 按 owner 隔离读）
    And 绝不返回 B 表单的提交

  # --- 公开 submit：落 A 的 D1，并 best-effort 同步进 slug 所属 owner 的飞书 ---

  Scenario: 匿名提交 best-effort 同步进该 slug 所属 owner 的飞书
    Given owner A 与 owner B 各自注册并登录
    And A 与 B 各配好了自己的飞书
    And A 发布了一份表单，得到 slug SA
    When 一个匿名答题者向 slug SA 提交一份作答
    Then 后台同步把这份作答写进 A（slug SA 所属 owner）的飞书表
    And 这份作答绝不同步进 B 或任何其它 owner 的飞书表

  Scenario: 不同 owner 的 slug 各自路由到各自的飞书
    Given owner A 与 owner B 各自注册并登录
    And A 与 B 各配好了自己的飞书、各发布一份表单（slug SA / slug SB）
    When 匿名答题者分别向 SA 与 SB 各提交一份作答
    Then 后台同步把向 SA 的作答写进 A 的飞书
    And 后台同步把向 SB 的作答写进 B 的飞书
