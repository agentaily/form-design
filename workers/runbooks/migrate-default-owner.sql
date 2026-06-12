-- runbooks/migrate-default-owner.sql — 一次性 bootstrap 数据迁移（**非** schema 迁移）。
--
-- 为什么放在 runbooks/ 而不是 migrations/：
--   migrations/ 由 `wrangler d1 migrations apply` 自动、按序、幂等地跑（schema DDL）。
--   本脚本是**一次性数据回填**，且依赖一个运行时才产生的参数（首个注册账号的
--   user id），无法静态自动跑 —— 故不进 migrations/、不被 CI 自动应用，只作人工 runbook 留档。
--   见 RELEASE.md §3.2 / §5。
--
-- 背景：单租户 → 多用户改造前，owner_config / forms 的 owner_id 恒为 'default'。
-- 上线多用户版本后，把历史 'default' 数据归到首个注册的真实 owner 名下。
--
-- ⚠️ 状态：已于 2026-06-12 在生产 D1（form-design-db）执行完毕 —— 把 1 份 owner_config
-- + 4 个 forms 从 'default' 迁到 owner yarnb@qq.com（id 8c3a5fe2-…）。本文件留作记录与模板；
-- **请勿重复执行**（'default' 行已不存在，重跑是 no-op，但语义上一次性）。
--
-- 复用模板（将来若有同类 bootstrap）：把 REPLACE_WITH_REAL_USER_ID 换成
-- `SELECT id FROM users WHERE email='…'` 查到的真实 UUID，再用
-- `wrangler d1 execute form-design-db --remote --file=runbooks/migrate-default-owner.sql -y` 跑。

UPDATE owner_config SET owner_id = 'REPLACE_WITH_REAL_USER_ID' WHERE owner_id = 'default';
UPDATE forms        SET owner_id = 'REPLACE_WITH_REAL_USER_ID' WHERE owner_id = 'default';
