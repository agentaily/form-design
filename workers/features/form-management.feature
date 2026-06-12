Feature: 表单管理 CRUD 列表 改状态 删除 owner-only
  作为表单 owner
  我想登录后列出自己的表单、开启或关闭某份表单的提交、删除不再需要的表单
  以便我能在发布之后管理自己的表单，而这些管理动作只对登录的我、且只作用于我名下的表单

  背景：多用户（§17）——forms.owner_id 是发布它的 owner 的真实 user id。三个端点都 owner-only，
  挂 §17 的鉴权 guard，并按当前 owner（c.get('session').sub）隔离：列表只列自己、PATCH/DELETE 只能改/删
  自己名下的表单（跨 owner → 404，不暴露存在性，在 tenant-isolation.feature 覆盖）。下列场景均在单个 owner
  自己名下进行。
  GET /api/forms 列出该 owner 的所有表单（每项 slug/meta/status/createdAt，不含 fields 全量）；
  PATCH /api/forms/:slug 部分更新，至少支持把 status 在 published 与 closed 之间切换；
  DELETE /api/forms/:slug 硬删该表单行（删后公开拉取 / submit 该 slug 都变 404）。
  路由共存陷阱（§21.1）：/api/forms 前缀下鉴权与公开交错——GET /api/forms（列表，owner-only）、
  POST /api/forms（发布，owner-only）、PATCH/DELETE /api/forms/:slug（owner-only）、
  GET /api/forms/:slug/submissions（owner-only），而 GET /api/forms/:slug（公开拉取）必须保持开放、不受 guard 影响。
  guard 按精确 method+path 挂，绝不用宽匹配 /api/forms/* 误伤公开拉取。
  这些端点都不返回任何 owner 凭据（凭据在 owner_config，不在 forms 表）。

  Scenario: owner 列出自己发布的表单
    Given owner 已用正确密码登录拿到 token
    And owner 已发布两份表单
    When owner 带 token 请求 /api/forms 列表
    Then 响应状态码为 200
    And 响应体的 forms 含这两份表单
    And 每个列表项带有 slug、meta 与 status
    And 响应体的 count 等于表单数量

  Scenario: 列表项不含 fields 全量与任何 owner 凭据
    Given owner 已用正确密码登录拿到 token
    And owner 已在集成配置里保存了 DeepSeek key 与完整飞书凭据
    And owner 已发布一份表单
    When owner 带 token 请求 /api/forms 列表
    Then 整个响应里不包含 owner 的明文 DeepSeek key
    And 整个响应里不包含 owner 的明文飞书 app secret

  Scenario: 不带 token 请求列表返回 401
    When 未鉴权地请求 /api/forms 列表
    Then 响应状态码为 401

  Scenario: owner 把表单状态改为 closed
    Given owner 已用正确密码登录拿到 token
    And owner 已发布一份状态为 published 的表单
    When owner 带 token 把该表单的 status 改为 closed
    Then 响应状态码为 200
    And 该表单的 status 变为 closed

  Scenario: owner 把已关闭表单重新开放为 published
    Given owner 已用正确密码登录拿到 token
    And owner 有一份状态为 closed 的表单
    When owner 带 token 把该表单的 status 改为 published
    Then 响应状态码为 200
    And 该表单的 status 变为 published

  Scenario: PATCH 不存在的 slug 返回 404
    Given owner 已用正确密码登录拿到 token
    And 一个从未发布过的 slug
    When owner 带 token 把该不存在的表单的 status 改为 closed
    Then 响应状态码为 404

  Scenario: PATCH 非法的 status 值返回 400
    Given owner 已用正确密码登录拿到 token
    And owner 已发布一份表单
    When owner 带 token 把该表单的 status 改为一个非法值
    Then 响应状态码为 400

  Scenario: 不带 token 请求 PATCH 返回 401
    Given owner 已发布一份表单
    When 未鉴权地请求把该表单的 status 改为 closed
    Then 响应状态码为 401

  Scenario: owner 删除一份表单
    Given owner 已用正确密码登录拿到 token
    And owner 已发布一份表单
    When owner 带 token 删除该表单
    Then 响应状态码为 200
    And 之后公开拉取该 slug 返回 404

  Scenario: 删除不存在的 slug 返回 404
    Given owner 已用正确密码登录拿到 token
    And 一个从未发布过的 slug
    When owner 带 token 删除该不存在的表单
    Then 响应状态码为 404

  Scenario: 不带 token 请求删除返回 401
    Given owner 已发布一份表单
    When 未鉴权地请求删除该表单
    Then 响应状态码为 401

  Scenario: 删除表单不影响公开拉取其它表单
    Given owner 已用正确密码登录拿到 token
    And owner 已发布两份表单
    When owner 带 token 删除其中一份表单
    Then 另一份表单的公开拉取仍返回 200

  Scenario: 列表的 guard 不影响公开拉取
    Given 一份已发布的表单
    When 答题者无鉴权地拉取该 slug 对应的表单
    Then 响应状态码为 200
