-- submissions — 答题提交的 D1 主存。见 SPEC.md §15（提交落 D1 主存）+ §18（数据后台读 D1）。
--
-- 架构转向（PR-2）：提交数据的**主存**从「owner 的飞书多维表格」翻转到 **D1**——
--   * 写：POST /api/submit 先把作答写进本表（必成），再 best-effort 异步同步飞书（仅当 owner
--     配了飞书）；同步失败只记 feishu_sync_error，绝不影响提交成功（§15）。
--   * 读：GET /api/forms/:slug/submissions 改从本表 SELECT（owner_id + form_slug 隔离），
--     不再回飞书 GET 记录（§18）。
--   * 飞书自此降为**可选外部同步出口**，不再是唯一落库目标；未配飞书照常落 D1。
--
-- 干净起步（已与产品负责人确认）：生产为自测态（仅 owner 本人），**不写任何历史回填**，
--   D1 只从改版后开始存新提交——故本迁移只建表，无数据搬迁。
--
-- 多租户隔离：
--   * owner_id 是 form 所属 owner 的真实 user id（forms.owner_id，§17.11）——公开 submit 按
--     formSlug 用 getFormOwner 反查得到（§16.5 / §17.9 第 5 条）。数据后台按 (owner_id, form_slug)
--     过滤，A 永远读不到 B 的提交。
--   * form_slug 关联 forms.slug（删表单不联动删提交，与既有 DELETE 语义一致）。
--
-- 安全约定：
--   * 本表只存**提交数据本身**（作答 + 时间 + 飞书同步回执），绝不存任何 owner 凭据
--     （凭据全在 owner_config，加密落库）。
--   * 飞书同步回执（feishu_record_id / feishu_synced_at / feishu_sync_error）均可空：
--     未配飞书 / 尚未同步 / 同步失败时为 NULL 或仅 error 有值；feishu_sync_error 只存
--     非敏感错误摘要（如错误名），绝不含 tenant_access_token / app_secret（§15.7）。
--
-- 迁移幂等：CREATE TABLE / INDEX 均带 IF NOT EXISTS，重复 apply 是 no-op（prod 走
--   d1_migrations 追踪只跑一次；测试每个隔离 D1 只 apply 一次，重复也安全）。

CREATE TABLE IF NOT EXISTS submissions (
  id                TEXT PRIMARY KEY,   -- crypto.randomUUID()，一条提交的稳定主键
  form_slug         TEXT NOT NULL,      -- 关联 forms.slug（这份提交属于哪张表单）
  owner_id          TEXT NOT NULL,      -- form 所属 owner 的真实 user id（隔离键，§17.11）
  answers_json      TEXT NOT NULL,      -- 序列化的 SubmitAnswer[]（[{ label, value }]，§15.2）
  created_at        TEXT NOT NULL,      -- ISO-8601，落库时刻

  -- 飞书 best-effort 同步回执（可选同步；未配飞书 / 未同步 / 失败时为 NULL）
  feishu_record_id  TEXT,               -- 同步成功后飞书 record_id；NULL = 未同步 / 失败
  feishu_synced_at  TEXT,               -- 同步成功时刻 ISO-8601；NULL = 未同步 / 失败
  feishu_sync_error TEXT                -- 同步失败的非敏感错误摘要；NULL = 没失败过（绝不含凭据）
);

-- 数据后台按 (owner_id, form_slug) 拉列表、按 created_at 排序——复合索引覆盖这条查询路径。
CREATE INDEX IF NOT EXISTS idx_submissions_owner_form_created
  ON submissions (owner_id, form_slug, created_at);
