Feature: 连接测试 POST /api/config/test 探一下已保存配置能否连通
  作为表单 owner
  我想在集成设置里点「测试连接」看 DeepSeek 与飞书凭据能不能用
  以便在真正发布前确认后端代我持有的那份配置是连通的

  背景：测的是 D1 里已保存的那份配置，凭据不在请求体里收，由后端解密后
  各自探一次轻量上游——DeepSeek 调 GET /models 看 key 是否有效，飞书调
  自建应用换 tenant_access_token 看 app_id+app_secret 是否有效。两条结果各自独立，
  HTTP 始终 200（连不通是正常结果，不是 HTTP 错误），凭据绝不出现在响应或 message 里。
  鉴权前置（§17）：POST /api/config/test 现为 owner-only，需先带有效 session token；
  下列场景的 owner 均已登录，§14 的连接测试行为不变，只多了这道鉴权门（缺/坏 token → 401，见 auth.feature）。

  Scenario: 两条都配且上游都 OK 时两个连接都通过
    Given 一个已保存 DeepSeek key 与完整飞书凭据的 owner
    And 上游 DeepSeek models 接口将返回成功
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    When owner 触发连接测试
    Then 响应状态码为 200
    And DeepSeek 这条结果 ok 为真
    And 飞书这条结果 ok 为真

  Scenario: DeepSeek key 失效时该条 ok 为假且 message 不含 key
    Given 一个已保存 DeepSeek key 与完整飞书凭据的 owner
    And 上游 DeepSeek models 接口将以 401 拒绝
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    When owner 触发连接测试
    Then 响应状态码为 200
    And DeepSeek 这条结果 ok 为假
    And DeepSeek 这条结果的 message 不包含 owner 的明文 DeepSeek key
    And 飞书这条结果 ok 为真

  Scenario: 飞书凭据失效时该条 ok 为假且 message 不含 app secret
    Given 一个已保存 DeepSeek key 与完整飞书凭据的 owner
    And 上游 DeepSeek models 接口将返回成功
    And 上游飞书 tenant_access_token 接口将返回非 0 的业务错误码
    When owner 触发连接测试
    Then 响应状态码为 200
    And 飞书这条结果 ok 为假
    And 飞书这条结果的 message 不包含 owner 的明文飞书 app secret
    And DeepSeek 这条结果 ok 为真

  Scenario: 某块未配置时该条 ok 为假并说明未配置
    Given 一个已保存 DeepSeek key 但未配置飞书的 owner
    And 上游 DeepSeek models 接口将返回成功
    When owner 触发连接测试
    Then 响应状态码为 200
    And DeepSeek 这条结果 ok 为真
    And 飞书这条结果 ok 为假并说明未配置
    And 没有向上游飞书发起任何请求

  Scenario: 两块都未配置时两条都 ok 为假并说明未配置
    Given 一个从未配置过的 owner
    When owner 触发连接测试
    Then 响应状态码为 200
    And DeepSeek 这条结果 ok 为假并说明未配置
    And 飞书这条结果 ok 为假并说明未配置
    And 没有向任何上游发起请求

  Scenario: 响应里不含任何明文密钥
    Given 一个已保存 DeepSeek key 与完整飞书凭据的 owner
    And 上游 DeepSeek models 接口将以 401 拒绝
    And 上游飞书 tenant_access_token 接口将返回非 0 的业务错误码
    When owner 触发连接测试
    Then 整个响应里不包含 owner 的明文 DeepSeek key
    And 整个响应里不包含 owner 的明文飞书 app secret

  # 按卡测试 + 传入待测凭据（PR #72）：可只测一个服务、用请求体传入的凭据探测（verify-before-save，
  # 不依赖已存配置）；凭据未传则回退到已存；传入的凭据同样绝不落响应 / message / 日志。
  Scenario: 只测 DeepSeek 时不探测飞书
    Given 一个已保存 DeepSeek key 与完整飞书凭据的 owner
    And 上游 DeepSeek models 接口将返回成功
    When owner 只触发 DeepSeek 的连接测试
    Then 响应状态码为 200
    And 响应只含 DeepSeek 这条结果
    And DeepSeek 这条结果 ok 为真
    And 没有向上游飞书发起任何请求

  Scenario: 用请求体传入的 DeepSeek key 探测而非已存
    Given 一个已保存 DeepSeek key 的 owner
    And 上游 DeepSeek models 接口将返回成功
    When owner 用一个未保存的 DeepSeek key 触发 DeepSeek 的连接测试
    Then 响应状态码为 200
    And DeepSeek 这条结果 ok 为真
    And 上游收到的是请求体传入的那个 key 而非已存的 key

  Scenario: 不传凭据时回退到已存配置
    Given 一个已保存 DeepSeek key 的 owner
    And 上游 DeepSeek models 接口将返回成功
    When owner 不带凭据触发 DeepSeek 的连接测试
    Then 响应状态码为 200
    And 上游收到的是已存的 DeepSeek key

  Scenario: 用请求体传入的飞书凭据探测未配置过飞书的 owner
    Given 一个已保存 DeepSeek key 但未配置飞书的 owner
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    When owner 用一组未保存的飞书凭据触发飞书的连接测试
    Then 响应状态码为 200
    And 飞书这条结果 ok 为真
    And 上游飞书收到的是请求体传入的那组凭据
    And 没有向上游 DeepSeek 发起任何请求

  Scenario: 传入的凭据不出现在响应里
    Given 一个未配置任何凭据的 owner
    And 上游 DeepSeek models 接口将以 401 拒绝
    When owner 用一个未保存的 DeepSeek key 触发 DeepSeek 的连接测试
    Then 整个响应里不包含请求体传入的明文 DeepSeek key
