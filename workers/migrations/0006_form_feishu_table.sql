-- forms 表加 per-form 飞书多维表格定位列。见 SPEC.md §16.9（发布即自动建表，每表单一张飞书多维表格）。
--
-- 架构转向（PR-3）：飞书从「owner 单一对 app_token/table_id」升级为 **per-form 一张表**——
--   * 发布表单（POST /api/forms）成功后，若 owner 配了**账户级**飞书凭据（app_id + app_secret），
--     后台 best-effort 建一个多维表格 app（拿 app_token）+ 一张数据表（拿 table_id）+ 预建带类型的列，
--     再把 app_token / table_id **写回这张 form 行**（§16.9）。建表失败不挡发布（表单照常 published）。
--   * 提交同步（§15 syncSubmissionToFeishu）改读**该 form 行**的 app_token / table_id（不再用
--     owner_config 的单一对）；该 form 还没建表（两列为 NULL）则跳过同步。
--   * owner_config 的 feishu_app_token / feishu_table_id 自此对同步**不再使用**（保留列仅为回显的
--     向后兼容，PR-4 前端飞书卡 link-less 落地后清理）；飞书账户级凭据只需 app_id + app_secret。
--
-- 干净起步零回填（与 §15 / §18 一致）：只**新发布**的表单走自动建表，**不回填**任何旧表单——
--   故本迁移只加列、无数据搬迁；既有 forms 行两列为 NULL（= 还没建飞书表）。
--
-- 列语义：
--   * feishu_app_token / feishu_table_id 均**可空**，明文存（飞书 app token / 数据表 id 都非密）。
--   * 两列**成对**：要么同时有值（已建表）、要么同时 NULL（还没建 / 建表失败）。NULL = 该表单
--     还没有对应的飞书多维表格 → 提交不同步、编辑不预建 / 不改名。
--   * 绝不存任何凭据（app_secret 等仍只在 owner_config 加密落库）。
--
-- 迁移幂等：SQLite 的 ALTER TABLE ADD COLUMN 无列级 IF NOT EXISTS——prod 走 d1_migrations 追踪
--   只跑一次；测试侧 applySchema 对「duplicate column name」吞掉，重复 apply 安全（见 helpers.ts）。

ALTER TABLE forms ADD COLUMN feishu_app_token TEXT; -- per-form 多维表格 app token，明文，可空（NULL=还没建表）
ALTER TABLE forms ADD COLUMN feishu_table_id  TEXT; -- per-form 数据表 id，明文，可空（与 app_token 成对）
