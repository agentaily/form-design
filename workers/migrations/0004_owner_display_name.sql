-- users.display_name — owner 显示名（§17 owner 个人资料）。见 SPEC.md §17。
--
-- 用途：owner 给自己起一个对外显示名，出现在其创建的表单 / 提交记录里（替代裸邮箱
--   作为「谁建的这张表单」的可读身份）。
--
-- 约定：
--   * 明文存（非凭据，可前端回显）；可空，默认 NULL。
--   * 空 / NULL = 未设置显示名 → 回退用邮箱显示。
--   * 绝不参与密码 / 鉴权：它只是展示名，改它不动 email / password_* / email_verified。
--
-- 迁移说明：ALTER ADD COLUMN 非幂等（重复跑报 duplicate column），但 prod 走 d1_migrations
--   追踪只跑一次、测试每个 case 是 fresh 隔离 D1 只 apply 一次，故安全。SQLite 不支持列级
--   IF NOT EXISTS，故不加。

ALTER TABLE users ADD COLUMN display_name TEXT;
