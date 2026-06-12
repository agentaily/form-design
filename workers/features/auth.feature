Feature: owner 鉴权 注册 / 登录 与 owner-only 端点保护
  作为表单 owner
  我想用邮箱 + 密码自助注册或登录拿到一个 session token，并用它访问设计态与管理态的端点
  以便我的配置存取、表单发布、连接测试、LLM 代理、数据后台只对持有我账号的我开放，而答题者的公开端点保持开放

  背景：系统开放注册（§17）——任意邮箱 + 密码（≥ 8 位）自助注册即成 owner，注册即登录。
  后端校验后签发一个短期 session JWT（用 Worker secret AUTH_SECRET 以 HS256 签名，
  payload 的 sub 是该用户的真实 user id，对齐 owner_config.owner_id / forms.owner_id）；
  owner-only 端点凭 Authorization: Bearer <jwt> 通行，并按 sub 隔离数据。明文密码绝不入库，
  只存 PBKDF2-HMAC-SHA256 派生的 hash + per-user salt + iterations。公开端点
  （GET /api/forms/:slug、POST /api/submit、GET /health、POST /api/auth/register、
  POST /api/auth/login 自身）不挂鉴权。AUTH_SECRET 与密码全程留在 Worker 内，绝不出现在响应 / 头 / 日志。

  # --- 注册（POST /api/auth/register）-------------------------------------------

  Scenario: 用邮箱 + 密码注册成功得到 token（注册即登录）
    Given 一个开放注册的后端
    When 访客用一个未注册的合法邮箱与一个 8 位及以上的密码请求注册
    Then 响应状态码为 201
    And 响应体带有一个非空的 token
    And 该 token 的主体是新建用户的真实 user id

  Scenario: 注册一个已被占用的邮箱返回 409
    Given 一个已注册了某邮箱的后端
    When 访客用同一个邮箱再次请求注册
    Then 响应状态码为 409
    And 没有新建任何用户
    And 没有签发任何 token

  Scenario: 注册时密码过弱返回 400
    Given 一个开放注册的后端
    When 访客用一个少于 8 位的密码请求注册
    Then 响应状态码为 400
    And 没有新建任何用户

  Scenario: 注册时邮箱形状非法返回 400
    Given 一个开放注册的后端
    When 访客用一个形状非法的邮箱请求注册
    Then 响应状态码为 400
    And 没有新建任何用户

  Scenario: 注册响应里不含明文密码与签名密钥
    Given 一个开放注册的后端
    When 访客成功注册
    Then 整个响应里不包含注册时提交的明文密码
    And 整个响应里不包含 JWT 签名密钥

  # --- 登录（POST /api/auth/login）---------------------------------------------

  Scenario: 已注册用户用邮箱 + 密码登录得到 token
    Given 一个已注册了某邮箱与密码的后端
    When 该用户用正确的邮箱与密码请求登录
    Then 响应状态码为 200
    And 响应体带有一个非空的 token
    And 该 token 的主体是该用户的真实 user id

  Scenario: 密码错误登录返回统一 401
    Given 一个已注册了某邮箱与密码的后端
    When 该用户用正确邮箱但错误密码请求登录
    Then 响应状态码为 401
    And 没有签发任何 token

  Scenario: 邮箱未注册登录返回统一 401（不暴露邮箱是否存在）
    Given 一个开放注册的后端
    When 访客用一个从未注册的邮箱请求登录
    Then 响应状态码为 401
    And 错误响应与「密码错误」时不可区分
    And 没有签发任何 token

  Scenario: 缺少字段登录返回 401
    Given 一个开放注册的后端
    When 用户提交缺少 email 或 password 字段的登录请求
    Then 响应状态码为 401
    And 没有签发任何 token

  Scenario: 登录响应里不含明文密码与签名密钥
    Given 一个已注册了某邮箱与密码的后端
    When 该用户用正确的邮箱与密码请求登录
    Then 整个响应里不包含提交的明文密码
    And 整个响应里不包含 JWT 签名密钥

  # --- owner-only 端点保护（不变的鉴权门）--------------------------------------

  Scenario: 不带 token 访问 owner-only 端点返回 401
    When 未鉴权地请求一个 owner-only 端点
    Then 响应状态码为 401
    And 该 owner-only 端点的业务逻辑没有被执行

  Scenario: 带无效 token 访问 owner-only 端点返回 401
    Given 一个开放注册的后端
    When 带一个伪造或无法验签的 token 请求一个 owner-only 端点
    Then 响应状态码为 401
    And 该 owner-only 端点的业务逻辑没有被执行

  Scenario: 带过期 token 访问 owner-only 端点返回 401
    Given 一个开放注册的后端
    And 一个已过期的 session token
    When 带该过期 token 请求一个 owner-only 端点
    Then 响应状态码为 401
    And 该 owner-only 端点的业务逻辑没有被执行

  Scenario: 带有效 token 访问 owner-only 端点通过鉴权
    Given 一个已注册并登录拿到 token 的 owner
    When 带该有效 token 请求一个 owner-only 端点
    Then 鉴权通过且请求进入该端点的业务逻辑

  Scenario: 公开端点无需 token 即可访问
    Given 一份已发布的表单
    When 答题者无鉴权地拉取该 slug 对应的表单
    Then 鉴权通过且请求进入该端点的业务逻辑

  Scenario: 401 错误响应里不泄漏签名密钥
    Given 一个开放注册的后端
    When 带一个伪造或无法验签的 token 请求一个 owner-only 端点
    Then 响应状态码为 401
    And 整个响应里不包含 JWT 签名密钥
