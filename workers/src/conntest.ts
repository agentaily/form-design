// conntest.ts — type contracts for the connection test `POST /api/config/test`.
// See SPEC.md §14 (后端 · 连接测试：探一下已保存配置能否连通).
//
// This endpoint backs the 集成设置「测试连接」button. It reads the owner's
// *already-saved* config (via getOwnerConfig — credentials are NOT taken from the
// request body, SPEC.md §14.1) and independently probes whether each connection
// (DeepSeek, Feishu) is reachable with those credentials, reporting per-connection
// results.
//
// Layering: the two pure / mockable probe functions (testDeepSeek / testFeishu)
// are the inner-loop unit-test targets and the outer-loop seam — they each make
// exactly one upstream call and map the response to a ConnProbe. The Hono route
// (read+decrypt config → run both probes → 200 { deepseek, feishu }) sits on top
// in index.ts and is exercised by the outer loop via SELF.fetch with mocked
// api.deepseek.com / open.feishu.cn.

import { getFeishuTenantToken, FeishuTokenError } from "./feishu";

/** DeepSeek lightweight verification endpoint — cheapest valid-key check. SPEC.md §14.2. */
export const DEEPSEEK_MODELS_URL = "https://api.deepseek.com/models";

// The Feishu token endpoint URL + success code are owned by feishu.ts as the
// single source of truth (shared with §15's submit flow). Re-export them here so
// existing §14 consumers (tests, callers) keep their import site unchanged.
export { FEISHU_TENANT_TOKEN_URL, FEISHU_OK_CODE } from "./feishu";

/**
 * The result of probing one connection. `ok` is the only required field;
 * `message` is an optional, human-readable troubleshooting hint.
 *
 * `message` MUST NOT contain the owner's credential (DeepSeek key / Feishu
 * app_secret) or anything that could reconstruct it — even when the upstream
 * rejected the call. See SPEC.md §14.3, §14.5.
 */
export interface ConnProbe {
  /** Whether this connection is reachable with the stored credentials. */
  ok: boolean;
  /** Optional human-readable note (e.g. "未配置", "凭据无效", "上游不可达"). */
  message?: string;
}

/**
 * Response body for `POST /api/config/test`: one independent {@link ConnProbe}
 * per connection. The HTTP status is always 200 — a connection that "can't be
 * reached" is a normal result (`ok:false`), not an HTTP error. See SPEC.md §14.3.
 */
export interface ConnTestResult {
  deepseek: ConnProbe;
  feishu: ConnProbe;
}

/**
 * Probe DeepSeek with the owner's plaintext key.
 *
 * - Calls `GET` {@link DEEPSEEK_MODELS_URL} with `Authorization: Bearer <apiKey>`
 *   (the cheapest valid-key check — does not consume inference quota).
 * - Upstream `2xx` → `{ ok:true }` (key valid). Non-2xx (e.g. 401) →
 *   `{ ok:false, message }` with an upstream-rejection hint.
 * - Upstream unreachable / timeout → `{ ok:false, message }` (e.g. "上游不可达").
 * - The `apiKey` rides only the outgoing `Authorization` header; it MUST NEVER
 *   appear in the returned `message`. See SPEC.md §14.2, §14.5.
 *
 * @param apiKey owner's plaintext DeepSeek key (from getOwnerConfig).
 */
export async function testDeepSeek(apiKey: string): Promise<ConnProbe> {
  let res: Response;
  try {
    res = await fetch(DEEPSEEK_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    // Network error / timeout: the upstream itself is unreachable. The caught
    // error may embed request details, so we NEVER fold it into the message —
    // only a fixed, credential-free hint. SPEC.md §14.5.
    return { ok: false, message: "上游不可达" };
  }
  // 2xx ⇒ the key can list models ⇒ valid. Any non-2xx is a rejection; we surface
  // only the (non-sensitive) HTTP status — never the key. SPEC.md §14.2, §14.5.
  if (res.ok) {
    return { ok: true };
  }
  return { ok: false, message: `上游返回 ${res.status}` };
}

/**
 * Probe Feishu with the owner's self-built-app credentials.
 *
 * - Calls `POST` {@link FEISHU_TENANT_TOKEN_URL} with JSON body
 *   `{ app_id, app_secret }` to exchange for a `tenant_access_token`.
 * - Connectivity requires upstream `200` AND response body `code === 0`
 *   ({@link FEISHU_OK_CODE}) → `{ ok:true }`. A non-zero `code` (e.g. 99991663
 *   wrong app secret) → `{ ok:false, message }`; the upstream `code` is a
 *   non-sensitive hint that may be surfaced.
 * - Upstream unreachable / timeout → `{ ok:false, message }`.
 * - `appId` / `appSecret` ride only the outgoing request body; they MUST NEVER
 *   appear in the returned `message`. See SPEC.md §14.2, §14.5.
 *
 * @param appId owner's Feishu app id (from getOwnerConfig).
 * @param appSecret owner's plaintext Feishu app secret (from getOwnerConfig).
 */
export async function testFeishu(appId: string, appSecret: string): Promise<ConnProbe> {
  // Delegate to the shared §15 helper so the upstream contract lives in one place
  // (feishu.ts). The behavioral difference is deliberate: getFeishuTenantToken
  // THROWS on any failure (its submit caller needs to abort), whereas a connection
  // test maps the same failure to a soft ConnProbe and NEVER throws (SPEC.md §14.3).
  // The thrown FeishuTokenError message is already credential-free (§15.7), so it
  // is safe to surface as the troubleshooting hint.
  try {
    await getFeishuTenantToken(appId, appSecret);
    return { ok: true };
  } catch (err) {
    if (err instanceof FeishuTokenError) {
      return { ok: false, message: err.message };
    }
    // Defensive: any non-FeishuTokenError (shouldn't happen) still must not throw.
    return { ok: false, message: "飞书连接测试失败" };
  }
}
