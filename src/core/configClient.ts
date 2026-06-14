// configClient.ts — frontend seam for owner integration settings (SPEC §12 + §14).
// Owner-only calls behind apiClient's Bearer injection (§17):
//   getConfig()                  → GET  /api/config       → masked view (MaskedConfig)
//   saveConfig(input)            → POST /api/config       → masked view of what was saved
//   testConnection(service,creds)→ POST /api/config/test  → SINGLE-service probe with the
//                                  card's current input value (per-card 测试连接, §14, PR #72)
//   testConnections()            → POST /api/config/test  → legacy BOTH-block stored probe
// All carry `auth: true`; a missing/expired session surfaces as a 401
// ApiError for the caller to route into the login flow (§17.4). Secrets are never
// returned in full — getConfig/saveConfig only ever hand back masked strings.
//
// Mask convention (the "don't re-submit the mask" contract, SPEC §12.4):
// secret fields (deepseek.apiKey, feishu.appSecret) come back as a mask string
// (e.g. "sk-…wxyz") when configured, or null when never set. On save, an OMITTED
// secret field (undefined) means "keep the stored secret unchanged"; a non-empty
// string OVERWRITES it. The UI must therefore send `undefined` (not the masked
// "sk-…wxyz") for a secret the owner didn't edit, so the mask is never stored back
// as if it were the real key. Non-secret fields are always sent as their plaintext.

import { apiFetch } from "./apiClient";

/** Masked DeepSeek block as returned by GET/POST /api/config (SPEC §12.3). */
export interface MaskedDeepSeek {
  /** Masked key (e.g. "sk-…wxyz") when configured; null when never set. */
  apiKey: string | null;
  /** Plaintext model id; null when unspecified. */
  model: string | null;
}

/**
 * Masked 飞书 block as returned by GET/POST /api/config (SPEC §12.3). PR-4 link-less:
 * the account-level 飞书 credential is exactly `appId` + `appSecret`. `appToken` /
 * `tableId` are NO LONGER echoed — per-form 飞书 tables come from "发布即自动建表"
 * (§16.9) and live on the forms row, surfaced via FormSummary.feishuTable, not here.
 */
export interface MaskedFeishu {
  /** Plaintext app id; null when unconfigured. */
  appId: string | null;
  /** Masked app secret (e.g. "yy…yy") when configured; null when never set. */
  appSecret: string | null;
}

/**
 * The masked config view (SPEC §12.3). Returned by both GET /api/config and the
 * 200 of POST /api/config. A never-configured backend yields an all-null skeleton
 * (every field null, `updatedAt` null) — that is the normal "未配置" state, not an
 * error. Secret fields are masked strings; the frontend can never read full secrets.
 */
export interface MaskedConfig {
  deepseek: MaskedDeepSeek;
  feishu: MaskedFeishu;
  /** ISO-8601 of the last save; null when never configured. */
  updatedAt: string | null;
}

/** DeepSeek block of a save (SPEC §12.3). */
export interface DeepSeekInput {
  /**
   * New plaintext key to store (required on first config). OMIT (undefined) to keep
   * the existing stored key unchanged when re-saving — never send the masked value.
   */
  apiKey?: string;
  /** Plaintext model id; "" / undefined means unspecified. */
  model?: string;
}

/**
 * 飞书 block of a save (SPEC §12.3). PR-4 link-less: the account-level 飞书 credential
 * is exactly `appId` + `appSecret` — no 分享链接, no `appToken` / `tableId`. Send the
 * whole block (both fields, or `appId` + an omitted-secret re-save) or omit it entirely
 * ("暂不配置飞书"). per-form 飞书 tables are auto-created at publish (§16.9), never typed here.
 */
export interface FeishuInput {
  appId?: string;
  /**
   * New plaintext app secret to store. OMIT to keep the existing stored secret
   * unchanged on re-save — never send the masked value.
   */
  appSecret?: string;
}

/**
 * Save payload for POST /api/config (SPEC §12.3). The backend enforces: DeepSeek
 * apiKey required (else 400); when a 飞书 block is sent, `appId` + `appSecret` must
 * both resolve (a half-filled block — e.g. appId with no stored/new secret — is a 400).
 * Omitting a secret subfield = "keep stored value" (see mask convention above). `feishu`
 * omitted entirely = "暂不配置飞书". (PR-4 link-less: the block is only appId + appSecret.)
 */
export interface ConfigInput {
  deepseek: DeepSeekInput;
  feishu?: FeishuInput;
}

/** One connectivity probe result (SPEC §14.3): ok + an optional human-readable note. */
export interface ConnProbe {
  ok: boolean;
  /** Short human-readable note (e.g. "未配置" / "凭据无效" / "上游不可达"); never echoes a secret. */
  message?: string;
}

/**
 * Result of POST /api/config/test (SPEC §14.3). HTTP is always 200 — "测不通" is a
 * normal result expressed as `ok:false` + message, NOT an HTTP error. The two probes
 * are independent.
 */
