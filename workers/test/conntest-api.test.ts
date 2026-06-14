import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { applySchema, resetConfig, login, authHeader } from "./helpers";
import {
  DEEPSEEK_MODELS_URL,
  FEISHU_TENANT_TOKEN_URL,
  type ConnTestResult,
  type ConnTestSingleResult,
} from "../src/conntest";

// POST /api/config/test (and the POST /api/config setup it relies on) are now
// owner-only (SPEC.md §17.1): every request carries `Authorization: Bearer <jwt>`
// from login(). The §14 behaviour under test is unchanged — auth is just the new
// front gate.

// Outer-loop acceptance specs for the connection test `POST /api/config/test`,
// driven through the real Hono app in workerd via SELF.fetch, with BOTH upstreams
// (api.deepseek.com /models and open.feishu.cn tenant_access_token) mocked
// locally — never hits the real network (see installConnMock).
//
// Realizes every scenario of workers/features/conn-test.feature:
//   1. 两条都配且上游都 OK → 两个连接都通过
//   2. DeepSeek key 失效 → 该条 ok 为假且 message 不含 key；飞书仍通
//   3. 飞书凭据失效（HTTP 200 但 code≠0）→ 该条 ok 为假且 message 不含 app secret；DeepSeek 仍通
//   4. 飞书未配置 → 该条 ok 为假（未配置）且飞书上游零调用；DeepSeek 仍探测
//   5. 两块都未配置 → 两条都 ok 为假（未配置）且任何上游零调用
//   6. 整个响应不含任何明文 key / app_secret
//
// Contract: SPEC.md §14.

const BASE = "https://api.local";

// Concrete owner credential fixtures. Distinctive + long enough that, were any to
// ever leak into a response body/message/header, a substring scan catches it
// unmistakably. These are the plaintext values we write into D1 via POST /api/config
// (encrypted at rest); the test then asserts they never reappear in any response.
const OWNER_DEEPSEEK_KEY = "sk-owner-DEEPSEEK-secret-0123456789abcdef";
const OWNER_FEISHU_APP_ID = "cli_fixtureAppId9999";
const OWNER_FEISHU_APP_SECRET = "feishu-APP-SECRET-qrstuvwxyz-7777-SHHH";
const OWNER_FEISHU_APP_TOKEN = "bascnFixtureAppTokenXYZ";
const OWNER_FEISHU_TABLE_ID = "tblFixture123";

// Candidate (unsaved) credentials the owner types into a card and tests BEFORE saving
// (PR #72 verify-before-save). Distinct from the stored fixtures so we can prove the
// route probed with THESE, not the stored ones — and that they never leak into a response.
const CANDIDATE_DEEPSEEK_KEY = "sk-candidate-UNSAVED-key-1111-2222-3333-4444";
const CANDIDATE_FEISHU_APP_ID = "cli_candidateUnsaved8888";
const CANDIDATE_FEISHU_APP_SECRET = "feishu-CANDIDATE-secret-unsaved-9999-zzz";

// Feishu's quirk: HTTP is still 200 even on a credential failure — connectivity is
// decided by the body `code` (0 = ok, non-zero = business error). SPEC.md §14.2.
const FEISHU_OK_BODY = JSON.stringify({
  code: 0,
  msg: "ok",
  tenant_access_token: "t-xxxxxxxxxxxxxxxx",
  expire: 7200,
});
const FEISHU_BAD_CODE = 99991663;
const FEISHU_BAD_BODY = JSON.stringify({
  code: FEISHU_BAD_CODE,
  msg: "app ticket invalid",
});

// --- Multi-upstream fetch mock (default-deny, origin/path dispatch) -----------
//
// Unlike the chat suite's single-origin installUpstreamMock, the conn test fans
// out to TWO upstreams. We dispatch on the exact upstream URL; any unmatched URL
// THROWS. The throw is load-bearing for scenarios 4 & 5: when a block is
// unconfigured the route must NOT probe its upstream — if it did, the unconfigured
// upstream would have an empty/undefined reply slot and we'd see a recorded call.
// We assert per-upstream call counts to prove "zero upstream calls".

interface UpstreamReply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface ConnMockOpts {
  /** Reply for GET https://api.deepseek.com/models. Omit ⇒ that upstream must NOT be called (throws if it is). */
  deepseek?: UpstreamReply;
  /** Reply for POST the Feishu tenant token URL. Omit ⇒ that upstream must NOT be called (throws if it is). */
  feishu?: UpstreamReply;
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  bodyText: string;
  body: unknown;
}

