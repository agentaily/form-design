import { describe, it, expect, afterEach } from "vitest";
import { vi } from "vitest";
import {
  testDeepSeek,
  testFeishu,
  DEEPSEEK_MODELS_URL,
  FEISHU_TENANT_TOKEN_URL,
} from "../src/conntest";

// Inner-loop unit specs for the two pure/mockable probe functions in conntest.ts.
// These are the seam the outer-loop conntest-api.test.ts builds on, tested here in
// isolation by stubbing global fetch directly (no D1, no Hono):
//   - testDeepSeek: GET /models with Bearer key → 2xx ⇒ ok / 401 ⇒ fail
//   - testFeishu:   POST tenant_access_token → code 0 ⇒ ok / code≠0 ⇒ fail (HTTP 200 both)
// Asserts the verdict mapping AND that a failure `message` never contains the
// credential it was given. See SPEC.md §14.2, §14.5.

const DEEPSEEK_KEY = "sk-probe-DEEPSEEK-secret-abcdefghijklmnop-0001";
const FEISHU_APP_ID = "cli_probeAppId0001";
const FEISHU_APP_SECRET = "feishu-PROBE-app-secret-zzzzzzzz-9999-SHHH";

interface UpstreamReply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface ProbeCall {
  url: string;
  method: string;
  headers: Headers;
  bodyText: string;
  body: unknown;
}

/**
 * Stub global fetch to answer exactly one expected URL and record the call. Any
 * other URL throws — a probe that talks to the wrong endpoint fails loudly.
 */
function stubFetch(expectUrl: string, reply: UpstreamReply): { calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    if (req.url !== expectUrl) {
      throw new Error(`unexpected probe fetch to ${req.url} (expected ${expectUrl})`);
    }
    const bodyText = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
    let parsed: unknown;
    try {
      parsed = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
    } catch {
      parsed = undefined;
    }
    calls.push({
      url: req.url,
      method: req.method,
      headers: new Headers(req.headers),
      bodyText,
      body: parsed,
    });
    return new Response(reply.body, {
      status: reply.status,
      headers: reply.headers ?? { "content-type": "application/json" },
    });
  });
  return { calls };
}

describe("testDeepSeek (SPEC.md §14.2 DeepSeek probe)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps a 2xx /models response to ok:true and sends the key only on Authorization", async () => {
    const { calls } = stubFetch(DEEPSEEK_MODELS_URL, {
      status: 200,
      body: JSON.stringify({ data: [{ id: "deepseek-chat" }] }),
    });

    const probe = await testDeepSeek(DEEPSEEK_KEY);

    expect(probe.ok).toBe(true);
    // The cheapest valid-key check: GET /models with Bearer auth.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(DEEPSEEK_MODELS_URL);
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${DEEPSEEK_KEY}`);
  });

  it("maps a 401 to ok:false without leaking the key into the message", async () => {
    const { calls } = stubFetch(DEEPSEEK_MODELS_URL, {
      status: 401,
      body: JSON.stringify({ error: { message: "Authentication Fails" } }),
    });

    const probe = await testDeepSeek(DEEPSEEK_KEY);

    expect(probe.ok).toBe(false);
    // The key rode only the outgoing Authorization header — never the verdict message.
    expect(probe.message ?? "").not.toContain(DEEPSEEK_KEY);
    expect(calls).toHaveLength(1);
  });
});

describe("testFeishu (SPEC.md §14.2 Feishu probe)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps HTTP 200 + body code:0 to ok:true and sends credentials only in the body", async () => {
    const { calls } = stubFetch(FEISHU_TENANT_TOKEN_URL, {
      status: 200,
      body: JSON.stringify({
        code: 0,
        msg: "ok",
        tenant_access_token: "t-xxxxxxxxxxxxxxxx",
        expire: 7200,
      }),
    });

    const probe = await testFeishu(FEISHU_APP_ID, FEISHU_APP_SECRET);

    expect(probe.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(FEISHU_TENANT_TOKEN_URL);
    // Credentials ride the JSON body, not the URL/headers.
    expect(calls[0].body).toMatchObject({
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET,
    });
  });

  it("maps HTTP 200 + non-zero body code to ok:false without leaking the app secret", async () => {
    // Feishu's quirk: HTTP is 200 even on a credential failure — the verdict is the
    // body `code`, not the status code. SPEC.md §14.2.
    const { calls } = stubFetch(FEISHU_TENANT_TOKEN_URL, {
      status: 200,
      body: JSON.stringify({ code: 99991663, msg: "app ticket invalid" }),
    });

    const probe = await testFeishu(FEISHU_APP_ID, FEISHU_APP_SECRET);

    expect(probe.ok).toBe(false);
    // The app_secret rode only the outgoing body — never the verdict message.
    expect(probe.message ?? "").not.toContain(FEISHU_APP_SECRET);
    expect(calls).toHaveLength(1);
  });
});
