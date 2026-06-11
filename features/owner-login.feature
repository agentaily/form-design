Feature: owner 登录解锁对话设计
  作为表单作者(owner)
  我想用预置的 owner 密码登录拿到 session token
  以便 owner-only 的对话代理 /api/chat 不再被 401 拒绝

  Scenario: 未登录时对话触发登录引导
    Given 设计器处于空状态且未登录
    When 作者发起一句对话且后端返回 401
    Then 对话提示需要先登录
    And 自动弹出 owner 登录框

  Scenario: owner 用正确密码登录
    Given 打开了 owner 登录框
    When 作者输入正确密码并提交
    Then 登录框显示已登录
    And 顶栏账户入口标记为已登录

  Scenario: 密码错误时给出可读错误
    Given 打开了 owner 登录框
    When 作者输入错误密码并提交
    Then 登录框显示密码错误
    And 顶栏账户入口仍为未登录

  Scenario: 已登录后登出
    Given 作者已登录并打开账户框
    When 作者点击登出
    Then 登录框回到密码输入态
    And 顶栏账户入口回到未登录
