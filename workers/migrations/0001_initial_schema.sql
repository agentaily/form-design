-- users — 注册账号（owner）表。见 SPEC.md §17（后端 · owner 鉴权：多用户注册登录）。
--
-- 多用户设计（开放注册）：
--   * 任意邮箱 + 密码自助注册即成 owner；email 唯一（登录名 + 注册去重的最终裁决）。
--   * users.id（crypto.randomUUID()）是隔离键：即 session JWT 的 sub，也即
--     owner_config.owner_id / forms.owner_id 写入的真实 user id（§17.5 / §17.9 / §17.11）。
--
-- 安全约定：
--   * 明文密码绝不入库：只存 PBKDF2-HMAC-SHA256 派生的 password_hash + per-user
--     password_salt（均 base64）+ iterations（记录以便日后调参不破旧 hash，§17.4）。
--   * email_verified 预留恒 0：本期不做邮箱验证 / 不发信（发信钩子预留不启用）；
--     接 Resend 是增量、不重构（§17 引言）。

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,           -- crypto.randomUUID()；也是 owner_config / forms 的 owner_id
  email          TEXT NOT NULL UNIQUE,       -- 登录名 + 唯一约束（注册去重的最终裁决）
  password_hash  TEXT NOT NULL,              -- PBKDF2-HMAC-SHA256 派生值 (base64)
  password_salt  TEXT NOT NULL,              -- per-user 随机 salt (base64)
  iterations     INTEGER NOT NULL,           -- PBKDF2 迭代数（起步 100000，记录以便调参不破旧 hash）
  email_verified INTEGER NOT NULL DEFAULT 0, -- 预留，先恒 0（邮箱验证留后续 feature）
  created_at     TEXT NOT NULL               -- ISO-8601
);

-- owner_config — owner 集成配置（DeepSeek + 飞书多维表格）的持久化表。
-- 见 SPEC.md §12（后端 · owner 集成配置存取）。
--
-- 多租户设计（每 owner 一行）：
--   * 主键 owner_id 是 owner 的真实 user id（users.id，§17.11）；按 owner_id 整行 upsert
--     （同一 owner 重复保存覆盖自己那行）。
--   * 所有读 / 写按 owner_id 隔离（saveConfig / getMaskedConfig / getOwnerConfig 带 ownerId
--     参数，owner-only handler 从 c.get('session').sub 取）；A 永远读不到 / 改不到 B 的配置
--     （§17.9 第 7 条）。
--
-- 安全约定：
--   * 密钥字段（DeepSeek apiKey、飞书 appSecret）以 AES-GCM 密文 + 每字段独立
--     iv 落库，二者均为 base64 字符串；明文绝不入库。
--   * 加密主密钥从 Worker secret CONFIG_KEY 读，不在本表、不进 git。
--   * 非密字段（model / appId / appToken / tableId）明文存，便于前端回显。
--   * *_cipher 与对应 *_iv 成对：要么同时有值、要么同时为 NULL。

CREATE TABLE IF NOT EXISTS owner_config (
  owner_id              TEXT PRIMARY KEY,   -- owner 的真实 user id（users.id，§17.11）；每 owner 一行

  -- DeepSeek
  deepseek_key_cipher   TEXT,               -- AES-GCM 密文 (base64)
  deepseek_key_iv       TEXT,               -- 该密文的 iv (base64)，与 cipher 成对
  deepseek_model        TEXT,               -- 明文，可空

  -- 飞书多维表格
  feishu_app_id         TEXT,               -- 明文，可空
  feishu_secret_cipher  TEXT,               -- AES-GCM 密文 (base64)
  feishu_secret_iv      TEXT,               -- 该密文的 iv (base64)，与 cipher 成对
  feishu_app_token      TEXT,               -- 多维表格 app token，明文，可空
  feishu_table_id       TEXT,               -- 明文，可空

  updated_at            TEXT NOT NULL       -- ISO-8601，每次写入刷新
);

-- forms — 已发布表单的定义（meta + fields）。见 SPEC.md §16（后端 · 表单发布 + 公开填写）。
--
-- 多租户设计（每张表归属一个 owner）：
--   * owner_id 是发布它的 owner 的真实 user id（users.id，§17.11）；slug 仍全局唯一（作主键）。
--   * owner-only 的按 slug 操作（PATCH / DELETE / 看提交）须 WHERE slug=? AND owner_id=? 校验
--     归属，跨 owner → 404（不暴露存在性，§17.9 第 2/3/4 条）；列表只列当前 owner（§17.9 第 6 条）。
--   * 公开 submit 按 slug 反查 owner_id 定位该写哪个 owner 的飞书（§16.5 / §17.9 第 5 条）。
--   * 公开拉取 GET /api/forms/:slug 始终只投影 meta + fields，不带 owner 维度。
--
-- 安全约定（公开拉取不泄漏凭据）：
--   * 本表只存表单的展示 meta 与字段定义，**绝不**存任何凭据（DeepSeek key /
--     飞书 app_secret 等都在 owner_config，且只在 Worker 内解密使用）。
--   * 公开拉取的 PublicForm 视图只读 meta_json + schema_json + slug；owner_id /
--     status / created_at 不回给答题者。

CREATE TABLE IF NOT EXISTS forms (
  slug          TEXT PRIMARY KEY,   -- 公开 slug：对外标识 + 主键。全局唯一、不可枚举 / 不可猜（§16.3）
  owner_id      TEXT NOT NULL,      -- 发布它的 owner 的真实 user id（users.id，§17.11）
  meta_json     TEXT NOT NULL,      -- 序列化的 FormMeta（title / description），展示用
  schema_json   TEXT NOT NULL,      -- 序列化的 Field[]（数据真相），公开拉取原样回
  status        TEXT NOT NULL,      -- 'published' | 'draft' | 'closed'；MVP 发布即 'published'
  created_at    TEXT NOT NULL       -- ISO-8601，发布时刻
);
