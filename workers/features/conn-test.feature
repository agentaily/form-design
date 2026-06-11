Feature: 连接测试 POST /api/config/test 探一下已保存配置能否连通
  作为表单 owner
  我想在集成设置里点「测试连接」看 DeepSeek 与飞书凭据能不能用
  以便在真正发布前确认后端代我持有的那份配置是连通的

  背景：测的是 D1 里已保存的那份配置，凭据不在请求体里收，由后端解密后
  各自探一次轻量上游——DeepSeek 调 GET /models 看 key 是否有效，飞书调
  自建应用换 tenant_access_token 看 app_id+app_secret 是否有效。两条结果各自独立，
  HTTP 始终 200（连不通是正常结果，不是 HTTP 错误），凭据绝不出现在响应或 message 里。

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
