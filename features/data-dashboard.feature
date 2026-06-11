# 契约来源：后端 SPEC §18（GET /api/forms/:slug/submissions，owner-only：返回该表单
# 已收集的提交列表 { submissions:[{ recordId, fields, createdTime? }], count }）
# + §17（owner-only 鉴权，缺/坏/过期 token → 401）。本 feature 描述前端「数据后台」
# （owner 侧「看提交」）的可观察行为，不重述 Worker 内部的飞书换 token / 读记录约定。
#
# 入口：在「我的表单」(src/forms-panel.jsx) 每份表单行下提供「看提交」入口，打开后
#   按该表单 slug 调 GET /api/forms/:slug/submissions 拉取提交列表 + count。
# 前端契约见 src/core/submissionsClient.ts（owner-only，复用 apiClient 的 Bearer 注入），
#   视图见 src/submissions-view.jsx（SubmissionsView，挂在 FormsPanel 每项下）。
# owner-only：任一调用 401 → 引导先登录（复用 #11 / §17 的 onNeedLogin 模式）。
Feature: 数据后台查看表单提交
  作为表单作者(owner)
  我想在「我的表单」里查看某份表单已经收到的提交
  以便回收和核对答题者交上来的作答

  # —— 列出提交 + count ——

  Scenario: 查看一份表单的提交列表与数量
    Given owner 已登录并打开「我的表单」
    And 其中一份表单已收到若干提交
    When owner 点击该表单的「看提交」
    And 后端返回该表单的提交列表与数量
    Then 列出每条提交的字段值
    And 显示提交总数

  # —— 空态 ——

  Scenario: 一份表单还没有提交时显示空态
    Given owner 已登录并打开「我的表单」
    And 其中一份表单还没有任何提交
    When owner 点击该表单的「看提交」
    And 后端返回空的提交列表
    Then 显示「还没有收到提交」的空态且无报错

  # —— owner-only：401 → 引导先登录 ——

  Scenario: 会话失效查看提交时引导先登录
    Given owner 打开「我的表单」并点击某份表单的「看提交」
    When 拉取提交列表返回 401
    Then 提示需要先登录
    And 自动弹出 owner 登录框

  # —— 未配飞书：409 → 引导去集成设置 ——

  Scenario: 未连接飞书时提示去集成设置
    Given owner 已登录并点击某份表单的「看提交」
    When 后端返回 409 表示尚未配置飞书
    Then 页面提示需要先在集成设置里连接飞书

  # —— 上游错误：502 ——

  Scenario: 读取提交遇上游错误时提示稍后重试
    Given owner 已登录并点击某份表单的「看提交」
    When 后端返回 502 上游错误
    Then 页面提示加载提交失败请稍后重试
