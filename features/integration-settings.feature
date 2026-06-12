# 契约来源：后端 SPEC §12（owner 配置存取 GET/POST /api/config）+ §14（连接测试 POST /api/config/test）
# + §17（owner-only 鉴权，缺/坏 token → 401）。本 feature 描述前端「集成设置页」(/settings) 的可观察
# 行为，不重述后端字段加密 / 掩码算法（那是 Worker 内部约定）。前端契约桩见 src/core/configClient.ts，
# 页面见 src/settings.jsx（SettingsScreen），路由分流见 src/App.jsx（matchSettings → /settings）。
# 自 DS 0.6.0 起集成设置从弹窗改为独立 /settings 路由页，由两张纯展示连接卡 + 本页自己的保存栏组成；
# 步骤措辞相应从「弹窗」改为「设置页」，行为契约不变。
Feature: 集成设置页 · owner 配置 DeepSeek 与飞书
  作为表单作者(owner)
  我想在集成设置页里连接自己的 DeepSeek key 与飞书多维表格
  以便对话设计与答题落库都用我自己的额度与租户

  Scenario: 打开设置拉取并回显已保存配置（密钥掩码）
    Given owner 已登录
    And 后端已保存过 DeepSeek key 与飞书凭据
    When owner 打开集成设置
    Then 设置页用掩码值回显 DeepSeek key 与飞书 app_secret
    And 非密字段（model / app_id / app_token / table_id）以明文回显

  Scenario: 从未配置时打开设置显示空表单
    Given owner 已登录
    And 后端从未保存过配置
    When owner 打开集成设置
    Then 设置页显示空的配置表单且无报错

  Scenario: 保存有效配置成功
    Given owner 已登录并打开集成设置
    When owner 填入 DeepSeek key 与完整飞书凭据并保存
    Then 设置页提示保存成功
    And 设置页用后端返回的掩码视图回显当前配置

  Scenario: 缺 DeepSeek key 时保存被后端拒绝并提示
    Given owner 已登录并打开集成设置
    When owner 把 DeepSeek key 留空并保存
    And 后端返回 400 与错误说明
    Then 设置页显示后端给出的错误说明
    And 配置未被保存

  Scenario: 飞书字段半填时保存被后端拒绝并提示
    Given owner 已登录并打开集成设置
    When owner 只填了部分飞书字段并保存
    And 后端返回 400 与错误说明
    Then 设置页显示后端给出的错误说明
    And 配置未被保存

  Scenario: 不修改的密钥字段不会被覆盖
    Given owner 已登录并打开集成设置
    And 设置页回显着 DeepSeek key 与飞书 app_secret 的掩码值
    When owner 只改了 model 而不动两个密钥字段并保存
    Then 提交里不包含 DeepSeek key 与飞书 app_secret 的密文
    And 后端保留原有的两个密钥不变

  Scenario: 测试连接逐条显示 DeepSeek 与飞书结果
    Given owner 已登录并打开集成设置
    When owner 点击测试连接
    And 后端返回 DeepSeek 可连通、飞书凭据无效
    Then 设置页把 DeepSeek 标记为连通
    And 设置页把飞书标记为不可连通并显示其说明

  Scenario: 连不通是正常结果而非报错
    Given owner 已登录并打开集成设置
    When owner 点击测试连接
    And 后端返回两块都未配置
    Then 设置页逐条显示两块均不可连通及其说明
    And 设置页不显示请求失败的报错

  Scenario: 未登录访问集成设置引导先登录
    Given owner 未登录
    When owner 打开集成设置
    And 拉取配置返回 401
    Then 设置页提示需要先登录
    And 引导去 owner 登录页
