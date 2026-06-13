// configClient.ts — frontend seam for owner integration settings (SPEC §12 + §14).
// Three owner-only calls behind apiClient's Bearer injection (§17):
//   getConfig()        → GET  /api/config        → masked view (MaskedConfig)
//   saveConfig(input)  → POST /api/config        → masked view of what was saved
//   testConnections()  → POST /api/config/test   → per-block connectivity probes
// All three carry `auth: true`; a missing/expired session surfaces as a 401
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

/** Masked 飞书 block as returned by GET/POST /api/config (SPEC §12.3). */
export interface MaskedFeishu {
  /** Plaintext app id; null when unconfigured. */
  appId: string | null;
  /** Masked app secret (e.g. "yy…yy") when configured; null when never set. */
  appSecret: string | null;
  /** Plaintext bitable app token; null when unconfigured. */
  appToken: string | null;
  /** Plaintext table id; null when unconfigured. */
  tableId: string | null;
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

/** 飞书 block of a save (SPEC §12.3). All-or-nothing: send the whole block or omit it. */
export interface FeishuInput {
  appId?: string;
  /**
   * New plaintext app secret to store. OMIT to keep the existing stored secret
   * unchanged on re-save — never send the masked value.
   */
  appSecret?: string;
  appToken?: string;
  tableId?: string;
}

/**
 * Save payload for POST /api/config (SPEC §12.3). The backend enforces: DeepSeek
 * apiKey required (else 400), 飞书 all-or-nothing (else 400). Omitting a secret
 * subfield = "keep stored value" (see mask convention above). `feishu` omitted
 * entirely = "暂不配置飞书".
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
