# 契约来源：后端 SPEC §17（owner 鉴权 + 个人资料）—— GET /api/auth/me 回 { email, emailVerified,
# displayName }、PUT /api/auth/profile 写 displayName（owner-only，JWT sub）。本 feature 描述前端
# 「设置浮层」的 **账户 tab** 可观察行为，不重述后端字段加密 / token 校验（Worker 内部约定）。
# 前端契约桩见 src/core/auth.ts（getCurrentUser / updateProfile），UI 见 src/settings.jsx
# （SettingsOverlay → AccountSection），浮层入口与路由反映见 src/App.jsx。
# 自 DS 0.8.0 起设置从 /settings 路由页改为设计器内浮起浮层（账户 + 集成双 tab）；显示名走真实
# profile 后端持久化（非 localStorage 假桩）。
Feature: 账户设置 · owner 个人资料(显示名)
  作为表单作者(owner)
  我想在账户设置里看到我的登录身份并编辑我的显示名称
  以便我的名字出现在我创建的表单与提交记录里

  Scenario: 打开账户 tab 显示身份与可编辑显示名
    Given owner 已登录
    When owner 打开账户设置
    Then 账户 tab 显示 owner 的登录邮箱
    And 账户 tab 显示可编辑的「显示名称」输入框

  Scenario: 编辑并保存显示名持久化到后端
    Given owner 已登录并打开账户设置
    When owner 把显示名称改成「陈伟」并保存
    Then 账户设置把显示名「陈伟」写到 profile 后端
    And 保存后显示名以「陈伟」回流到账户控件

  Scenario: 显示名过长保存被拦下
    Given owner 已登录并打开账户设置
    When owner 填入超过长度上限的显示名并尝试保存
    Then 账户设置不把过长的显示名写到后端
    And 账户 tab 就地提示显示名过长

  Scenario: 保存时会话失效引导先登录
    Given owner 已登录并打开账户设置
    When owner 保存显示名但后端返回 401
    Then 账户设置引导 owner 先去登录页
    And 不把 401 当作就地的保存错误展示

  Scenario: 从账户 tab 退出登录
    Given owner 已登录并打开账户设置
    When owner 在账户 tab 点击退出登录
    Then 账户设置触发退出登录
