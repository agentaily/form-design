# 契约来源：后端 SPEC §16（GET /api/forms/:slug 公开拉取 meta+fields；POST /api/forms 发布）
# + §21.3（owner-only PATCH /api/forms/:slug 部分更新——本期用它整块替换 meta+fields 写回编辑）
# + §16.8/§16.9（编辑改字段标签 → 后端按 field.id 同步飞书列改名；新增字段预建列）+ §17（owner-only 鉴权）。
# 本 feature 描述前端「把已发布/已关闭表单载回设计器继续编辑、改完写回」的可观察行为，
# 不重述后端 slug 生成、D1 表结构、飞书列改名算法等 Worker 内部约定。
#
# 设计真相源：form-design handoff BJ0OUqPwIW-dZwObPNkcnQ（原型 main.jsx / tweaks-panel.jsx，
# 意图 chats/chat12.md「表单编辑入口」+ chat13.md「编辑态 / 状态模型」）：
#   • 「我的表单」卡片上的「继续编辑 / 编辑」把表单 meta + 字段 schema 载回设计器；
#   • 编辑态顶部一条低调状态横幅（EDITING mono 标签 + 状态点 + 一行文案 + 「详情」HoverCard + 「退出」），
#     与下方「预览 / Schema」工具栏等高（共用 --bar-h）；
#   • 顶栏主按钮在编辑态由「发布」变「更新」，走 PATCH /api/forms/:slug 写回 meta+fields；
#   • 有未保存改动时退出先弹 DS AlertDialog「放弃本次编辑？」二次确认；
#   • 编辑「已发布」（在线收集中）与「已关闭」（未在收集）各自文案/徽章自洽。
#
# 字段类型保真说明（已有 wire 契约的固有限制，非本期可改）：后端 schema 只存 §3.2 wire 类型
# （text/number/select/date/checkbox/radio/file/group），发布时设计器的 tel/email/textarea 都并成 text、
# consent 并成 checkbox。故载回设计器时按 wire→UI 最佳还原（text→text、radio→radio、select→select、
# checkbox→checks），tel/email/textarea/consent 的细分会退化——这是既有 wire 契约的损耗，不在本期范围。
# 关键不变量：字段 id 在「载回 → 编辑 → 写回」全程保留，后端才能按 id 认出改标签 = 改名（而非删旧建新）。
#
# 前端契约桩见 src/core/formsClient.ts（getFormForEdit 载回 + updateFormDefinition 写回），
# 卡片「编辑」入口见 src/forms-panel.jsx，编辑态横幅 / 更新 / 放弃保护接线见 src/App.jsx。

Feature: 表单编辑入口（载回设计器继续编辑）
  作为表单作者(owner)
  我想在「我的表单」里点「编辑」把一份已发布或已关闭的表单载回设计器修改、改完写回
  以便在不重建表单的前提下迭代字段与文案，且不会误丢未保存的改动

  # —— 载回设计器：卡片「编辑」→ 拉取 meta+fields → 填进设计器 ——

  Scenario: 把一份已发布表单载回设计器编辑
    Given owner 打开「我的表单」且其中一份已发布表单
    When owner 点击该表单的「继续编辑」
    And 后端返回该表单的标题与字段定义
    Then 设计器载入该表单的标题与全部字段
    And 顶部显示「正在编辑」的状态横幅

  Scenario: 编辑已关闭的表单不按在线态展示
    Given owner 打开「我的表单」且其中一份已关闭表单
    When owner 点击该表单的「编辑」
    And 后端返回该表单的标题与字段定义
    Then 状态横幅文案说明该表单未在收集
    And 顶栏状态徽章显示已关闭而非 LIVE

  # —— 顶栏主按钮：编辑态从「发布」变「更新」，走 PATCH 写回 ——

  Scenario: 编辑态顶栏主按钮是「更新」
    Given owner 已把一份已发布表单载回设计器编辑
    Then 顶栏主按钮显示「更新」而非「发布」

  Scenario: 改完点「更新」把 meta 与字段写回
    Given owner 已把一份已发布表单载回设计器编辑
    When owner 修改某个字段的标签
    And owner 点击「更新」
    Then 通过 PATCH 把更新后的 meta 与字段写回该表单
    And 写回的字段保留原有字段 id 以便后端识别改名

  Scenario: 没有改动时「更新」不可点
    Given owner 已把一份已发布表单载回设计器编辑
    Then 在还没有任何改动前「更新」按钮不可点击

  # —— 放弃保护：有未保存改动时退出二次确认 ——

  Scenario: 有未保存改动时退出弹确认
    Given owner 已把一份已发布表单载回设计器编辑
    And owner 修改了表单但还没点「更新」
    When owner 点击「退出」
    Then 弹出「放弃本次编辑」的确认提示
    And 此时没有把改动写回后端

  Scenario: 确认放弃后退出编辑态回到干净草稿
    Given owner 在编辑态有未保存改动并看到「放弃本次编辑」确认
    When owner 确认放弃改动
    Then 退出编辑态且设计器清空
    And 没有把改动写回后端

  Scenario: 继续编辑则留在编辑态不丢改动
    Given owner 在编辑态有未保存改动并看到「放弃本次编辑」确认
    When owner 选择继续编辑
    Then 仍停留在编辑态且改动还在

  Scenario: 没有改动时退出直接离开不打扰
    Given owner 已把一份已发布表单载回设计器编辑
    When owner 在没有任何改动时点击「退出」
    Then 直接退出编辑态且不弹确认

  # —— 编辑会话隔离：编辑态对话是临时的，不写进 §26 设计会话（不覆盖已发布表单的设计对话）——

  Scenario: 编辑期间的对话不污染设计会话持久化
    Given owner 已把一份已发布表单载回设计器编辑
    When owner 在编辑态发生一轮对话改动
    Then 这轮编辑对话不写进设计会话持久化

  # —— owner-only：写回会话失效 → 引导先登录（复用 onNeedLogin 模式）——

  Scenario: 写回时会话失效引导先登录
    Given owner 已把一份已发布表单载回设计器编辑并做了改动
    When owner 点击「更新」
    And 写回请求返回 401
    Then 提示需要先登录
