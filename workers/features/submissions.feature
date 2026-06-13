Feature: 数据后台提交列表 GET /api/forms/:slug/submissions（从 D1 主存读回）
  作为已登录的表单 owner
  我想按表单 slug 拉取这份表单已收集到的提交列表
  以便在数据后台查看答题者的作答，且数据从 D1 主存读回、我的凭据永不出现在客户端

  背景：架构转向（PR-2）后，提交主存是 **D1**（submit 落库见 submit.feature / submissions-storage.feature）。
  本端点 owner-only，需先带有效 session token（见 auth.feature）。命中流程先做归属校验——该 slug
  须属于当前登录 owner（slug 不存在或跨 owner 都 → 404、同码、不暴露存在性；跨 owner 在
  tenant-isolation.feature 覆盖）；归属通过后从 **D1 按 (owner_id, form_slug) SELECT** 提交，
  每条映射成 { id, answers, createdAt, feishu } 返回，附带 count。
  **不再读飞书**——故无「换 token / 读记录 / 502 上游」分支，也**不再有「未配飞书 → 409」**：D1 读不
  依赖飞书配置，未配飞书照常读回已落库的提交。owner 的凭据全程留在 Worker 内，响应也不含 app_token /
  table_id / owner_id。下列场景均在 owner 自己名下进行。

  Scenario: 无鉴权访问数据后台返回 401
    Given 一份已发布的表单
    When 未鉴权地请求该表单的提交列表
    Then 响应状态码为 401

  Scenario: 列出该表单已落 D1 的提交并返回 count
    Given 一个已登录的 owner
    And 一份已发布的表单
    And 该表单已收到两条提交
    When owner 带有效 token 请求该表单的提交列表
    Then 响应状态码为 200
    And 响应体的 submissions 含两条提交
    And 每条提交带有 id 与 answers
    And 响应体的 count 为 2

  Scenario: 空表时返回空列表且 count 为 0
    Given 一个已登录的 owner
    And 一份已发布的表单
    When owner 带有效 token 请求该表单的提交列表
    Then 响应状态码为 200
    And 响应体的 submissions 为空数组
    And 响应体的 count 为 0

  Scenario: 拉取不存在的 slug 返回 404
    Given 一个已登录的 owner
    When owner 带有效 token 请求该不存在 slug 的提交列表
    Then 响应状态码为 404

  Scenario: owner 未配飞书也能照常读回已落 D1 的提交
    Given 一个已登录的 owner
    And 一个未配置飞书的 owner
    And 一份已发布的表单
    And 该表单已收到一条提交
    When owner 带有效 token 请求该表单的提交列表
    Then 响应状态码为 200
    And 响应体的 submissions 含一条提交
    And 响应体的 count 为 1

  Scenario: 整个响应里不含任何明文凭据或 owner_id
    Given 一个已登录的 owner
    And 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 该表单已收到两条提交
    When owner 带有效 token 请求该表单的提交列表
    Then 响应状态码为 200
    And 整个响应里不包含 owner 的明文飞书 app secret
    And 整个响应里不包含 owner 配置的飞书 app token 与 table id
    And 响应体里不含 owner_id
