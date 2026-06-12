# 契约来源：后端 SPEC §24（找回密码：公开发起永远 200 防枚举、公开确认凭一次性 reset
#   token 重置密码）+ §22（发信抽象 Resend / 一次性 token 表 auth_tokens）+ §17.2（密码强度 ≥ 8）。
# 端点：POST /api/auth/password-reset/request（公开，body { email }，永远 200 防枚举）、
#   POST /api/auth/password-reset/confirm（公开，body { token, password }，成功 200；
#   token 失效/过期/已用 或 弱密码 → 400 统一文案）。
# token：kind='reset'、TTL 1h（窗口短）、单次使用、只存 SHA-256（库泄漏拿不到活 token，§22.4）；
#   改密成功后作废该 user 其余 reset token（防旧邮件二次改密）。链接落前端 /reset-password?token=。
# UI 一律消费 @agentaily/design-system（输入 / 按钮 / 反馈），不手搓组件。凭据绝不硬编码。
Feature: 找回密码
  作为忘记密码的表单作者(owner)
  我想凭注册邮箱收到一封重置链接并设置新密码
  以便重新登录，而整个流程不泄漏某个邮箱是否注册过

  背景：发起与确认两个端点都公开（忘密码的人本来登录不了），靠一次性 reset token 自证身份。
  发起永远回成功（防邮箱枚举）；确认校验 token 有效性 + 新密码强度后才真正改密。

  # —— 发起:防邮箱枚举(永远成功) ——

  Scenario: 已注册邮箱发起找回会收到重置邮件
    Given 一个已注册的邮箱
    When 该用户用此邮箱发起找回密码
    Then 收到中性的成功提示
    And 系统向该邮箱发出一封重置密码邮件

  Scenario: 未注册邮箱发起找回得到相同的中性回应
    Given 一个从未注册过的邮箱
    When 该用户用此邮箱发起找回密码
    Then 收到与已注册邮箱完全一致的中性成功提示
    And 系统不发送任何邮件

  Scenario: 发起时发信失败仍回中性成功
    Given 一个已注册的邮箱
    And 发信通道暂时不可用
    When 该用户用此邮箱发起找回密码
    Then 仍然收到中性的成功提示且不暴露内部失败

  # —— 确认:成功改密 ——

  Scenario: 凭有效链接设置新密码
    Given 用户收到重置邮件并打开其中的有效链接
    When 用户输入一个合法的新密码并提交
    Then 密码被重置成功
    And 用户可用新密码登录
    And 旧密码不再可用

  Scenario: 改密成功后同一重置链接失效
    Given 用户已用某条重置链接成功改过一次密码
    When 用户再次用同一条链接尝试改密
    Then 改密被拒绝并提示链接失效

  # —— 确认:token 边界 ——

  Scenario: 过期的重置链接不能改密
    Given 一条重置链接已超过有效期
    When 用户用该链接提交新密码
    Then 改密被拒绝并提示链接失效
    And 账号密码保持不变

  Scenario: 伪造或无效的重置 token 不能改密
    Given 一条带无效 token 的重置链接
    When 任何人用该 token 提交新密码
    Then 改密被拒绝并提示链接失效
    And 不修改任何账号的密码

  # —— 确认:新密码强度 ——

  Scenario: 新密码过弱时拒绝改密
    Given 用户打开有效的重置链接
    When 用户输入一个少于 8 位的新密码并提交
    Then 改密被拒绝并提示密码过弱
    And 账号密码保持不变

  # —— 前端流程 ——

  Scenario: 从登录框发起找回密码
    Given 打开了 owner 登录框
    When 作者点击「忘记密码」并输入邮箱发起
    Then 显示中性提示「若该邮箱已注册，我们已发送重置链接」

  Scenario: 在重置页设置新密码后引导回登录
    Given 作者打开重置密码落地页且链接有效
    When 作者设置一个合法的新密码并提交
    Then 提示改密成功
    And 引导作者回到登录
