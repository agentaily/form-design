# 契约来源：后端 SPEC §23（邮箱验证：注册即发 best-effort、owner-only 重发、公开确认置
#   email_verified=1、软验证不门禁功能）+ §22（发信抽象 Resend / 一次性 token 表 auth_tokens）
#   + §17.2 修订（注册去重三态：未验证可覆盖、已验证锁死）。
# 端点：POST /api/auth/verify-email/request（owner-only，永远成功 200/204）、
#   GET /api/auth/verify-email/confirm?token=（公开，成功/失败都重定向落地页带 status）。
# token：kind='verify'、TTL 24h、单次使用、只存 SHA-256（库泄漏拿不到活 token，§22.4）。
# 不门禁：未验证用户照常用全部 owner 端点；前端只多一个「邮箱未验证 · 重新发送」banner（§23.6）。
# UI 一律消费 @agentaily/design-system（banner / 按钮 / 反馈），不手搓组件。凭据绝不硬编码。
Feature: 邮箱验证（软验证）
  作为表单作者(owner)
  我想验证我的注册邮箱
  以便锁定这个邮箱归我所有（别人不能再覆盖注册），并让「邮箱未验证」提示消失；
  但在我验证之前，我仍能照常使用全部功能

  背景：注册仍是「注册即登录」（注册成功 201 + email_verified=0），额外异步发一封验证邮件；
  发信失败不让注册失败（best-effort）。验证只服务「防占座别人邮箱」+「前端 banner」，不门禁功能。

  # —— 注册即发（best-effort，不阻塞注册）——

  Scenario: 新用户注册成功并收到一封验证邮件
    Given 一个尚未注册的邮箱
    When 该用户用此邮箱与合法密码注册
    Then 注册成功且立即登录
    And 该账号处于「邮箱未验证」状态
    And 系统向该邮箱发出一封验证邮件

  Scenario: 注册时发信失败仍不影响注册成功
    Given 一个尚未注册的邮箱
    And 发信通道暂时不可用
    When 该用户用此邮箱与合法密码注册
    Then 注册仍然成功且立即登录
    And 不因发信失败而报错

  # —— 不门禁:未验证照常用功能 ——

  Scenario: 未验证用户照常使用 owner 功能
    Given 一个已注册但邮箱未验证的 owner 已登录
    When 该 owner 访问需要登录的功能
    Then 功能照常可用且不被未验证状态拦截

  # —— 前端 banner ——

  Scenario: 未验证时显示可重新发送的提示条
    Given 一个邮箱未验证的 owner 已登录
    When 进入设计器
    Then 显示「邮箱未验证」的提示条且带「重新发送」入口

  Scenario: 已验证时不显示提示条
    Given 一个邮箱已验证的 owner 已登录
    When 进入设计器
    Then 不显示「邮箱未验证」提示条

  # —— owner-only 重发（永远成功）——

  Scenario: 未验证 owner 重新发送验证邮件
    Given 一个邮箱未验证的 owner 已登录
    When 该 owner 点击「重新发送」
    Then 系统再次向其邮箱发出验证邮件
    And 给出「已重新发送」的中性反馈

  Scenario: 已验证 owner 请求重发是无副作用的成功
    Given 一个邮箱已验证的 owner 已登录
    When 该 owner 请求重发验证邮件
    Then 请求成功且不再额外发信

  Scenario: 会话失效时请求重发被引导先登录
    Given 一个 owner 的会话已失效
    When 该 owner 请求重发验证邮件
    Then 返回未授权
    And 引导其先登录

  # —— 公开确认 ——

  Scenario: 点击有效链接完成验证
    Given owner 收到验证邮件里的有效链接
    When owner 打开该链接
    Then 该账号的邮箱被标记为已验证
    And 落地页显示「邮箱已验证」

  Scenario: 同一验证链接不能用第二次
    Given owner 已用验证链接成功验证过一次
    When owner 再次打开同一条链接
    Then 落地页显示「链接已失效」
    And 账号状态保持已验证不变

  Scenario: 过期的验证链接失效
    Given 一条验证链接已超过有效期
    When owner 打开该链接
    Then 落地页显示「链接已失效」
    And 账号邮箱仍为未验证

  Scenario: 伪造或无效的验证 token 失效
    Given 一条带无效 token 的验证链接
    When 任何人打开该链接
    Then 落地页显示「链接已失效」
    And 不修改任何账号的验证状态

  # —— 验证锁死邮箱：与 §17.2 注册去重三态协作 ——

  Scenario: 邮箱未验证时可被真实主人覆盖重注册
    Given 某邮箱已被一个从未验证的账号注册占用
    When 另一人用同一邮箱与新密码重新注册
    Then 重新注册成功并成为该邮箱的新账号
    And 旧的未验证账号及其残留配置被清除

  Scenario: 邮箱一旦验证就锁死不可再被注册
    Given 某邮箱已被一个已验证的账号占用
    When 另一人用同一邮箱尝试注册
    Then 注册被拒绝并提示该邮箱已注册
    And 已验证账号不受影响
