# 契约来源：后端 SPEC §18（GET /api/forms/:slug/submissions，owner-only：返回该表单已收集的
# 提交列表 + count）+ §17（owner-only 鉴权，缺/坏/过期 token → 401）。
#
# ★ D1 主存版本（#56）：提交主存从 owner 的飞书多维表格翻转到 **D1**。本读端现在直接从 D1 投影：
#   { submissions:[{ id, answers:[{label,value}], createdAt, feishu:{recordId,syncedAt,error} }], count }
#   （不再是旧飞书的 { recordId, fields, createdTime }）。读 D1 不打飞书，所以**不再**有
#   「未配飞书 409」/「上游 502」——只剩 401（未登录）/ 404（slug 不存在或非本人）。
#
# ★ 面板内内容切换（PR-6 / chat13）：入口在「我的表单」(src/forms-panel.jsx) 每张表单卡片上的
#   「查看全部提交」。点它**不再开独立 Dialog**，而是在**同一块 PanelSheet 内**把内容 swap 成该表单的
#   提交数据；点某行进入**面板内的记录详情子页**（非弹窗）。面包屑 我的表单 → 提交数据 → #记录号 各级可回退。
# 前端契约见 src/core/submissionsClient.ts（owner-only，复用 apiClient 的 Bearer 注入），内容视图见
#   src/submissions-view.jsx（SubmissionsContent，由 FormsPanel 在 PanelSheet 内内联渲染）。
# owner-only：任一调用 401 → 引导先登录（复用 §17 的 onNeedLogin 模式）。
#
# ★ per-form「飞书表格↗」入口（PR-4 / chat13）：当某表单「发布即自动建表」已产出 per-form 飞书多维表格
#   （§16.9）时，「提交数据」工具栏（挨着「导出 CSV」）显示一个 **<a target="_blank"> 飞书表格 ↗** 外链，在
#   新标签打开**这张表单对应的**飞书表。该入口的飞书表定位来自**表单摘要**——GET /api/forms 投影 forms 行的
#   feishu_app_token/feishu_table_id（FormSummary.feishuTable，§16.9 / §21.2），二者都非空才带回；**未建表
#   则摘要无 feishuTable → 不显示入口**。它**不**来自提交响应（提交响应按 §18.6 绝不带 app_token/table_id）。
#   外链 URL 由前端纯函数 feishuTableUrl(appToken, tableId) 拼成（与 publicFormUrl 同风格），点它是真链接、
#   不发请求、不改页面状态。前端 seam 见 src/core/formsClient.ts（FormSummary.feishuTable + feishuTableUrl）。
Feature: 数据后台查看表单提交
  作为表单作者(owner)
  我想在「我的表单」里查看某份表单已经收到的提交
  以便回收和核对答题者交上来的作答

  # —— 列出提交 + count ——

  Scenario: 查看一份表单的提交列表与数量
    Given owner 已登录并打开「我的表单」
    And 其中一份表单已收到若干提交
    When owner 点击该表单的「查看全部提交」
    And 后端返回该表单的提交列表与数量
    Then 在同一面板内列出每条提交的字段值
    And 显示提交总数

  # —— per-form「飞书表格↗」入口（在「提交数据」工具栏，挨着导出 CSV）——

  Scenario: 已自动建表的表单在提交数据工具栏显示「飞书表格」外链
    Given owner 已登录并打开「我的表单」
    And 其中一份表单已「发布即自动建表」产出对应的飞书多维表格
    When owner 打开该表单的提交数据
    Then 提交数据工具栏在「导出 CSV」旁显示「飞书表格」外链
    And 该外链在新标签打开这张表单对应的飞书多维表格

  Scenario: 未建表的表单不显示「飞书表格」外链
    Given owner 已登录并打开「我的表单」
    And 其中一份表单尚未产出对应的飞书多维表格
    When owner 打开该表单的提交数据
    Then 提交数据工具栏不显示「飞书表格」外链

  # —— 面板内记录详情子页（非 Dialog）——

  Scenario: 点一条提交进入面板内的记录详情子页
    Given owner 已登录并打开某份表单的提交数据
    When owner 点击其中一条提交的「查看」
    Then 在同一面板内展开这条提交的完整作答
    And 面包屑加到记录详情这一级且可回退到提交列表

  # —— 空态 ——

  Scenario: 一份表单还没有提交时显示空态
    Given owner 已登录并打开「我的表单」
    And 其中一份表单还没有任何提交
    When owner 点击该表单的「查看全部提交」
    And 后端返回空的提交列表
    Then 显示「还没有收到提交」的空态且无报错

  # —— owner-only：401 → 引导先登录 ——

  Scenario: 会话失效查看提交时引导先登录
    Given owner 打开「我的表单」并点击某份表单的「查看全部提交」
    When 拉取提交列表返回 401
    Then 提示需要先登录
    And 自动弹出 owner 登录框

  # —— 其它非 2xx：可重试错误 ——

  Scenario: 读取提交遇服务端错误时提示稍后重试
    Given owner 已登录并点击某份表单的「查看全部提交」
    When 后端返回服务端错误
    Then 页面提示加载提交失败请稍后重试
