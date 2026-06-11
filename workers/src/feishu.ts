// feishu.ts — shared Feishu upstream helpers.
// See SPEC.md §14 (连接测试) and §15 (提交写飞书多维表格 /api/submit).
//
// Both the connection test (§14, conntest.ts) and the submit-to-bitable flow
// (§15, submit.ts) need to exchange the owner's self-built-app credentials for a
// `tenant_access_token` first. This module owns that single shared step so the
// two callers don't duplicate the upstream contract.
//
// Layering: `getFeishuTenantToken` is the inner-loop unit-test target and the
// outer-loop seam — it makes exactly one upstream call (the tenant_access_token
// exchange) and either returns the token or throws a recognizable error. The
// routes that orchestrate it (conntest's /api/config/test, submit's /api/submit)
// sit on top in index.ts and are exercised by the outer loop via SELF.fetch with
// a mocked open.feishu.cn.
//
// REFACTOR NOTE for implementer: conntest.ts's `testFeishu(appId, appSecret)`
// currently inlines this exchange. Once `getFeishuTenantToken` lands, conntest
// MAY be refactored to delegate to it — but `testFeishu`'s public signature and
// observed behavior (returns ConnProbe, never throws, swallows upstream/network
// errors into `{ ok:false, message }`) MUST stay unchanged. The difference is
// deliberate: `testFeishu` maps failure to a soft ConnProbe; `getFeishuTenantToken`
// throws on failure because its callers (submit) need to abort and surface an error.

/** Feishu self-built-app tenant token endpoint. Shared with §14. SPEC.md §15.5. */
export const FEISHU_TENANT_TOKEN_URL =
  "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";

/** Feishu business-success code: HTTP 200 may still carry a non-zero error code,
 * so success requires `code === 0`. Shared with §14 (conntest). SPEC.md §15.5. */
export const FEISHU_OK_CODE = 0;

/**
 * Thrown when exchanging the owner's `app_id` + `app_secret` for a
 * `tenant_access_token` fails — upstream non-2xx, body `code !== 0`, or the
 * upstream is unreachable. The submit route surfaces this as a `502 { error }`.
 *
 * The `message` MUST NOT contain the owner's `app_secret` or anything that could
 * reconstruct it; it may carry the non-sensitive upstream `code` / HTTP status as
 * a troubleshooting hint. See SPEC.md §15.6, §15.7.
 */
export class FeishuTokenError extends Error {
  constructor(message = "飞书换取 tenant_access_token 失败") {
    super(message);
    this.name = "FeishuTokenError";
  }
}

/**
 * Exchange the owner's self-built-app credentials for a `tenant_access_token`.
 *
 * - Calls `POST` {@link FEISHU_TENANT_TOKEN_URL} with JSON body
 *   `{ app_id, app_secret }`.
 * - Success requires upstream `200` AND response body `code === 0`
 *   ({@link FEISHU_OK_CODE}); returns the `tenant_access_token` string.
 * - Non-zero `code`, non-2xx, unparseable body, or an unreachable upstream →
 *   throws {@link FeishuTokenError} (the submit route maps it to `502 { error }`).
 * - `appId` / `appSecret` ride only the outgoing request body; the returned token
 *   and any thrown message MUST NEVER contain the `app_secret`. See SPEC.md §15.7.
 *
 * @param appId owner's Feishu app id (from getOwnerConfig).
 * @param appSecret owner's plaintext Feishu app secret (from getOwnerConfig).
 * @returns the `tenant_access_token` on success.
 * @throws {@link FeishuTokenError} when the exchange fails.
 */
export async function getFeishuTenantToken(appId: string, appSecret: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(FEISHU_TENANT_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
  } catch {
    // Network error / timeout: the upstream itself is unreachable. The caught
    // error may embed request details (incl. the body), so we NEVER fold it into
    // the message — only a fixed, credential-free hint. SPEC.md §15.7.
    throw new FeishuTokenError("飞书换取 tenant_access_token 失败：上游不可达");
  }

  // Feishu's quirk: HTTP 200 can still carry a non-zero business code, so the
  // verdict is the body `code`, not the status. A body we can't parse as JSON is
  // treated as a failed exchange. Only the non-sensitive HTTP status / upstream
  // code may ride the message — never the app_secret. SPEC.md §15.5, §15.7.
  let body: { code?: number; tenant_access_token?: string };
  try {
    body = (await res.json()) as { code?: number; tenant_access_token?: string };
  } catch {
    throw new FeishuTokenError(`飞书换取 tenant_access_token 失败：上游返回 ${res.status}`);
  }

  if (res.ok && body.code === FEISHU_OK_CODE && typeof body.tenant_access_token === "string") {
    return body.tenant_access_token;
  }
  // Surface only the (non-sensitive) upstream code as a troubleshooting hint.
  throw new FeishuTokenError(`飞书换取 tenant_access_token 失败：code ${body.code}`);
}
