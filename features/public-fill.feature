# 契约来源：后端 SPEC §16（GET /api/forms/:slug 公开拉取 schema：{ slug, meta, fields }）
# + §15 / §16.5（POST /api/submit 公开提交：body { formSlug, answers:[{label,value}] } 写飞书）
# + §20（提交校验：状态门 非 published → 409；漏填必填 → 400）。
# 本 feature 描述「公开填写页」(答题者侧, 无需登录) 的可观察行为，不重述 Worker 内部
# 的飞书换 token / 写记录 / slug 生成熵等约定。
#
# 路由约定（SPEC §16.4.1）：一份发布出来的表单暴露在前端路由 /f/:slug（同源），完整链接形如
#   https://<站点域名>/f/<slug>。公开页从 /f/:slug 解析 slug → GET /api/forms/:slug 拉
#   schema 渲染 → 答题者填 → POST /api/submit({ formSlug: slug, answers }) 提交。
#
# 关键安全约定：公开拉取与公开提交都是「无鉴权」端点，请求一律不带 Authorization Bearer
#   （answers 来自答题者、非 owner）。前端契约见 src/core/publicClient.ts（不复用需登录的
#   apiClient auth），路由分流见 src/core/router.ts + src/App.jsx，页面见 src/public-form.jsx。
#
# answers 收集约定（§15.2/§16.5）：把填好的字段值收集成 answers:[{ label, value }]，其中
#   value 为单值字符串（text/radio/select/consent 等）或字符串数组（多选 checkbox）。
Feature: 公开填写页（答题者无需登录）
  作为答题者
  我想通过公开链接 /f/:slug 打开一份已发布的表单并提交我的作答
  以便把我的报名/问卷信息交给表单作者，而无需任何登录

  # —— 路由分流：/f/:slug → 纯答题视图（不挂设计器那套）——

  Scenario: 访问 /f/:slug 进入公开填写页而非设计器
    Given 浏览器地址是 /f/f8Kq2pXa
    When 应用按路径分流
    Then 渲染公开填写页且只渲染答题视图
    And 不出现设计器的对话、预览或登录入口

  Scenario: 普通路径仍进入设计器
    Given 浏览器地址是 /
    When 应用按路径分流
    Then 渲染设计器而非公开填写页

  # —— 拉取并渲染：GET /api/forms/:slug → 按字段类型渲染 ——

  Scenario: 拉取并渲染已发布表单的各字段
    Given 公开链接对应的表单含标题、单行文本、多选与单选等字段
    When 答题者打开该公开链接
    And 后端返回该表单的 meta 与 fields
    Then 页面展示表单标题与介绍
    And 按字段类型渲染出对应的输入控件

  # —— 提交成功：POST /api/submit → 感谢/成功反馈 ——

  Scenario: 填好后提交成功看到感谢反馈
    Given 答题者打开了一份只含必填「姓名」的公开表单
    When 答题者填写「姓名」并点击提交
    And 后端返回提交成功
    Then 页面显示提交成功的感谢反馈

  Scenario: 提交时按约定收集 answers
    Given 答题者打开了一份含「姓名」单行文本与「兴趣」多选的公开表单
    When 答题者填写「姓名」并勾选两项「兴趣」后提交
    Then 提交请求带上对应表单的 formSlug
    And 提交请求的 answers 含「姓名」的单值与「兴趣」的多值数组

  # —— 公开请求不带 Bearer（答题者非 owner）——

  Scenario: 公开拉取与提交都不携带 owner 凭据
    Given 答题者打开一个公开填写页
    When 页面拉取表单并提交作答
    Then 拉取请求不带 Authorization 头
    And 提交请求不带 Authorization 头

  # —— 必填校验：前端前置 + 后端 400 ——

  Scenario: 漏填必填项时前端拦住提交
    Given 答题者打开了一份含必填「姓名」的公开表单
    When 答题者未填「姓名」直接点击提交
    Then 出现必填校验提示
    And 不发出提交请求

  Scenario: 后端因缺必填返回 400 时显示提示
    Given 答题者打开了一份公开表单并点击提交
    When 后端返回 400 与缺必填的错误说明
    Then 页面显示该错误说明

  # —— 错误态：slug 不存在 / 表单已关闭 / 上游出错 ——

  Scenario: slug 不存在显示友好 404 页
    Given 一个不存在的公开链接 /f/nope
    When 答题者打开该链接
    And 后端拉取返回 404
    Then 页面显示「表单不存在」的友好提示
    And 不显示答题表单

  Scenario: 向已关闭的表单提交时提示已停止收集
    Given 答题者打开了一份表单并填好后点击提交
    When 后端返回 409 表示表单未开放提交
    Then 页面提示该表单已停止收集

  Scenario: 提交遇上游错误时提示稍后重试
    Given 答题者打开了一份公开表单并填好后点击提交
    When 后端返回 502 上游错误
    Then 页面提示提交失败请稍后重试
