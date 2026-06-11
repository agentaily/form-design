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
