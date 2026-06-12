-- auth_tokens — 一次性、有时限的 token 表（邮箱验证 + 找回密码共用）。
-- 见 SPEC.md §22（发信）/ §23（邮箱验证）/ §24（找回密码）。
--
-- 用途（两种 kind 同表）：
--   * kind='verify'：注册软验证 / 重发验证（确认 → 把 users.email_verified 置 1）。
--   * kind='reset' ：找回密码（确认 → 重置该 user 的 password_hash/salt/iterations）。
--
-- 安全约定（库泄漏也拿不到活 token）：
--   * 只存 token 明文的 SHA-256（token_hash，base64 或 hex 由实现定，全表统一），**绝不**
--     存 token 明文。明文是高熵随机串（放进邮件链接的 ?token=），只在生成时返回一次用于发信，
--     之后服务端永不再持有；确认时把收到的明文重新 SHA-256 再按 token_hash 查（§23 / §24）。
--   * 单次使用：used_at 为 NULL=未用；一旦确认成功即写入用过时刻并作废，重放同一 token → 失败。
--   * 有时限:expires_at 是 ISO-8601;过期即失效(verify TTL 24h、reset TTL 1h，§23/§24)。
--   * 作废残留:覆盖重注册(§17.2 未验证可覆盖)/ 改密成功后，旧 user 名下未用 token 一并清理。
--
-- 隔离：user_id 是 users.id（真实 user id，§17.11）；reset 确认匿名公开（凭 token 自证），
--   verify 确认亦公开，二者都不需要 session——token 本身即凭据，故必须高熵 + 单次 + 限时。

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash   TEXT PRIMARY KEY,           -- token 明文的 SHA-256（绝不存明文）；库泄漏拿不到活 token
  user_id      TEXT NOT NULL,              -- 该 token 归属的 user（users.id，§17.11）
  kind         TEXT NOT NULL CHECK (kind IN ('verify','reset')), -- 'verify'（邮箱验证）| 'reset'（找回密码）
  expires_at   TEXT NOT NULL,             -- ISO-8601 过期时刻（verify 24h、reset 1h，§23/§24）
  used_at      TEXT,                      -- ISO-8601 使用时刻；NULL=未用（单次使用，用过即作废）
  created_at   TEXT NOT NULL               -- ISO-8601 生成时刻
);

-- 按 user_id 清理一个用户名下的残留 token（覆盖重注册 / 改密成功后作废旧 token，§17.2/§24）。
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens (user_id, kind);
