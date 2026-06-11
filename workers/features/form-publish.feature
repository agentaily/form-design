Feature: 表单发布与公开填写拉取 POST /api/forms 与 GET /api/forms/:slug
  作为表单 owner 与公开答题者
  我想让 owner 发布一份表单定义拿到公开 slug，答题者无需鉴权即可拉取该表单的 meta 与 fields 来渲染填写页
  以便打通「设计 → 发布 → 公开填写 → 写飞书」的闭环，且公开拉取绝不泄漏 owner 的任何凭据或私有配置

  背景：MVP 单 owner，forms 表的 owner_id 恒为 'default'，不做多租户。
  发布把 meta + fields（fields 对齐 §3.2 Field）序列化存入 D1 的 forms 表并生成公开 slug；
  公开拉取只投影 meta + fields + slug，凭据始终留在 owner_config，绝不随表单出网。
  submit 关联：/api/submit 的 body 增加 formSlug，先校验 form 存在再走飞书写入；
  本期不强校验 answers 与 fields 的字段级一致性。
  鉴权前置（§17）：POST /api/forms（发布）现为 owner-only，需先带有效 session token，
  下列「owner 向 /api/forms 发布该表单」的场景均以已登录 owner 进行（§16 发布行为不变，
  缺/坏 token → 401，见 auth.feature）；而 GET /api/forms/:slug（公开拉取）与
  POST /api/submit（答题落库）保持公开、无需 token——共享 /api/forms 前缀但公开读不受鉴权影响。

  Scenario: 发布表单得到 slug 并落库
    Given 一份含 meta 与若干字段的合法表单定义
    When owner 向 /api/forms 发布该表单
    Then 响应状态码为 201
    And 响应体带有一个非空的 slug
    And 该 slug 对应的表单已存入 forms 表

  Scenario: 公开拉取返回表单的 meta 与 fields
    Given 一份已发布的表单
    When 答题者无鉴权地拉取该 slug 对应的表单
    Then 响应状态码为 200
    And 响应体的 meta 与发布时一致
    And 响应体的 fields 与发布时一致

  Scenario: 公开拉取的响应不含任何 owner 凭据
    Given owner 已在集成配置里保存了 DeepSeek key 与完整飞书凭据
    And 一份已发布的表单
    When 答题者无鉴权地拉取该 slug 对应的表单
    Then 整个响应里不包含 owner 的明文 DeepSeek key
    And 整个响应里不包含 owner 的明文飞书 app secret
    And 整个响应里不包含 owner 的飞书 app token 与 table id
    And 整个响应里不包含 owner_id 字段

  Scenario: 拉取不存在的 slug 返回 404
    Given 一个从未发布过的 slug
    When 答题者无鉴权地拉取该 slug 对应的表单
    Then 响应状态码为 404

  Scenario: submit 带合法 slug 时正常走飞书写入
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口将返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 200
    And 响应体的 ok 为真
    And 写记录请求打到了 owner 配置的 app token 与 table id 对应的端点

  Scenario: submit 带不存在的 slug 返回 404 且不打飞书上游
    Given 一个已保存完整飞书凭据的 owner
    And 一个从未发布过的 slug
    When 答题者带着该不存在的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 404
    And 没有向上游飞书发起任何请求

  Scenario: submit 缺少 formSlug 时返回 400 且不打飞书上游
    Given 一个已保存完整飞书凭据的 owner
    When 答题者向 /api/submit 提交一份缺少 formSlug 的作答
    Then 响应状态码为 400
    And 没有向上游飞书发起任何请求

  Scenario: 发布缺少 meta 标题的表单返回 400 且不落库
    Given 一份缺少 meta 标题的表单定义
    When owner 向 /api/forms 发布该表单
    Then 响应状态码为 400
    And forms 表里没有新增任何表单

  Scenario: 发布字段数组为空的表单仍可成功
    Given 一份 meta 合法但 fields 为空数组的表单定义
    When owner 向 /api/forms 发布该表单
    Then 响应状态码为 201
    And 响应体带有一个非空的 slug
    And 公开拉取该 slug 得到的 fields 为空数组
