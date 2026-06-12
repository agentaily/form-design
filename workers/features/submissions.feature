Feature: 数据后台提交列表 GET /api/forms/:slug/submissions
  作为已登录的表单 owner
  我想按表单 slug 拉取这份表单已收集到的提交列表
  以便在数据后台查看答题者的作答，且全程从我自己的飞书多维表格读取，我的凭据永不出现在客户端

  背景：这是 owner-only 端点，需先带有效 session token（见 auth.feature）。多用户（§17.9 第 4 条）：
  命中流程先做归属校验——该 slug 须属于当前登录 owner（slug 不存在或跨 owner 都 → 404、同码、不暴露存在性、
  不打飞书上游，跨 owner 场景在 tenant-isolation.feature 覆盖）；归属通过后读**当前 owner 自己**的飞书凭据，
  用 app_id+app_secret 换 tenant_access_token，再用该 token 向「多维表格记录列表」端点
  GET 记录，把每条映射成 { recordId, fields, createdTime? } 返回，附带 count。
  owner 的 app_secret 与 tenant_access_token 全程留在 Worker 内，绝不出现在任何响应、头或日志里；
  响应也不含 app_token / table_id / owner_id。下列场景均在 owner 自己名下进行。

  Scenario: 无鉴权访问数据后台返回 401
    Given 一份已发布的表单
    When 未鉴权地请求该表单的提交列表
    Then 响应状态码为 401
    And 没有向上游飞书发起任何请求

  Scenario: 列出提交并返回 count
    Given 一个已登录的 owner
    And 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格记录列表接口将返回 code 为 0 且带两条记录
    When owner 带有效 token 请求该表单的提交列表
    Then 响应状态码为 200
    And 响应体的 submissions 含两条提交
    And 每条提交带有 recordId 与 fields
    And 响应体的 count 为 2

  Scenario: 空表时返回空列表且 count 为 0
    Given 一个已登录的 owner
    And 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格记录列表接口将返回 code 为 0 且无任何记录
    When owner 带有效 token 请求该表单的提交列表
    Then 响应状态码为 200
    And 响应体的 submissions 为空数组
    And 响应体的 count 为 0

  Scenario: 读记录请求打到 owner 配置的 app token 与 table id 对应端点
    Given 一个已登录的 owner
    And 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格记录列表接口将返回 code 为 0 且带两条记录
    When owner 带有效 token 请求该表单的提交列表
    Then 读记录请求打到了 owner 配置的 app token 与 table id 对应的端点
    And 读记录请求带有换取到的 tenant_access_token 作为 Bearer 凭据

  Scenario: 拉取不存在的 slug 返回 404 且不打飞书上游
    Given 一个已登录的 owner
    And 一个已保存完整飞书凭据的 owner
    And 一个从未发布过的 slug
    When owner 带有效 token 请求该不存在 slug 的提交列表
    Then 响应状态码为 404
    And 没有向上游飞书发起任何请求

  Scenario: owner 未配飞书时返回 409 且不打上游
    Given 一个已登录的 owner
    And 一个未配置飞书的 owner
    And 一份已发布的表单
    When owner 带有效 token 请求该表单的提交列表
    Then 响应状态码为 409 并提示 owner 未配置飞书
    And 没有向上游飞书发起任何请求

  Scenario: 换 tenant_access_token 失败时返回错误且不泄漏 app secret
    Given 一个已登录的 owner
    And 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回非 0 的业务错误码
    When owner 带有效 token 请求该表单的提交列表
    Then 代理返回可辨识的错误响应
    And 错误响应里不包含 owner 的明文飞书 app secret
    And 没有向上游飞书多维表格记录列表接口发起请求

  Scenario: 读记录上游报错时返回错误且不泄漏 token
    Given 一个已登录的 owner
    And 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格记录列表接口将返回非 0 的业务错误码
    When owner 带有效 token 请求该表单的提交列表
    Then 代理返回可辨识的错误响应
    And 错误响应里不包含换取到的 tenant_access_token
    And 错误响应里不包含 owner 的明文飞书 app secret

  Scenario: 整个响应里不含任何明文凭据
    Given 一个已登录的 owner
    And 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格记录列表接口将返回 code 为 0 且带两条记录
    When owner 带有效 token 请求该表单的提交列表
    Then 整个响应里不包含 owner 的明文飞书 app secret
    And 整个响应里不包含换取到的 tenant_access_token
    And 整个响应里不包含 owner 配置的飞书 app token 与 table id