interface ConnMock {
  readonly deepseekCalls: CapturedCall[];
  readonly feishuCalls: CapturedCall[];
  restore(): void;
}

function installConnMock(opts: ConnMockOpts): ConnMock {
  const deepseekCalls: CapturedCall[] = [];
  const feishuCalls: CapturedCall[] = [];

  const realFetch = globalThis.fetch;
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as RequestInfo, init);
    const bodyText = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
    let parsed: unknown;
    try {
      parsed = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
    } catch {
      parsed = undefined;
    }
    const captured: CapturedCall = {
      url: req.url,
      method: req.method,
      headers: new Headers(req.headers),
      bodyText,
      body: parsed,
    };

    if (req.url === DEEPSEEK_MODELS_URL) {
      if (!opts.deepseek) {
        throw new Error(`unexpected DeepSeek upstream call to ${req.url} (no reply configured)`);
      }
      deepseekCalls.push(captured);
      return new Response(opts.deepseek.body, {
        status: opts.deepseek.status,
        headers: opts.deepseek.headers ?? { "content-type": "application/json" },
      });
    }
    if (req.url === FEISHU_TENANT_TOKEN_URL) {
      if (!opts.feishu) {
        throw new Error(`unexpected Feishu upstream call to ${req.url} (no reply configured)`);
      }
      feishuCalls.push(captured);
      return new Response(opts.feishu.body, {
        status: opts.feishu.status,
        headers: opts.feishu.headers ?? { "content-type": "application/json" },
      });
    }
    // Default-deny: the route must only ever talk to the two configured upstreams.
    throw new Error(
      `unexpected outbound fetch to ${req.url} (only DeepSeek /models and Feishu tenant token are mocked)`,
    );
  };

  globalThis.fetch = stub as typeof fetch;
  return {
    deepseekCalls,
    feishuCalls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

/**
 * Seed D1 with the owner config via the real, already-implemented POST /api/config
 * (secrets encrypted at rest). The conn test reads back THIS config — credentials
 * are never taken from the /api/config/test request body (SPEC.md §14.1).
 */
// Owner-only (§17.1): attach the session token obtained in beforeEach.
let token: string;

async function configureOwner(opts: { deepseek?: boolean; feishu?: boolean }): Promise<void> {
  const body: Record<string, unknown> = {};
  // DeepSeek is the required block — POST /api/config 400s without it. When the
  // scenario wants "DeepSeek configured", include it; otherwise we don't call
  // configureOwner at all (the never-configured case writes nothing).
  if (opts.deepseek) {
    body.deepseek = { apiKey: OWNER_DEEPSEEK_KEY, model: "deepseek-chat" };
  }
  if (opts.feishu) {
    body.feishu = {
      appId: OWNER_FEISHU_APP_ID,
      appSecret: OWNER_FEISHU_APP_SECRET,
      appToken: OWNER_FEISHU_APP_TOKEN,
      tableId: OWNER_FEISHU_TABLE_ID,
    };
  }
  const res = await SELF.fetch(`${BASE}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new Error(`setup configureOwner failed: ${res.status} ${await res.text()}`);
  }
}

function postConnTest(): Promise<Response> {
  // Body is empty/ignored — the conn test probes the SAVED config, not request
  // credentials (SPEC.md §14, §14.1). We still send a content-type so the route's
  // body handling (if any) sees a well-formed request. Owner-only → Bearer token.
  return SELF.fetch(`${BASE}/api/config/test`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: "{}",
  });
}

// PR #72: per-card / candidate-credential request — send a structured body (which
// single service to test + optional candidate credentials). Owner-only → Bearer token.
function postConnTestBody(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/config/test`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
}

describe("conn test POST /api/config/test (workers/features/conn-test.feature)", () => {
  let mock: ConnMock | undefined;

  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    // owner-only endpoints (POST /api/config + POST /api/config/test) need a token.
    token = await login();
  });

  afterEach(() => {
    mock?.restore();
    mock = undefined;
  });

  it("Scenario: 两条都配且上游都 OK 时两个连接都通过", async () => {
    // Given 一个已保存 DeepSeek key 与完整飞书凭据的 owner
    await configureOwner({ deepseek: true, feishu: true });
    // And 上游 DeepSeek models 接口将返回成功
    // And 上游飞书 tenant_access_token 接口将返回 code 为 0
    mock = installConnMock({
      deepseek: { status: 200, body: JSON.stringify({ data: [{ id: "deepseek-chat" }] }) },
      feishu: { status: 200, body: FEISHU_OK_BODY },
    });

    // When owner 触发连接测试
    const res = await postConnTest();

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    const result = (await res.json()) as ConnTestResult;

    // And DeepSeek 这条结果 ok 为真
    expect(result.deepseek.ok).toBe(true);
    // And 飞书这条结果 ok 为真
    expect(result.feishu.ok).toBe(true);

    // Both upstreams were probed exactly once, with the owner's saved credentials.
    expect(mock.deepseekCalls).toHaveLength(1);
    expect(mock.deepseekCalls[0].method).toBe("GET");
    expect(mock.deepseekCalls[0].headers.get("authorization")).toBe(`Bearer ${OWNER_DEEPSEEK_KEY}`);

    expect(mock.feishuCalls).toHaveLength(1);
    expect(mock.feishuCalls[0].method).toBe("POST");
    expect(mock.feishuCalls[0].body).toMatchObject({
      app_id: OWNER_FEISHU_APP_ID,
      app_secret: OWNER_FEISHU_APP_SECRET,
    });
  });

  it("Scenario: DeepSeek key 失效时该条 ok 为假且 message 不含 key", async () => {
    // Given 一个已保存 DeepSeek key 与完整飞书凭据的 owner
    await configureOwner({ deepseek: true, feishu: true });
    // And 上游 DeepSeek models 接口将以 401 拒绝
    // And 上游飞书 tenant_access_token 接口将返回 code 为 0
    mock = installConnMock({
      deepseek: {
        status: 401,
        body: JSON.stringify({ error: { message: "Authentication Fails" } }),
      },
      feishu: { status: 200, body: FEISHU_OK_BODY },
    });

    // When owner 触发连接测试
    const res = await postConnTest();

    // Then 响应状态码为 200 (连不通是正常结果，不是 HTTP 错误)
    expect(res.status).toBe(200);
    const result = (await res.json()) as ConnTestResult;

    // And DeepSeek 这条结果 ok 为假
    expect(result.deepseek.ok).toBe(false);
    // And DeepSeek 这条结果的 message 不包含 owner 的明文 DeepSeek key
    expect(result.deepseek.message ?? "").not.toContain(OWNER_DEEPSEEK_KEY);

    // And 飞书这条结果 ok 为真 (两条探测彼此独立 — SPEC §14.1)
    expect(result.feishu.ok).toBe(true);

    // The 401 was the upstream's verdict, not the route refusing to probe.
    expect(mock.deepseekCalls).toHaveLength(1);
  });

  it("Scenario: 飞书凭据失效时该条 ok 为假且 message 不含 app secret", async () => {
    // Given 一个已保存 DeepSeek key 与完整飞书凭据的 owner
    await configureOwner({ deepseek: true, feishu: true });
    // And 上游 DeepSeek models 接口将返回成功
    // And 上游飞书 tenant_access_token 接口将返回非 0 的业务错误码 (HTTP 仍 200！)
    mock = installConnMock({
      deepseek: { status: 200, body: JSON.stringify({ data: [] }) },
      feishu: { status: 200, body: FEISHU_BAD_BODY },
    });

    // When owner 触发连接测试
    const res = await postConnTest();

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    const result = (await res.json()) as ConnTestResult;

    // And 飞书这条结果 ok 为假 — 靠 body code≠0 判定，不是靠 HTTP 状态码
    expect(result.feishu.ok).toBe(false);
    // And 飞书这条结果的 message 不包含 owner 的明文飞书 app secret
    expect(result.feishu.message ?? "").not.toContain(OWNER_FEISHU_APP_SECRET);

    // And DeepSeek 这条结果 ok 为真 (彼此独立)
    expect(result.deepseek.ok).toBe(true);

    // Feishu was actually probed (HTTP 200) — the failure came from the body code.
    expect(mock.feishuCalls).toHaveLength(1);
  });

  it("Scenario: 某块未配置时该条 ok 为假并说明未配置", async () => {
    // Given 一个已保存 DeepSeek key 但未配置飞书的 owner
    await configureOwner({ deepseek: true, feishu: false });
    // And 上游 DeepSeek models 接口将返回成功.
    // Feishu reply intentionally OMITTED: probing it would THROW, proving the route
    // does not touch the Feishu upstream when that block is unconfigured.
    mock = installConnMock({
      deepseek: { status: 200, body: JSON.stringify({ data: [] }) },
    });

    // When owner 触发连接测试
    const res = await postConnTest();

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    const result = (await res.json()) as ConnTestResult;

    // And DeepSeek 这条结果 ok 为真
    expect(result.deepseek.ok).toBe(true);
    // And 飞书这条结果 ok 为假并说明未配置
    expect(result.feishu.ok).toBe(false);
    expect(result.feishu.message ?? "").toContain("未配置");

    // And 没有向上游飞书发起任何请求
    expect(mock.feishuCalls).toHaveLength(0);
    // DeepSeek was still probed (independent block).
    expect(mock.deepseekCalls).toHaveLength(1);
  });

  it("Scenario: 两块都未配置时两条都 ok 为假并说明未配置", async () => {
    // Given 一个从未配置过的 owner (resetConfig in beforeEach, no configureOwner).
    // BOTH upstream replies OMITTED: any upstream probe would THROW, proving the
    // route makes zero outbound calls when nothing is configured.
    mock = installConnMock({});

    // When owner 触发连接测试
    const res = await postConnTest();

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    const result = (await res.json()) as ConnTestResult;

    // And DeepSeek 这条结果 ok 为假并说明未配置
    expect(result.deepseek.ok).toBe(false);
    expect(result.deepseek.message ?? "").toContain("未配置");
    // And 飞书这条结果 ok 为假并说明未配置
    expect(result.feishu.ok).toBe(false);
    expect(result.feishu.message ?? "").toContain("未配置");

    // And 没有向任何上游发起请求
    expect(mock.deepseekCalls).toHaveLength(0);
    expect(mock.feishuCalls).toHaveLength(0);
  });

  it("Scenario: 响应里不含任何明文密钥", async () => {
    // Given 一个已保存 DeepSeek key 与完整飞书凭据的 owner
    await configureOwner({ deepseek: true, feishu: true });
    // And 上游 DeepSeek models 接口将以 401 拒绝
    // And 上游飞书 tenant_access_token 接口将返回非 0 的业务错误码
    // (the failing path is the riskiest for leakage — upstream-error → message.)
    mock = installConnMock({
      deepseek: {
        status: 401,
        body: JSON.stringify({ error: { message: "Authentication Fails" } }),
      },
      feishu: { status: 200, body: FEISHU_BAD_BODY },
    });

    // When owner 触发连接测试
    const res = await postConnTest();

    // The route must actually serve the conn test (200, per §14.3) — guards this
    // leakage scan from passing vacuously against a 404 with an empty body before
    // the route exists.
    expect(res.status).toBe(200);

    // Scan the ENTIRE raw response (body + every header) for plaintext credentials.
    const raw = await res.clone().text();
    // Then 整个响应里不包含 owner 的明文 DeepSeek key
    expect(raw).not.toContain(OWNER_DEEPSEEK_KEY);
    // And 整个响应里不包含 owner 的明文飞书 app secret
    expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);

    // Headers must not echo credentials either (SPEC §14.5).
    for (const [, value] of res.headers) {
      expect(value).not.toContain(OWNER_DEEPSEEK_KEY);
      expect(value).not.toContain(OWNER_FEISHU_APP_SECRET);
    }
  });

  // ── 按卡测试 + 传入待测凭据（PR #72）─────────────────────────────────────────────

  it("Scenario: 只测 DeepSeek 时不探测飞书", async () => {
    // Given 一个已保存 DeepSeek key 与完整飞书凭据的 owner
    await configureOwner({ deepseek: true, feishu: true });
    // And 上游 DeepSeek models 接口将返回成功. Feishu reply OMITTED → probing it would THROW.
    mock = installConnMock({
      deepseek: { status: 200, body: JSON.stringify({ data: [] }) },
    });

    // When owner 只触发 DeepSeek 的连接测试
    const res = await postConnTestBody({ service: "deepseek" });

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    const result = (await res.json()) as ConnTestSingleResult;

    // And 响应只含 DeepSeek 这条结果
    expect(result.deepseek).toBeDefined();
    expect(result.feishu).toBeUndefined();
    // And DeepSeek 这条结果 ok 为真
    expect(result.deepseek?.ok).toBe(true);

    // And 没有向上游飞书发起任何请求
    expect(mock.feishuCalls).toHaveLength(0);
    expect(mock.deepseekCalls).toHaveLength(1);
  });

  it("Scenario: 用请求体传入的 DeepSeek key 探测而非已存", async () => {
    // Given 一个已保存 DeepSeek key 的 owner
    await configureOwner({ deepseek: true, feishu: false });
    // And 上游 DeepSeek models 接口将返回成功
    mock = installConnMock({
      deepseek: { status: 200, body: JSON.stringify({ data: [] }) },
    });

    // When owner 用一个未保存的 DeepSeek key 触发 DeepSeek 的连接测试
    const res = await postConnTestBody({
      service: "deepseek",
      deepseek: { apiKey: CANDIDATE_DEEPSEEK_KEY },
    });

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    const result = (await res.json()) as ConnTestSingleResult;
    // And DeepSeek 这条结果 ok 为真
    expect(result.deepseek?.ok).toBe(true);

    // And 上游收到的是请求体传入的那个 key 而非已存的 key
    expect(mock.deepseekCalls).toHaveLength(1);
    expect(mock.deepseekCalls[0].headers.get("authorization")).toBe(
      `Bearer ${CANDIDATE_DEEPSEEK_KEY}`,
    );
    expect(mock.deepseekCalls[0].headers.get("authorization")).not.toContain(OWNER_DEEPSEEK_KEY);
  });

  it("Scenario: 不传凭据时回退到已存配置", async () => {
    // Given 一个已保存 DeepSeek key 的 owner
    await configureOwner({ deepseek: true, feishu: false });
    // And 上游 DeepSeek models 接口将返回成功
    mock = installConnMock({
      deepseek: { status: 200, body: JSON.stringify({ data: [] }) },
    });

    // When owner 不带凭据触发 DeepSeek 的连接测试 (no candidate creds → stored fallback)
    const res = await postConnTestBody({ service: "deepseek" });

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    // And 上游收到的是已存的 DeepSeek key
    expect(mock.deepseekCalls).toHaveLength(1);
    expect(mock.deepseekCalls[0].headers.get("authorization")).toBe(`Bearer ${OWNER_DEEPSEEK_KEY}`);
  });

  it("Scenario: 用请求体传入的飞书凭据探测未配置过飞书的 owner", async () => {
    // Given 一个已保存 DeepSeek key 但未配置飞书的 owner
    await configureOwner({ deepseek: true, feishu: false });
    // And 上游飞书 tenant_access_token 接口将返回 code 为 0. DeepSeek reply OMITTED → THROWS if probed.
    mock = installConnMock({
      feishu: { status: 200, body: FEISHU_OK_BODY },
    });

    // When owner 用一组未保存的飞书凭据触发飞书的连接测试 (verify-before-save, no stored 飞书)
    const res = await postConnTestBody({
      service: "feishu",
      feishu: { appId: CANDIDATE_FEISHU_APP_ID, appSecret: CANDIDATE_FEISHU_APP_SECRET },
    });

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    const result = (await res.json()) as ConnTestSingleResult;
    // And 飞书这条结果 ok 为真 — even though 飞书 was never SAVED (probed with candidate creds).
    expect(result.feishu?.ok).toBe(true);
    expect(result.deepseek).toBeUndefined();

    // And 上游飞书收到的是请求体传入的那组凭据
    expect(mock.feishuCalls).toHaveLength(1);
    expect(mock.feishuCalls[0].body).toMatchObject({
      app_id: CANDIDATE_FEISHU_APP_ID,
      app_secret: CANDIDATE_FEISHU_APP_SECRET,
    });

    // And 没有向上游 DeepSeek 发起任何请求
    expect(mock.deepseekCalls).toHaveLength(0);
  });

  it("Scenario: 传入的凭据不出现在响应里", async () => {
    // Given 一个未配置任何凭据的 owner (resetConfig in beforeEach, no configureOwner).
    // And 上游 DeepSeek models 接口将以 401 拒绝 (failing path is riskiest for leakage).
    mock = installConnMock({
      deepseek: {
        status: 401,
        body: JSON.stringify({ error: { message: "Authentication Fails" } }),
      },
    });

    // When owner 用一个未保存的 DeepSeek key 触发 DeepSeek 的连接测试
    const res = await postConnTestBody({
      service: "deepseek",
      deepseek: { apiKey: CANDIDATE_DEEPSEEK_KEY },
    });

    // Guard the leakage scan against passing vacuously (must actually serve the test, §14.3).
    expect(res.status).toBe(200);

    // Then 整个响应里不包含请求体传入的明文 DeepSeek key — neither in the body nor any header.
    const raw = await res.clone().text();
    expect(raw).not.toContain(CANDIDATE_DEEPSEEK_KEY);
    for (const [, value] of res.headers) {
      expect(value).not.toContain(CANDIDATE_DEEPSEEK_KEY);
    }
  });
});
