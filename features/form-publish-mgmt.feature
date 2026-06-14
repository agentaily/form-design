# 契约来源：后端 SPEC §16（POST /api/forms 发布 → 生成高熵 slug；GET /api/forms/:slug 公开拉取）
# + §21（owner-only 管理 CRUD：GET /api/forms 列表 / PATCH /api/forms/:slug 改 status / DELETE /api/forms/:slug 删）
# + §17（owner-only 鉴权，缺/坏 token → 401）。本 feature 描述前端「发布 + 表单管理」的可观察行为，
# 不重述后端 slug 生成熵、D1 表结构、飞书写入等 Worker 内部约定。
#
# 公开填写链接 URL 约定（第 6 步公开页据此渲染）：
#   一份发布出来的表单按其 slug 暴露在  /f/:slug  路径（同源），完整链接形如
#   https://<站点域名>/f/<slug>，例：https://form-design.agentaily.com/f/f8Kq2pXa。
#   前端只持有 slug，由 formsClient.publicFormUrl(slug) 拼出展示用的绝对/相对链接；
#   POST /api/forms 若返回 url 字段则以其为准，否则用本约定拼。第 6 步公开页用 /f/:slug
#   解析 slug → GET /api/forms/:slug 拉 schema 渲染（本步不实现公开页本身）。
#
# 发布交互（N-_ayo8x）：「发布」是顶栏的【直接动作】——点一下就把当前设计器表单上线
#   （POST /api/forms → 高熵 slug），不再走「打开发布反馈浮层 → 在浮层里再点一次发布」的两步，
#   也不往对话里发任何消息；成功后弹一个【仅链接、无二维码】的分享浮层（ShareDialog，"表单已发布"
#   庆祝式），并把这份刚发布的表单接上既有的 编辑 / 更新 机制（见 features/form-editing.feature）。
#   「分享」是【只读】：取当前已发布表单的公开链接弹同一个浮层（"分享这份表单"），不改状态、不发消息。
# 前端契约桩见 src/core/formsClient.ts，分享浮层见 src/share-dialog.jsx，表单管理面板见
#   src/forms-panel.jsx，发布/分享/「我的表单」入口接线（doPublish / openShare）见 src/App.jsx。
Feature: 发布表单并管理我的表单
  作为表单作者(owner)
  我想把设计器里的表单发布成一个公开填写链接，并在「我的表单」里管理它们
  以便把链接发出去收集答卷，并随时开放/关闭或删除某份表单

  # —— 发布：设计器当前表单 → POST /api/forms → 拿真 slug + 展示公开链接 ——

  Scenario: 发布当前表单拿到公开填写链接
    Given owner 已登录
    And 设计器里已有一份带标题和至少一个字段的表单
    When owner 点击发布
    And 后端返回新建表单的 slug
    Then 反馈里展示该 slug 对应的公开填写链接
    And 顶栏状态标记为已发布

  Scenario: 复制公开填写链接
    Given owner 刚发布了一份表单并看到公开填写链接
    When owner 点击复制链接
    Then 该公开填写链接被复制到剪贴板

  Scenario: 空表单无法发布
    Given owner 已登录
    And 设计器里还没有任何字段
    Then 发布按钮不可点击

  Scenario: 后端拒绝缺标题的发布并提示
    Given owner 已登录
    And 设计器里有字段但表单缺少标题
    When owner 点击发布
    And 后端返回 400 与错误说明
    Then 反馈里显示后端给出的错误说明
    And 顶栏状态仍为草稿

  # —— 发布是直接动作 + 分享只读（N-_ayo8x）——

  Scenario: 发布是直接动作并弹出分享浮层
    Given owner 已登录
    And 设计器里已有一份带标题和至少一个字段的表单
    When owner 点击发布
    And 后端返回新建表单的 slug
    Then 直接弹出展示公开填写链接的分享浮层
    And 发布过程不往对话里发任何消息

  Scenario: 分享已发布的表单只读取链接
    Given owner 刚发布了一份表单
    When owner 点击分享
    Then 弹出展示该表单公开填写链接的分享浮层
    And 分享不发起改状态的请求也不往对话发消息

  # —— 表单管理：GET /api/forms 列出我的表单 ——

  Scenario: 打开「我的表单」列出已发布的表单
    Given owner 已登录
    And 后端已存有该 owner 的若干表单
    When owner 打开「我的表单」
    Then 列出每份表单的标题、状态徽标、创建时间与公开填写链接

  Scenario: 一份表单都没有时显示空态
    Given owner 已登录
    And 后端没有该 owner 的任何表单
    When owner 打开「我的表单」
    Then 显示「还没有发布过表单」的空态且无报错

  # —— 改状态：PATCH /api/forms/:slug（published ↔ closed）——

  Scenario: 关闭一份已发布表单的提交
    Given owner 打开「我的表单」且其中一份表单状态为已发布
    When owner 点击关闭该表单
    And 后端返回该表单状态已变为关闭
    Then 该表单的状态徽标变为已关闭

  Scenario: 重新开放一份已关闭表单的提交
    Given owner 打开「我的表单」且其中一份表单状态为已关闭
    When owner 点击重新开放该表单
    And 后端返回该表单状态已变为已发布
    Then 该表单的状态徽标变为已发布

  # —— 删除：DELETE /api/forms/:slug（带确认）——

  Scenario: 删除一份表单需要确认
    Given owner 打开「我的表单」
    When owner 点击删除某份表单
    Then 弹出删除确认提示

  Scenario: 确认后删除并从列表移除
    Given owner 已对某份表单点击删除并看到确认提示
    When owner 确认删除
    And 后端返回删除成功
    Then 该表单从列表中消失

  Scenario: 取消删除则表单保留
    Given owner 已对某份表单点击删除并看到确认提示
    When owner 取消删除
    Then 该表单仍在列表中且未发出删除请求

  # —— owner-only：任一调用 401 → 引导先登录（复用 #11 的 onNeedLogin 模式）——

  Scenario: 未登录打开「我的表单」引导先登录
    Given owner 未登录
    When owner 打开「我的表单」
    And 拉取表单列表返回 401
    Then 提示需要先登录
    And 自动弹出 owner 登录框

  Scenario: 发布时会话失效引导先登录
    Given 设计器里已有一份可发布的表单
    When owner 点击发布
    And 发布请求返回 401
    Then 提示需要先登录
    And 自动弹出 owner 登录框
