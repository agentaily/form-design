Feature: owner 鉴权 POST /api/auth/login 与 owner-only 端点保护
  作为表单 owner
  我想用预置的 owner 密码登录拿到一个 session token，并用它访问设计态与管理态的端点
  以便我的配置存取、表单发布、连接测试、LLM 代理、数据后台只对持有密码的我开放，而答题者的公开端点保持开放

  背景：MVP 单 owner，方案 A——owner 用预置密码（Worker secret OWNER_PASSWORD）登录，
  后端校验后签发一个短期 session JWT（用 Worker secret AUTH_SECRET 以 HS256 签名，
  payload 含 sub='default' + exp）；owner-only 端点凭 Authorization: Bearer <jwt> 通行。
  公开端点（GET /api/forms/:slug、POST /api/submit、GET /health、POST /api/auth/login 自身）
  不挂鉴权。OWNER_PASSWORD 与 AUTH_SECRET 全程留在 Worker 内，绝不出现在任何响应、头或日志里。

  Scenario: 正确密码登录得到 token
    Given 一个配置了 owner 密码的后端
    When owner 用正确的密码请求登录
    Then 响应状态码为 200
    And 响应体带有一个非空的 token

  Scenario: 错误密码登录返回 401
    Given 一个配置了 owner 密码的后端
    When owner 用错误的密码请求登录
    Then 响应状态码为 401
    And 没有签发任何 token

  Scenario: 缺少密码字段登录返回 401
    Given 一个配置了 owner 密码的后端
    When owner 提交缺少 password 字段的登录请求
    Then 响应状态码为 401
    And 没有签发任何 token

  Scenario: 登录响应里不含 owner 密码与签名密钥
    Given 一个配置了 owner 密码的后端
    When owner 用正确的密码请求登录
    Then 整个响应里不包含 owner 登录密码
    And 整个响应里不包含 JWT 签名密钥

  Scenario: 不带 token 访问 owner-only 端点返回 401
    When 未鉴权地请求一个 owner-only 端点
    Then 响应状态码为 401
    And 该 owner-only 端点的业务逻辑没有被执行

  Scenario: 带无效 token 访问 owner-only 端点返回 401
    Given 一个配置了 owner 密码的后端
    When 带一个伪造或无法验签的 token 请求一个 owner-only 端点
    Then 响应状态码为 401
    And 该 owner-only 端点的业务逻辑没有被执行

  Scenario: 带过期 token 访问 owner-only 端点返回 401
    Given 一个配置了 owner 密码的后端
    And 一个已过期的 session token
    When 带该过期 token 请求一个 owner-only 端点
    Then 响应状态码为 401
    And 该 owner-only 端点的业务逻辑没有被执行

  Scenario: 带有效 token 访问 owner-only 端点通过鉴权
    Given 一个配置了 owner 密码的后端
    And owner 已用正确密码登录拿到 token
    When 带该有效 token 请求一个 owner-only 端点
    Then 鉴权通过且请求进入该端点的业务逻辑

  Scenario: 公开端点无需 token 即可访问
    Given 一份已发布的表单
    When 答题者无鉴权地拉取该 slug 对应的表单
    Then 鉴权通过且请求进入该端点的业务逻辑

  Scenario: 401 错误响应里不泄漏签名密钥
    Given 一个配置了 owner 密码的后端
    When 带一个伪造或无法验签的 token 请求一个 owner-only 端点
    Then 响应状态码为 401
    And 整个响应里不包含 JWT 签名密钥
