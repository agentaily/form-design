Feature: owner 集成配置的保存与读取
  作为表单 owner
  我想连接我的 DeepSeek 与飞书多维表格凭据
  以便后端代为安全持有，后续的 LLM 代理与答题落库都走我自己的额度与租户

  背景：MVP 单 owner，固定单行配置，不做多租户。
  密钥字段（DeepSeek key、飞书 app secret）加密落库，读取一律掩码、绝不返回明文。
  鉴权前置（§17）：GET/POST /api/config 现为 owner-only，需先带有效 session token；
  下列场景的 owner 均已登录，§12 的存取行为不变，只多了这道鉴权门（缺/坏 token → 401，见 auth.feature）。

  Scenario: 保存配置后读回得到掩码视图
    Given 一个空的 owner 配置
    When owner 提交含 DeepSeek key 与完整飞书凭据的配置
    Then 配置保存成功
    And 读回的 DeepSeek key 是掩码串
    And 读回的飞书 app secret 是掩码串
    And 读回的 DeepSeek model 与飞书 app id、app token、table id 为明文回显
    And 读回带有更新时间

  Scenario: 读取时密钥绝不以明文返回
    Given 一个已保存的 owner 配置
    When owner 读取当前配置
    Then 响应里不包含 DeepSeek key 的明文
    And 响应里不包含飞书 app secret 的明文

  Scenario: 密钥加密往返可还原
    Given 一个用于加密的 AES-GCM 主密钥
    When 对一段密钥明文加密再用同一主密钥解密
    Then 解密结果与原始明文一致
    And 同一段明文两次加密得到不同的 iv

  Scenario: 未配置时读取返回空骨架
    Given 一个从未配置过的 owner
    When owner 读取当前配置
    Then 返回结构完整但各字段为空的骨架
    And 请求被视为正常态而非错误

  Scenario: 再次保存覆盖已有配置
    Given 一个已保存的 owner 配置
    When owner 用新的 DeepSeek key 再次保存配置
    Then 读回的掩码反映新的 DeepSeek key
    And 更新时间被刷新

  Scenario: 缺少必填的 DeepSeek key 被拒绝
    Given 一个空的 owner 配置
    When owner 提交缺少 DeepSeek key 的配置
    Then 保存被拒绝并提示 DeepSeek key 为必填
    And 配置未被写入
