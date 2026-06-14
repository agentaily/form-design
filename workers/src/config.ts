// config.ts — owner config orchestration: D1 read/write + encryption + masking.
// See SPEC.md §12 (后端 · owner 集成配置存取).
//
// 多租户（§17.9 第 7 条）：owner_config 由「单行单 owner」升级为「按 owner_id 多行」——
// 每个 owner（真实 user id，§17.11）拥有自己的一行配置。saveConfig / getMaskedConfig /
// getOwnerConfig 均带 `ownerId` 参数（owner-only handler 从 c.get('session').sub 取），
// 所有读 / 写按 ownerId 隔离；A 永远读不到 / 改不到 B 的配置。
//
// This module wires together the pieces:
//   - saveConfig: validate input → encrypt secret fields → upsert THIS owner's row,
//   - getMaskedConfig: read THIS owner's row → mask secrets → shape the read-back,
//   - getOwnerConfig: read + decrypt THIS owner's row → in-Worker plaintext view.
//
// The DOM-free / network-free decisions here (validation, masking, the masked
// shape, the empty skeleton) are inner-loop unit-test targets. The Hono routes
// (request parsing, status codes) sit on top in index.ts and are exercised by
// the outer loop via SELF.fetch.

import type { SealedSecret } from "./crypto";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto";

/**
 * 迁移期兜底 owner id（'default'）。多租户改造后**不再硬编码**进任何读 / 写——`saveConfig`
 * / `getMaskedConfig` / `getOwnerConfig` 都用传入的 `ownerId`（真实 user id）。保留此常量
 * 仅为迁移脚本 `002-migrate-default-owner.sql` 的字面量参照（把现有 owner_id='default' 的
 * 配置迁给首个注册账号，§17 引言）。本常量的最终去留交 implementer（可删）。
 */
export const LEGACY_DEFAULT_OWNER_ID = "default";

/**
 * Thrown by {@link saveConfig} when the input fails validation (e.g. a missing /
 * empty DeepSeek `apiKey`). The Hono route catches this and surfaces it as a
 * `400 { error }`, leaving D1 untouched. See SPEC.md §12.3.
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/** DeepSeek connection input. `apiKey` is required and non-empty. */
export interface DeepSeekInput {
  /** DeepSeek API key. Required, non-empty (the only required field). */
  apiKey: string;
  /** Optional model id; omitted / empty means "unspecified". */
  model?: string;
}

/**
 * Feishu Bitable connection input. Optional as a whole block.
 *
 * **账户级凭据只需 `appId` + `appSecret`（§16.9）。** `appToken` / `tableId` 不再由 owner 填——
 * 改由「发布即自动建表」per-form 产出并写进 form 行（见 SPEC §16.9 / feishu-schema.ts）。二者保留
 * 为**可选**：提供则存（向后兼容旧前端飞书卡的分享链接回显），缺省 → NULL（不再要求）。PR-4
 * 前端飞书卡 link-less 落地后，这两个字段从输入彻底退场。
 */
export interface FeishuInput {
  appId: string;
  /** Secret — encrypted at rest. */
  appSecret: string;
  /** @deprecated 不再由 owner 填，改由自动建表写进 form 行（§16.9）；提供则存、缺省 → NULL。 */
  appToken?: string;
  /** @deprecated 同 {@link appToken}。 */
  tableId?: string;
}

/**
 * The save payload for `POST /api/config`. `feishu` is optional: omitting it
 * means "no Feishu configured yet".
 */
export interface OwnerConfigInput {
  deepseek: DeepSeekInput;
  feishu?: FeishuInput;
}

/**
 * The decrypted, in-Worker view of a stored config. Produced by decrypting the
 * D1 row; used only internally by later features (LLM proxy, write-to-Feishu).
 * NEVER returned to clients — `GET /api/config` returns {@link MaskedConfig}.
 *
 * `null` on a block means "not configured".
 */
export interface OwnerConfig {
  deepseek: {
    apiKey: string;
    model: string | null;
  } | null;
  feishu: {
    appId: string;
    appSecret: string;
    appToken: string;
    tableId: string;
  } | null;
  updatedAt: string | null;
}

/** A masked secret field: a masked string when configured, `null` when never set. */
export type MaskedSecret = string | null;

