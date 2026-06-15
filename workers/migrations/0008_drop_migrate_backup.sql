-- DROP 一次性数据迁移的库内备份表 — A'「项目 ↔ 对话」重构收口（PR-D）。
-- 见 SPEC.md §26 / docs/refactor-project-conversation.md §2.3 / workers/runbooks/0007-migrate-projects.md。
--
-- 背景：PR-B 的一次性数据迁移（`POST /api/admin/migrate-projects`，PR-D 已删）在 apply 时把每行
--   老会话的 pristine 原值（turns_json / form_slug / project_id）写进库内备份表 `chat_sessions_a_backup`，
--   供 `rollback` 精准还原。生产 dry-run→apply 由老板手动跑完、确认**当前生产账号无老数据可迁**
--   （`migrated:0`、no-op，备份表里没数据），迁移已稳定完结、不再需要精准回滚。
--
-- 本 migration 纯收口：DROP 这张空备份表。**纯 DROP IF EXISTS、低风险**——本地 miniflare apply 测，
--   生产随 deploy-workers apply（人/老板侧）。

DROP TABLE IF EXISTS chat_sessions_a_backup;
