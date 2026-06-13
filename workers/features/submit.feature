Feature: 提交落 D1 主存 POST /api/submit（飞书降为可选后台同步）
  作为表单 owner
  我想让答题者在公开填写页提交的作答先落进我的 D1 主存
  以便提交永不丢，且配了飞书时再 best-effort 同步到我的飞书多维表格、同步失败也不影响提交

  背景：架构转向（PR-2）——提交数据的**主存**从飞书翻转到 **D1**。POST /api/submit 是公开端点、
  没有「当前登录 owner」：route 按 formSlug 用 getFormOwner 反查该 form 所属 owner（作隔离键），
  校验门（form 存在 + 状态开放 + 必填）全过后**先写 D1（必成）**、返回 { ok, id }。飞书自此降为
  **可选外部同步出口**：仅当该 owner 配了飞书，才在响应返回后于后台（waitUntil）best-effort 同步——
  换 tenant_access_token、按列真实类型写一条记录（缺列自愈建列重试一次，§15.8）、成功则把飞书
  record_id 回填进该提交行的同步回执列；**同步失败只记 feishu_sync_error，绝不影响提交成功**。
  **语义翻转：未配飞书不再 409 拒收**——照常落 D1、返回成功，只是不向飞书发任何请求。app secret 与
  tenant_access_token 全程留在 Worker 内，绝不出现在任何响应、头或日志里。
  自 §16.5 起 body 带必填 formSlug；自 §20 起 formExists 之后有状态门 + answers 必填校验
  （详见 submit-validation.feature）——本节正常落库 / 同步场景的前置表单均为 published 且填齐必填。
  注：飞书同步在后台异步发生，断言其上游调用前需先 drain 掉后台续体（见外环实现）。

  Scenario: 提交成功落 D1 主存并返回提交 id
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口将返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 200
    And 响应体的 ok 为真
    And 响应体带有该提交的 id
    And 该提交已写入 D1 主存
    And 后台同步成功后该提交回填了飞书 record id

  Scenario: answers 正确映射进后台同步的飞书 fields
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口将返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 提交含一个文本答案与一个多选答案的作答
    Then 响应状态码为 200
    And 后台同步的写记录请求体的 fields 里文本答案以 label 为键、值原样
    And 后台同步的写记录请求体的 fields 里多选答案以 label 为键、值为原样字符串数组
    And 后台同步的写记录请求打到了 owner 配置的 app token 与 table id 对应的端点

  Scenario: 未配飞书也照常落 D1 并返回成功且不向飞书发任何请求
    Given 一个未配置飞书的 owner
    And 一份已发布的表单
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 200
    And 响应体的 ok 为真
    And 该提交已写入 D1 主存
    And 该提交没有飞书 record id
    And 没有向上游飞书发起任何请求

  Scenario: 空 answers 时返回 400 且不落 D1 不同步
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    When 答题者带着该表单的 slug 向 /api/submit 提交一份空 answers 的请求
    Then 响应状态码为 400
    And 没有提交被写入 D1 主存
    And 没有向上游飞书发起任何请求

  Scenario: 缺少 answers 时返回 400 且不落 D1 不同步
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    When 答题者带着该表单的 slug 向 /api/submit 提交缺少 answers 的请求
    Then 响应状态码为 400
    And 没有提交被写入 D1 主存
    And 没有向上游飞书发起任何请求

  Scenario: 同步换 token 失败时提交仍成功并记同步错误且不泄漏 app secret
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回非 0 的业务错误码
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 200
    And 该提交已写入 D1 主存
    And 该提交记录了飞书同步失败
    And 该提交没有飞书 record id
    And 没有向上游飞书多维表格新增记录接口发起请求
    And 整个响应里不包含 owner 的明文飞书 app secret

  Scenario: 同步写记录失败时提交仍成功并记同步错误且不泄漏 token
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口将返回非 0 的业务错误码
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 200
    And 该提交已写入 D1 主存
    And 该提交记录了飞书同步失败
    And 整个响应里不包含换取到的 tenant_access_token

  Scenario: 整个响应里不含任何明文凭据
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口将返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 整个响应里不包含 owner 的明文飞书 app secret
    And 整个响应里不包含换取到的 tenant_access_token

  # §15.8 飞书列自动创建（自愈）—— 后台同步遇缺列时反应式补列并重试一次，稳态零额外建列。
  # 自愈机制不变，只是从「提交同步路径」搬到 best-effort 后台同步里：同步失败一律不影响提交本身。

  Scenario: 后台同步遇列不存在时自动建缺失列并重试成功
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口第一次返回列不存在的 code 1254045
    And 上游飞书列出字段接口将返回现有列名集合
    And 上游飞书新建字段接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口第二次返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 200
    And 后台同步成功后该提交回填了飞书 record id
    And 后台同步对每个缺失的列各新建字段一次
    And 后台同步对多维表格新增记录接口共发起两次请求

  Scenario: 自愈只新建缺失的列不重复建已存在的列
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口第一次返回列不存在的 code 1254045
    And 上游飞书列出字段接口将返回已含其中一个待写列的现有列名集合
    And 上游飞书新建字段接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口第二次返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 提交含一个已存在列与一个缺失列的作答
    Then 响应状态码为 200
    And 后台同步只对缺失的那个列发起新建字段请求
    And 后台同步没有对已存在的列发起新建字段请求

  Scenario: 列已存在时后台同步只写一次记录
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口首写即返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 200
    And 后台同步没有向飞书新建字段接口发起任何请求
    And 后台同步对多维表格新增记录接口只发起一次请求

  Scenario: 新建字段遇 FieldNameDuplicated 视为成功
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口第一次返回列不存在的 code 1254045
    And 上游飞书列出字段接口将返回现有列名集合
    And 上游飞书新建字段接口将返回 FieldNameDuplicated 的 code 1254014
    And 上游飞书多维表格新增记录接口第二次返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 200
    And 后台同步成功后该提交回填了飞书 record id

  Scenario: 自愈后重试同步仍失败时提交仍成功并记同步错误
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口两次都返回列不存在的 code 1254045
    And 上游飞书列出字段接口将返回现有列名集合
    And 上游飞书新建字段接口将返回 code 为 0
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 200
    And 该提交已写入 D1 主存
    And 该提交记录了飞书同步失败
    And 后台同步对多维表格新增记录接口只重试一次共两次请求
    And 整个响应里不包含换取到的 tenant_access_token
