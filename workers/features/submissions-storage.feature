Feature: 提交落 D1 主存 + 飞书可选后台同步（存储语义）
  作为表单 owner
  我想让每一份提交都先稳妥落进我的 D1 主存、再尽力同步到飞书
  以便提交永不因飞书未配 / 飞书故障而丢失，飞书只是可选的外部出口

  背景：架构转向（PR-2）的核心存储语义。POST /api/submit 校验门全过后**先写 D1（主存，必成）**，
  再**仅当 owner 配了飞书**时于后台（waitUntil）best-effort 同步飞书。本特性聚焦「存储真相」：
  D1 里有没有这行、飞书同步回执（feishu_record_id / feishu_synced_at / feishu_sync_error）反映了
  什么、以及「提交 → 数据后台从 D1 读回」的端到端闭环。提交成功与否只取决于 D1 写入；飞书同步的成败
  都不改变提交的 200 成功响应。已与产品负责人确认**干净起步、零回填**——D1 只从改版后开始存新提交。

  Scenario: 提交先写 D1 主存并返回提交 id
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口将返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 200
    And 响应体带有该提交的 id
    And D1 主存里存在该提交且其作答与提交内容一致

  Scenario: 未配飞书时照常落 D1 且回执为空、不向飞书发任何请求
    Given 一个未配置飞书的 owner
    And 一份已发布的表单
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 200
    And D1 主存里存在该提交
    And 该提交的飞书同步回执为空
    And 没有向上游飞书发起任何请求

  Scenario: 配了飞书且同步成功时回填飞书 record id
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回 code 为 0
    And 上游飞书多维表格新增记录接口将返回 code 为 0 且带 record id
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 200
    And 后台同步完成后该提交回填了飞书 record id
    And 该提交没有记录飞书同步失败

  Scenario: 配了飞书但同步失败时提交仍在 D1 且记下同步错误
    Given 一个已保存完整飞书凭据的 owner
    And 一份已发布的表单
    And 上游飞书 tenant_access_token 接口将返回非 0 的业务错误码
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    Then 响应状态码为 200
    And D1 主存里存在该提交
    And 后台同步完成后该提交记录了飞书同步失败
    And 该提交没有飞书 record id

  Scenario: 提交后数据后台从 D1 读回这条提交（端到端）
    Given 一个已登录的 owner
    And 一个未配置飞书的 owner
    And 一份已发布的表单
    When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    And owner 带有效 token 请求该表单的提交列表
    Then 响应状态码为 200
    And 响应体的 count 为 1
    And 读回的提交的作答与刚提交的内容一致
