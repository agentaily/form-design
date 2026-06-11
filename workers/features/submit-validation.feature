Feature: 提交校验 状态门与 answers 对 schema 必填校验 POST /api/submit
  作为表单 owner
  我想让答题者只能往「开放中」的表单提交、且必须填齐必填字段
  以便我的飞书多维表格里不混入「已关闭表单的提交」或「漏填必填项」这类脏数据

  背景：在 §16.5 的 formExists（form 不存在 → 404）之后、§15 飞书写入之前，POST /api/submit 增加两道门：
  ①状态门——读该 form 的 status，非 published（draft/closed）→ 409 拒收，不读 owner 配置、不打飞书上游；
  ②answers 对 schema 校验——按 form 的 fields 校验，required 字段缺失或空值 → 400，不打飞书上游。
  两步都在飞书上游之前，确保脏提交绝不写进 owner 的表。表单经 POST /api/forms 发布出来即 published，
  关闭提交通过 PATCH 把 status 改成 closed（见 form-management.feature）。
  注意两个 409 语义不同（「表单未开放提交」vs「owner 未配飞书」），靠 error 文案区分。

  Scenario: 向已发布表单提交满足必填的作答正常写入
    Given 一个已保存完整飞书凭据的 owner
    And 一份含必填字段且状态为 published 的已发布表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口将返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 提交一份填齐了所有必填字段的作答
    Then 响应状态码为 200
    And 响应体的 ok 为真

  Scenario: 向已关闭表单提交返回 409 且不打飞书上游
    Given 一个已保存完整飞书凭据的 owner
    And 一份状态为 closed 的表单
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 409
    And 错误响应提示表单未开放提交
    And 没有向上游飞书发起任何请求

  Scenario: 向草稿表单提交返回 409 且不打飞书上游
    Given 一个已保存完整飞书凭据的 owner
    And 一份状态为 draft 的表单
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 409
    And 没有向上游飞书发起任何请求

  Scenario: 漏填必填字段返回 400 且不打飞书上游
    Given 一个已保存完整飞书凭据的 owner
    And 一份含一个必填字段「姓名」且状态为 published 的已发布表单
    When 答题者带着该表单的 slug 提交一份不含「姓名」答案的作答
    Then 响应状态码为 400
    And 没有向上游飞书发起任何请求

  Scenario: 必填字段填了空值视为漏填返回 400
    Given 一个已保存完整飞书凭据的 owner
    And 一份含一个必填字段「姓名」且状态为 published 的已发布表单
    When 答题者带着该表单的 slug 提交一份「姓名」答案为空字符串的作答
    Then 响应状态码为 400
    And 没有向上游飞书发起任何请求

  Scenario: 多选必填字段为空数组视为漏填返回 400
    Given 一个已保存完整飞书凭据的 owner
    And 一份含一个必填多选字段「兴趣」且状态为 published 的已发布表单
    When 答题者带着该表单的 slug 提交一份「兴趣」答案为空数组的作答
    Then 响应状态码为 400
    And 没有向上游飞书发起任何请求

  Scenario: 非必填字段缺失不影响提交
    Given 一个已保存完整飞书凭据的 owner
    And 一份含一个必填字段与一个非必填字段且状态为 published 的已发布表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口将返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 提交一份只填了必填字段的作答
    Then 响应状态码为 200
    And 响应体的 ok 为真

  Scenario: 状态门在校验失败时绝不触碰 owner 配置
    Given 一个未配置飞书的 owner
    And 一份状态为 closed 的表单
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 409
    And 错误响应提示表单未开放提交
    And 错误响应不是「owner 未配置飞书」