export interface ConnTestResult {
  deepseek: ConnProbe;
  feishu: ConnProbe;
}

/** Which single connection {@link testConnection} probes (per-card 测试连接). */
export type ConnService = "deepseek" | "feishu";

/**
 * Candidate credentials to probe a SINGLE connection WITH (verify-before-save, §14.1).
 * Omit a secret the owner did NOT edit so the backend falls back to the STORED value —
 * NEVER send the masked placeholder (the "don't submit the mask" rule, §12.4 / §14.1).
 * For 飞书, `appId` is plaintext (always sendable); `appSecret` is the only masked field.
 */
export interface ConnTestCredentials {
  /** DeepSeek candidate key (plaintext); omit to test the stored key. */
  apiKey?: string;
  /** 飞书 candidate app id (plaintext). */
  appId?: string;
  /** 飞书 candidate app secret (plaintext); omit to keep the stored secret. */
  appSecret?: string;
}

/**
 * Single-service test response (SPEC §14, per-card): only the probed block is present.
 * The legacy both-blocks path still returns the full {@link ConnTestResult}.
 */
export type ConnTestSingleResult = Partial<ConnTestResult>;

/** Request body for POST /api/config/test (SPEC §14.1, revised). All fields optional. */
export interface ConnTestRequest {
  service?: ConnService;
  deepseek?: { apiKey?: string };
  feishu?: { appId?: string; appSecret?: string };
}

/**
 * Read the current masked config (SPEC §12.3, owner-only §17). Never-configured →
 * all-null skeleton at HTTP 200. A 401 surfaces as an ApiError for the caller to
 * route into login.
 */
export function getConfig(): Promise<MaskedConfig> {
  return apiFetch<MaskedConfig>("/api/config", { auth: true });
}

/**
 * Save the owner config and get back the masked view of what was stored (SPEC §12.3,
 * owner-only §17), so the UI re-displays without a second fetch. A 400 (missing
 * DeepSeek key / half-filled 飞书) surfaces as an ApiError carrying the backend's
 * `{ error }` message; nothing is stored. Omit secret subfields the owner didn't edit.
 */
export function saveConfig(input: ConfigInput): Promise<MaskedConfig> {
  // The caller (the 集成 tab in SettingsOverlay) is responsible for OMITTING secret subfields the
  // owner didn't edit (the mask is never resubmitted, §12.4). JSON.stringify drops
  // the `undefined` values, so the wire body carries only the keys actually present.
  return apiFetch<MaskedConfig>("/api/config", { method: "POST", auth: true, body: input });
}

/**
 * Probe whether the saved DeepSeek key and 飞书 credentials connect (SPEC §14,
 * owner-only §17). Tests the stored config — takes no body. Always resolves to a
 * 200 ConnTestResult (per-block ok/message); only a 401 / infra error rejects.
 */
export function testConnections(): Promise<ConnTestResult> {
  // Probes the STORED config — no request body. The backend is HTTP 200 whether or
  // not the connections succeed (ok:false / 未配置 / 凭据无效 are normal results, not
  // errors), so this resolves on 2xx; only a 401 (session) or network/infra failure
  // rejects via apiFetch's ApiError surface.
  return apiFetch<ConnTestResult>("/api/config/test", { method: "POST", auth: true });
}

/**
 * Probe a SINGLE connection (SPEC §14, per-card 测试连接). Sends `{ service, [service]: creds }`
 * so the backend probes ONLY that block — with the supplied candidate credentials when the owner
 * edited them, or the owner's STORED config when omitted (verify-before-save, §14.1). A secret the
 * owner did NOT edit must be OMITTED from `creds` (never the masked placeholder, §12.4); 飞书 `appId`
 * is plaintext and always sendable. Resolves to that block's {@link ConnProbe} (always — "测不通" is
 * a normal `ok:false` result); only a 401 (session) or network/infra failure rejects via ApiError.
 * The owner key / app_secret are never echoed back (§14.5).
 */
export async function testConnection(
  service: ConnService,
  creds: ConnTestCredentials = {},
): Promise<ConnProbe> {
  // Only ever send the keys the owner actually typed — an omitted credential tells the
  // backend to fall back to the stored value, so the mask placeholder is never transmitted.
  const body: ConnTestRequest = { service };
  if (service === "deepseek") {
    if (creds.apiKey) body.deepseek = { apiKey: creds.apiKey };
  } else {
    const feishu: { appId?: string; appSecret?: string } = {};
    if (creds.appId) feishu.appId = creds.appId;
    if (creds.appSecret) feishu.appSecret = creds.appSecret;
    if (feishu.appId !== undefined || feishu.appSecret !== undefined) body.feishu = feishu;
  }
  const result = await apiFetch<ConnTestSingleResult>("/api/config/test", {
    method: "POST",
    auth: true,
    body,
  });
  // The single-service response carries exactly the probed block; a malformed/empty
  // reply degrades to a normal "未配置" rather than throwing.
  return result[service] ?? { ok: false, message: "未配置" };
}
