Feature: 提交写飞书多维表格 POST /api/submit 答题落库
  作为表单 owner
  我想让答题者在公开填写页提交的作答写进我自己的飞书多维表格
  以便用我自己的飞书租户收集数据，且我的 app secret 与 tenant_access_token 永不出现在客户端

  背景：owner 的飞书凭据已由集成配置加密存入 D1，Worker 在内部解密后先用
  app_id+app_secret 换 tenant_access_token，再用该 token 向「多维表格新增记录」端点
  写一条记录。answers 的 label 直接作为飞书 fields 的列名、value 原样传（多选为字符串数组）。
  app secret 与 tenant_access_token 全程留在 Worker 内，绝不出现在任何响应、头或日志里。
  自 §16.5 起，/api/submit 的 body 增加必填的 formSlug：route 先校验 form 存在
  （形状级校验过后），再走以下飞书写入流程；本节 §15 的写入 / 错误 / 不泄漏行为不变，
  只是每个场景多了「已发布表单 + 带合法 slug 提交」这一前置门。
  自 §20 起，formExists 之后、飞书写入之前又多了两道门（详见 submit-validation.feature）：
  状态门（非 published → 409）与 answers 对 schema 的必填校验（required 缺失/空值 → 400）。
  本节这些「正常写入 / 飞书错误 / 不泄漏」场景的前置表单均为 published（发布即 published），
  且提交的 answers 须填齐该表单的必填字段，方能走到飞书写入这一步——否则会先被 §20 拦下。

  Scenario: 飞书已配且上游都 OK 时写入成功并返回 recordId
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口将返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 200
    And 响应体的 ok 为真
    And 响应体带有上游返回的 recordId

  Scenario: answers 正确映射进飞书 fields
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口将返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 提交含一个文本答案与一个多选答案的作答
    Then 写记录请求体的 fields 里文本答案以 label 为键、值原样
    And 写记录请求体的 fields 里多选答案以 label 为键、值为原样字符串数组
    And 写记录请求打到了 owner 配置的 app token 与 table id 对应的端点

  Scenario: 飞书未配时返回 409 且不打上游
    Given 一个未配置飞书的 owner
    And 一份已发布的表单
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 409 并提示 owner 未配置飞书
    And 没有向上游飞书发起任何请求

  Scenario: 空 answers 时返回 400 且不打上游
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    When 答题者带着该表单的 slug 向 /api/submit 提交一份空 answers 的请求
    Then 响应状态码为 400
    And 没有向上游飞书发起任何请求

  Scenario: 缺少 answers 时返回 400 且不打上游
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    When 答题者带着该表单的 slug 向 /api/submit 提交缺少 answers 的请求
    Then 响应状态码为 400
    And 没有向上游飞书发起任何请求

  Scenario: 换 tenant_access_token 失败时返回错误且不泄漏 app secret
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回非 0 的业务错误码
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 代理返回可辨识的错误响应
    And 错误响应里不包含 owner 的明文飞书 app secret
    And 没有向上游飞书多维表格新增记录接口发起请求

  Scenario: 写记录上游报错时返回错误且不泄漏 token
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口将返回非 0 的业务错误码
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 代理返回可辨识的错误响应
    And 错误响应里不包含换取到的 tenant_access_token
    And 错误响应里不包含 owner 的明文飞书 app secret

  Scenario: 整个响应里不含任何明文凭据
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口将返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 整个响应里不包含 owner 的明文飞书 app secret
    And 整个响应里不包含换取到的 tenant_access_token