/** A plaintext-echo field: the stored value when set, `null` when unset. */
export type PlainField = string | null;

/**
 * The read-back shape for `GET /api/config` (and the body echoed by a successful
 * `POST`). Secret fields are masked; non-secret fields are echoed in plaintext;
 * a never-configured store yields an all-`null` skeleton. See SPEC.md §12.3.
 */
export interface MaskedConfig {
  deepseek: {
    /** Masked key (e.g. "sk-…wxyz"); `null` when never configured. */
    apiKey: MaskedSecret;
    model: PlainField;
  };
  feishu: {
    appId: PlainField;
    /** Masked secret; `null` when never configured. */
    appSecret: MaskedSecret;
    appToken: PlainField;
    tableId: PlainField;
  };
  /** ISO-8601 of the last write; `null` when never configured. */
  updatedAt: PlainField;
}

/**
 * Encryption helpers config.ts depends on. Lets saveConfig encrypt the two
 * secret fields without importing the crypto impl directly (keeps the
 * orchestration pure & testable with a fake). Implementations come from
 * crypto.ts; the signatures mirror them.
 */
export interface SecretCrypto {
  encryptSecret(plaintext: string, key: CryptoKey): Promise<SealedSecret>;
}

/**
 * Validate + persist THIS owner's config as its own row (upsert keyed on
 * `ownerId`, §17.9 第 7 条), refreshing `updated_at`.
 *
 * - `ownerId` 是当前登录 owner 的真实 user id（owner-only handler 从
 *   `c.get('session').sub` 取，§17.5）；写入只影响**这一个 owner** 的行，绝不碰别的 owner。
 * - Encrypts DeepSeek `apiKey` and (when `feishu` present) `appSecret` with
 *   `key`, each under its own fresh iv; stores cipher/iv pairs. Non-secret
 *   fields are stored as plaintext.
 * - Rejects a missing / empty DeepSeek `apiKey` (the route surfaces this as
 *   `400` and nothing is written). See SPEC.md §12.3.
 *
 * @param db D1 binding.
 * @param key AES-GCM master key (from CONFIG_KEY).
 * @param ownerId 当前 owner 的真实 user id（隔离键，§17.9）。
 * @param input 待保存的配置。
 * @throws if validation fails (e.g. DeepSeek apiKey empty).
 */
export async function saveConfig(
  db: D1Database,
  key: CryptoKey,
  ownerId: string,
  input: OwnerConfigInput,
): Promise<void> {
  // DeepSeek apiKey is the only required field; empty / whitespace-only counts as
  // missing. Validate before touching D1 so a rejected save writes nothing.
  const apiKey = input.deepseek?.apiKey;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new ConfigValidationError("deepseek.apiKey is required");
  }

  const deepseekKey = await encryptSecret(apiKey, key);
  const deepseekModel = normalizePlain(input.deepseek.model);

  // Feishu is an optional whole block. When present, its secret is encrypted; the
  // rest stays plaintext for read-back echo. When absent, all feishu columns NULL.
  let feishuAppId: string | null = null;
  let feishuSecret: SealedSecret | null = null;
  let feishuAppToken: string | null = null;
  let feishuTableId: string | null = null;
  if (input.feishu) {
    // 账户级飞书凭据只需 app_id + app_secret（§16.9，PR-3 解除旧 all-or-nothing）：缺其一仍
    // 视为半填拒绝（appSecret 无 appId 无法 auth、appId 无 appSecret 换不到 token），但
    // **app_token / table_id 不再必填**——它们改由「发布即自动建表」per-form 产出并写进 form 行。
    // 这里二者保留为**可选**：提供则原样存（向后兼容旧前端飞书卡的分享链接回显），缺省 → NULL。
    const fe = input.feishu;
    const filled = (v: unknown) => typeof v === "string" && v.trim().length > 0;
    if (!filled(fe.appId) || !filled(fe.appSecret)) {
      throw new ConfigValidationError("feishu requires app_id and app_secret");
    }
    feishuAppId = normalizePlain(fe.appId);
    feishuSecret = await encryptSecret(fe.appSecret, key);
    // 可选、向后兼容：normalizePlain 把 undefined / 空串 → null（= 不再用于同步，仅回显）。
    feishuAppToken = normalizePlain(fe.appToken);
    feishuTableId = normalizePlain(fe.tableId);
  }

  const updatedAt = new Date().toISOString();

  // Upsert THIS owner's row, keyed on the real user id (SPEC.md §12.5 / §17.9).
  await db
    .prepare(
      `INSERT INTO owner_config (
         owner_id,
         deepseek_key_cipher, deepseek_key_iv, deepseek_model,
         feishu_app_id, feishu_secret_cipher, feishu_secret_iv, feishu_app_token, feishu_table_id,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         deepseek_key_cipher = excluded.deepseek_key_cipher,
         deepseek_key_iv = excluded.deepseek_key_iv,
         deepseek_model = excluded.deepseek_model,
         feishu_app_id = excluded.feishu_app_id,
         feishu_secret_cipher = excluded.feishu_secret_cipher,
         feishu_secret_iv = excluded.feishu_secret_iv,
         feishu_app_token = excluded.feishu_app_token,
         feishu_table_id = excluded.feishu_table_id,
         updated_at = excluded.updated_at`,
    )
    .bind(
      ownerId,
      deepseekKey.ciphertext,
      deepseekKey.iv,
      deepseekModel,
      feishuAppId,
      feishuSecret?.ciphertext ?? null,
      feishuSecret?.iv ?? null,
      feishuAppToken,
      feishuTableId,
      updatedAt,
    )
    .run();
}

