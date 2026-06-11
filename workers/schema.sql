-- owner_config — owner 集成配置（DeepSeek + 飞书多维表格）的持久化表。
-- 见 SPEC.md §12（后端 · owner 集成配置存取）。
--
-- 单行单 owner 设计（MVP）：
--   * 不做登录鉴权 / 多租户。主键 owner_id 固定为 'default'，整行 upsert。
--   * 后续接入鉴权时把 owner_id 换成真实租户键即可平滑扩成多行。
--
-- 安全约定：
--   * 密钥字段（DeepSeek apiKey、飞书 appSecret）以 AES-GCM 密文 + 每字段独立
--     iv 落库，二者均为 base64 字符串；明文绝不入库。
--   * 加密主密钥从 Worker secret CONFIG_KEY 读，不在本表、不进 git。
--   * 非密字段（model / appId / appToken / tableId）明文存，便于前端回显。
--   * *_cipher 与对应 *_iv 成对：要么同时有值、要么同时为 NULL。

CREATE TABLE IF NOT EXISTS owner_config (
  owner_id              TEXT PRIMARY KEY,   -- MVP 恒为 'default'（单 owner）

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
-- 单 owner 设计（MVP）：
--   * 同 owner_config：不做登录鉴权 / 多租户。owner_id 恒为 'default'。
--   * 后续接入鉴权 / 多 owner 时，owner_id 换成真实租户键即可平滑扩成多行；
--     公开拉取 GET /api/forms/:slug 始终只投影 meta + fields，不受 owner 维度影响。
--
-- 安全约定（公开拉取不泄漏凭据）：
--   * 本表只存表单的展示 meta 与字段定义，**绝不**存任何凭据（DeepSeek key /
--     飞书 app_secret 等都在 owner_config，且只在 Worker 内解密使用）。
--   * 公开拉取的 PublicForm 视图只读 meta_json + schema_json + slug；owner_id /
--     status / created_at 不回给答题者。

CREATE TABLE IF NOT EXISTS forms (
  slug          TEXT PRIMARY KEY,   -- 公开 slug：对外标识 + 主键。不可枚举 / 不可猜（§16.3）
  owner_id      TEXT NOT NULL,      -- MVP 恒为 'default'（单 owner）
  meta_json     TEXT NOT NULL,      -- 序列化的 FormMeta（title / description），展示用
  schema_json   TEXT NOT NULL,      -- 序列化的 Field[]（数据真相），公开拉取原样回
  status        TEXT NOT NULL,      -- 'published' | 'draft' | 'closed'；MVP 发布即 'published'
  created_at    TEXT NOT NULL       -- ISO-8601，发布时刻
);