/** Trim a plaintext field; empty / unset becomes `null` (stored as SQL NULL). */
function normalizePlain(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Row shape for the single owner_config record. */
interface ConfigRow {
  deepseek_key_cipher: string | null;
  deepseek_key_iv: string | null;
  deepseek_model: string | null;
  feishu_app_id: string | null;
  feishu_secret_cipher: string | null;
  feishu_secret_iv: string | null;
  feishu_app_token: string | null;
  feishu_table_id: string | null;
  updated_at: string | null;
}

/**
 * Read THIS owner's config row and shape it into the masked read-back view.
 *
 * - `ownerId` 是当前登录 owner 的真实 user id（§17.5 / §17.9）；只读**这一个 owner** 的行。
 * - Secret fields (DeepSeek key, Feishu secret) are decrypted with `key`, then
 *   masked (head/tail kept, middle hidden) — the response carries only the mask,
 *   never the full plaintext. So the owner recognizes which key is set (e.g.
 *   `sk-…wxyz`) and the mask is deterministic across re-saves of the same key.
 * - Non-secret fields are echoed in plaintext.
 * - When this owner's row does not exist, returns the all-`null` skeleton (a valid,
 *   non-error "never configured" state). See SPEC.md §12.3, §12.4.
 *
 * @param db D1 binding.
 * @param key AES-GCM master key (from CONFIG_KEY).
 * @param ownerId 当前 owner 的真实 user id（隔离键，§17.9）。
 */
export async function getMaskedConfig(
  db: D1Database,
  key: CryptoKey,
  ownerId: string,
): Promise<MaskedConfig> {
  const row = await db
    .prepare(
      `SELECT
         deepseek_key_cipher, deepseek_key_iv, deepseek_model,
         feishu_app_id, feishu_secret_cipher, feishu_secret_iv, feishu_app_token, feishu_table_id,
         updated_at
       FROM owner_config WHERE owner_id = ?`,
    )
    .bind(ownerId)
    .first<ConfigRow>();

  // Never configured → the all-null skeleton (a valid 200 "never configured" state).
  if (row === null) {
    return {
      deepseek: { apiKey: null, model: null },
      feishu: { appId: null, appSecret: null, appToken: null, tableId: null },
      updatedAt: null,
    };
  }

  // Secret fields: decrypt then mask the plaintext (a null cipher means never set
  // → null, not a mask). The full plaintext never leaves this function.
  return {
    deepseek: {
      apiKey: await maskStored(row.deepseek_key_cipher, row.deepseek_key_iv, key),
      model: row.deepseek_model,
    },
    feishu: {
      appId: row.feishu_app_id,
      appSecret: await maskStored(row.feishu_secret_cipher, row.feishu_secret_iv, key),
      appToken: row.feishu_app_token,
      tableId: row.feishu_table_id,
    },
    updatedAt: row.updated_at,
  };
}

/**
 * Read a specific owner's config row and decrypt it into the in-Worker
 * {@link OwnerConfig} view — the **plaintext** form, for features that actually
 * call upstream (the LLM proxy `POST /api/chat`, write-to-Feishu). See SPEC.md §13.1.
 *
 * **`ownerId` 是哪个 owner（§17.9）取决于调用方：**
 * - owner-only 端点（`/api/chat`、`/api/config/test`、看提交）：传**当前登录 owner**
 *   的真实 user id（`c.get('session').sub`）——读该 owner 自己的配置（§17.9 第 4/7 条）。
 * - 公开 `POST /api/submit`（无登录 owner）：传按 `formSlug` 用 `getFormOwner(db, slug)`
 *   **反查出的 form 所属 owner_id**——把作答写进这张表所属那个 owner 的飞书（§16.5 / §17.9 第 5 条）。
 *
 * - Secret fields (DeepSeek key, Feishu secret) are **decrypted** with `key` to
 *   their full plaintext (NOT masked — the proxy needs the real key for the
 *   upstream `Authorization` header). Unlike {@link getMaskedConfig}, this view
 *   is internal-only and must NEVER be returned to clients.
 * - A block is `null` when its secret was never configured (no cipher/iv): an
 *   unconfigured DeepSeek block → `deepseek: null` (the proxy turns this into a
 *   `409`); an unconfigured Feishu block → `feishu: null`.
 * - When this owner's row does not exist at all, every block is `null` and
 *   `updatedAt` is `null` (the never-configured state).
 *
 * @param db D1 binding.
 * @param key AES-GCM master key (from CONFIG_KEY).
 * @param ownerId 目标 owner 的真实 user id（当前 owner 或 form 所属 owner，见上）。
 * @throws if a stored cipher/iv fails to authenticate under `key`
 *   (tampering / wrong CONFIG_KEY) — surfaced by {@link decryptSecret}.
 */
export async function getOwnerConfig(
  db: D1Database,
  key: CryptoKey,
  ownerId: string,
): Promise<OwnerConfig> {
  const row = await db
    .prepare(
      `SELECT
         deepseek_key_cipher, deepseek_key_iv, deepseek_model,
         feishu_app_id, feishu_secret_cipher, feishu_secret_iv, feishu_app_token, feishu_table_id,
         updated_at
       FROM owner_config WHERE owner_id = ?`,
    )
    .bind(ownerId)
    .first<ConfigRow>();

  // Never configured at all → every block null (the never-configured state).
  if (row === null) {
    return { deepseek: null, feishu: null, updatedAt: null };
  }

  // DeepSeek block is present only when its secret was actually sealed (cipher+iv).
  // A missing cipher means "never configured" → deepseek: null (the proxy → 409).
  let deepseek: OwnerConfig["deepseek"] = null;
  if (row.deepseek_key_cipher !== null && row.deepseek_key_iv !== null) {
    deepseek = {
      apiKey: await decryptSecret(row.deepseek_key_cipher, row.deepseek_key_iv, key),
      model: row.deepseek_model,
    };
  }

  // Feishu block is present only when its secret was sealed (cipher+iv); the
  // non-secret fields ride along as plaintext.
  let feishu: OwnerConfig["feishu"] = null;
  if (row.feishu_secret_cipher !== null && row.feishu_secret_iv !== null) {
    feishu = {
      appId: row.feishu_app_id ?? "",
      appSecret: await decryptSecret(row.feishu_secret_cipher, row.feishu_secret_iv, key),
      appToken: row.feishu_app_token ?? "",
      tableId: row.feishu_table_id ?? "",
    };
  }

  return { deepseek, feishu, updatedAt: row.updated_at };
}

/** Decrypt a stored secret and mask its plaintext; `null`/empty cipher stays `null` ("never set"). */
async function maskStored(
  cipher: string | null,
  iv: string | null,
  key: CryptoKey,
): Promise<MaskedSecret> {
  if (cipher === null || cipher.length === 0 || iv === null) return null;
  return maskSecret(await decryptSecret(cipher, iv, key));
}
