import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { applySchema, resetConfig, resetForms, login, authHeader } from "./helpers";
import { FEISHU_BITABLE_RECORDS_URL } from "../src/submit";
import { FEISHU_TENANT_TOKEN_URL } from "../src/feishu";

// POST /api/submit stays PUBLIC (SPEC.md §17.1) — answerers send NO token, and
// these scenarios' behaviour is unchanged. But the SETUP they rely on now hits
// owner-only endpoints (POST /api/config to save creds, POST /api/forms to
// publish a form), so those setup calls carry a `Authorization: Bearer <jwt>`
// from login(). postSubmit itself never sends a token.

// Outer-loop acceptance specs for the submit-to-Bitable endpoint `POST /api/submit`,
// driven through the real Hono app in workerd via SELF.fetch, with BOTH Feishu
// upstreams (the tenant_access_token exchange, then the Bitable add-record write)
// mocked locally — never hits open.feishu.cn (see installFeishuMock).
//
// Realizes every scenario of workers/features/submit.feature:
//   1. 飞书已配 + 两段 OK → 200 { ok:true, recordId }
//   2. answers 正确映射进飞书 fields（写记录 URL 用配置的 app_token/table_id；body fields 正确）
//   3. 飞书未配 → 409，不打任何上游
//   4. 空 answers → 400，不打上游
//   5. 缺 answers → 400，不打上游
//   6. 换 token 失败（code≠0）→ 可辨识错误、不泄漏 app_secret、不再打第二段
//   7. 写记录 code≠0 → 可辨识错误、不泄漏 token / app_secret
//   8. 整个响应（body + headers）不含明文 app_secret / tenant_access_token
//
// Contract: SPEC.md §15.

const BASE = "https://api.local";

// Concrete owner credential fixtures. Distinctive + long enough that, were any to
// ever leak into a response body / message / header, a substring scan catches it
// unmistakably. These are the plaintext values written into D1 via POST /api/config
// (encrypted at rest); the tests then assert they never reappear in any response.
const OWNER_DEEPSEEK_KEY = "sk-owner-DEEPSEEK-secret-0123456789abcdef";
const OWNER_FEISHU_APP_ID = "cli_fixtureAppId9999";
const OWNER_FEISHU_APP_SECRET = "feishu-APP-SECRET-qrstuvwxyz-7777-SHHH";
const OWNER_FEISHU_APP_TOKEN = "bascnFixtureAppTokenXYZ";
const OWNER_FEISHU_TABLE_ID = "tblFixture123";

// The token the mocked exchange (stage ①) hands back; it must ONLY ever appear on
// stage ②'s Authorization header — never in any /api/submit response (§15.7).
const UPSTREAM_TENANT_TOKEN = "t-xxxxxxxxxxxxxxxx-SECRET-9999";
const UPSTREAM_RECORD_ID = "rec-xxxxxxxxxxxxxx";

// The exact add-record URL the route must hit: the template with the owner's
// app_token / table_id filled in (SPEC.md §15.5).
const BITABLE_URL = FEISHU_BITABLE_RECORDS_URL.replace(
  "{app_token}",
  OWNER_FEISHU_APP_TOKEN,
).replace("{table_id}", OWNER_FEISHU_TABLE_ID);

const FEISHU_TOKEN_OK_BODY = JSON.stringify({
  code: 0,
  msg: "ok",
  tenant_access_token: UPSTREAM_TENANT_TOKEN,
  expire: 7200,
});
const FEISHU_TOKEN_BAD_BODY = JSON.stringify({ code: 99991663, msg: "app ticket invalid" });

const BITABLE_OK_BODY = JSON.stringify({
  code: 0,
  msg: "success",
  data: { record: { record_id: UPSTREAM_RECORD_ID } },
});
const BITABLE_BAD_BODY = JSON.stringify({ code: 1254000, msg: "FieldNameNotFound" });

// --- Two-stage Feishu fetch mock (default-deny, ordered) ----------------------
//
// The submit flow fans out to TWO upstreams IN ORDER: first exchange the owner's
// app_id/app_secret for a tenant_access_token (stage ①), then write one record
// with that token (stage ②). We dispatch on the exact upstream URL; any unmatched
// URL THROWS. The throw is load-bearing:
//   - omit `token` ⇒ the route must NOT exchange a token (e.g. unconfigured / bad
//     request) — if it did, the throw records a violation.
//   - omit `record` ⇒ the route must NOT reach stage ② (e.g. token exchange
//     failed) — proving "不再打第二段".
// We assert per-stage call counts to prove "zero upstream calls" / "only stage ①".

interface UpstreamReply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface FeishuMockOpts {
  /** Reply for the tenant_access_token exchange (stage ①). Omit ⇒ must NOT be called. */
  token?: UpstreamReply;
  /** Reply for the Bitable add-record write (stage ②). Omit ⇒ must NOT be called. */
  record?: UpstreamReply;
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  bodyText: string;
  body: unknown;
}

interface FeishuMock {
  /** Stage ① (tenant_access_token exchange) calls, in order. */
  readonly tokenCalls: CapturedCall[];
  /** Stage ② (Bitable add-record) calls, in order. */
  readonly recordCalls: CapturedCall[];
  restore(): void;
}

function installFeishuMock(opts: FeishuMockOpts): FeishuMock {
  const tokenCalls: CapturedCall[] = [];
  const recordCalls: CapturedCall[] = [];

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

    if (req.url === FEISHU_TENANT_TOKEN_URL) {
      if (!opts.token) {
        throw new Error(
          `unexpected token-exchange upstream call to ${req.url} (no reply configured)`,
        );
      }
      tokenCalls.push(captured);
      return new Response(opts.token.body, {
        status: opts.token.status,
        headers: opts.token.headers ?? { "content-type": "application/json" },
      });
    }
    if (req.url === BITABLE_URL) {
      if (!opts.record) {
        throw new Error(`unexpected add-record upstream call to ${req.url} (no reply configured)`);
      }
      recordCalls.push(captured);
      return new Response(opts.record.body, {
        status: opts.record.status,
        headers: opts.record.headers ?? { "content-type": "application/json" },
      });
    }
    // Default-deny: the route must only ever talk to the two Feishu upstreams it
    // is configured for (and on stage ② only the configured app_token/table_id URL).
    throw new Error(
      `unexpected outbound fetch to ${req.url} (only the Feishu token + ${BITABLE_URL} are mocked)`,
    );
  };

  globalThis.fetch = stub as typeof fetch;
  return {
    tokenCalls,
    recordCalls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

/**
 * Seed D1 with the owner config via the real, already-implemented POST /api/config
 * (secrets encrypted at rest). The submit route reads back THIS config —
 * credentials are never taken from the /api/submit request body (SPEC.md §15.1).
 */
// Owner-only setup token (§17.1) for the POST /api/config + POST /api/forms calls.
let token: string;

async function configureOwner(opts: { feishu: boolean }): Promise<void> {
  const body: Record<string, unknown> = {
    // DeepSeek is the required block — POST /api/config 400s without it.
    deepseek: { apiKey: OWNER_DEEPSEEK_KEY, model: "deepseek-chat" },
  };
  if (opts.feishu) {
    body.feishu = {
      appId: OWNER_FEISHU_APP_ID,
      appSecret: OWNER_FEISHU_APP_SECRET,
      appToken: OWNER_FEISHU_APP_TOKEN,
      tableId: OWNER_FEISHU_TABLE_ID,
    };
  }
  // owner-only setup endpoint (§17.1) → Bearer token.
  const res = await SELF.fetch(`${BASE}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new Error(`setup configureOwner failed: ${res.status} ${await res.text()}`);
  }
}

// POST /api/submit is PUBLIC (§17.1) → intentionally NO Authorization header.
function postSubmit(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Publish a form via the real POST /api/forms route and return its slug.
 *
 * §16.5 made `formSlug` a required field on POST /api/submit and added a
 * "先校验 form 存在" gate before any Feishu call. So every submit scenario that
 * means to exercise the §15 Feishu write must FIRST publish a form and attach
 * its slug — otherwise it would 400 on the missing slug before reaching Feishu.
 * The §15 behaviour under test is unchanged; the slug is just the new front gate.
 */
async function publishFormAndGetSlug(): Promise<string> {
  // owner-only setup endpoint (§17.1) → Bearer token.
  const res = await SELF.fetch(`${BASE}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({
      meta: { title: "提交测试表单" },
      fields: [
        { id: "f_name", type: "text", label: "姓名" },
        { id: "f_hobby", type: "checkbox", label: "兴趣" },
      ],
    }),
  });
  if (res.status !== 201) {
    throw new Error(`setup publishForm failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { slug?: string };
  if (typeof json.slug !== "string" || json.slug.length === 0) {
    throw new Error(`setup publishForm returned no slug: ${JSON.stringify(json)}`);
  }
  return json.slug;
}

// A representative submission: one text answer + one multi-select answer. The
// `formSlug` is filled per-scenario after publishing a form (see makeSubmission).
const TEXT_ANSWER = { label: "姓名", value: "张三" };
const MULTI_ANSWER = { label: "兴趣", value: ["阅读", "运动"] };

/** A full, valid submission body for `slug`: required formSlug + the answers. */
function makeSubmission(slug: string): { formSlug: string; answers: unknown[] } {
  return { formSlug: slug, answers: [TEXT_ANSWER, MULTI_ANSWER] };
}

describe("submit POST /api/submit (workers/features/submit.feature)", () => {
  let mock: FeishuMock | undefined;

  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    // The submit endpoint is public, but its setup (save config / publish form)
    // hits owner-only endpoints, so we need a session token for those.
    token = await login();
  });

  afterEach(() => {
    mock?.restore();
    mock = undefined;
  });

  it("Scenario: 飞书已配且上游都 OK 时写入成功并返回 recordId", async () => {
    // Given 一个已保存完整飞书凭据的 owner
    await configureOwner({ feishu: true });
    // And 一份已发布的表单（§16.5：submit 需带合法 formSlug 才会走飞书写入）
    const slug = await publishFormAndGetSlug();
    // And 上游飞书 tenant_access_token 接口将返回 code 为 0
    // And 上游飞书多维表格新增记录接口将返回 code 为 0 且带 record id
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: { status: 200, body: BITABLE_OK_BODY },
    });

    // When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    const res = await postSubmit(makeSubmission(slug));

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; recordId?: string };
    // And 响应体的 ok 为真
    expect(body.ok).toBe(true);
    // And 响应体带有上游返回的 recordId
    expect(body.recordId).toBe(UPSTREAM_RECORD_ID);

    // Both upstream stages were hit exactly once, in order.
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.recordCalls).toHaveLength(1);
  });

  it("Scenario: answers 正确映射进飞书 fields", async () => {
    // Given 一个已保存完整飞书凭据的 owner
    await configureOwner({ feishu: true });
    // And 一份已发布的表单（带 slug 提交的前置门，§16.5）
    const slug = await publishFormAndGetSlug();
    // And 两段上游都将返回 code 为 0
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: { status: 200, body: BITABLE_OK_BODY },
    });

    // When 答题者提交含一个文本答案与一个多选答案的作答
    const res = await postSubmit(makeSubmission(slug));
    expect(res.status).toBe(200);

    // The token-exchange request carried the owner's saved app_id/app_secret in
    // its body (proves the creds came from the saved config, not the request).
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.tokenCalls[0].body).toMatchObject({
      app_id: OWNER_FEISHU_APP_ID,
      app_secret: OWNER_FEISHU_APP_SECRET,
    });

    expect(mock.recordCalls).toHaveLength(1);
    const recordCall = mock.recordCalls[0];
    // And 写记录请求打到了 owner 配置的 app token 与 table id 对应的端点
    expect(recordCall.url).toBe(BITABLE_URL);
    // And the tenant_access_token rode the Authorization header (only here, §15.7).
    expect(recordCall.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_TENANT_TOKEN}`);

    const fields = (recordCall.body as { fields?: Record<string, unknown> }).fields;
    expect(fields).toBeTypeOf("object");
    // Then 写记录请求体的 fields 里文本答案以 label 为键、值原样
    expect(fields?.[TEXT_ANSWER.label]).toBe(TEXT_ANSWER.value);
    // And 写记录请求体的 fields 里多选答案以 label 为键、值为原样字符串数组
    expect(fields?.[MULTI_ANSWER.label]).toEqual(MULTI_ANSWER.value);
  });

  it("Scenario: 飞书未配时返回 409 且不打上游", async () => {
    // Given 一个未配置飞书的 owner (DeepSeek only).
    await configureOwner({ feishu: false });
    // And 一份已发布的表单：slug 合法，使 formExists 门通过，让 409「未配飞书」成为
    // 触发原因（而非 404），以隔离测原本的 §15 未配飞书行为（§16.5）。
    const slug = await publishFormAndGetSlug();
    // BOTH upstream replies OMITTED: any Feishu call would THROW, proving the route
    // makes zero outbound calls when Feishu is unconfigured.
    mock = installFeishuMock({});

    // When 答题者带着合法 slug 向 /api/submit 提交一份作答
    const res = await postSubmit(makeSubmission(slug));

    // Then 响应状态码为 409 并提示 owner 未配置飞书
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");
    expect(body.error).toContain("飞书");

    // And 没有向上游飞书发起任何请求
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 空 answers 时返回 400 且不打上游", async () => {
    // Given 一个已保存完整飞书凭据的 owner
    await configureOwner({ feishu: true });
    // And 一份已发布的表单：formSlug 合法，使 400 是「空 answers」所致（隔离原断言）。
    const slug = await publishFormAndGetSlug();
    // Upstream replies OMITTED: a 400 must short-circuit before any Feishu call.
    mock = installFeishuMock({});

    // When 答题者向 /api/submit 提交一份空 answers 的请求（formSlug 合法）
    const res = await postSubmit({ formSlug: slug, answers: [] });

    // Then 响应状态码为 400
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // And 没有向上游飞书发起任何请求
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 缺少 answers 时返回 400 且不打上游", async () => {
    // Given 一个已保存完整飞书凭据的 owner
    await configureOwner({ feishu: true });
    // And 一份已发布的表单：formSlug 合法，使 400 是「缺 answers」所致（隔离原断言）。
    const slug = await publishFormAndGetSlug();
    mock = installFeishuMock({});

    // When 答题者向 /api/submit 提交缺少 answers 的请求（formSlug 合法）
    const res = await postSubmit({ formSlug: slug, foo: "bar" });

    // Then 响应状态码为 400
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // And 没有向上游飞书发起任何请求
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 换 tenant_access_token 失败时返回错误且不泄漏 app secret", async () => {
    // Given 一个已保存完整飞书凭据的 owner
    await configureOwner({ feishu: true });
    // And 一份已发布的表单（带 slug 提交的前置门，§16.5）
    const slug = await publishFormAndGetSlug();
    // And 上游飞书 tenant_access_token 接口将返回非 0 的业务错误码 (HTTP 仍 200！)
    // The add-record reply is OMITTED: reaching stage ② after a failed token
    // exchange would THROW, proving "不再打第二段".
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_BAD_BODY },
    });

    // When 答题者带着合法 slug 向 /api/submit 提交一份作答
    const res = await postSubmit(makeSubmission(slug));

    // Then 代理返回可辨识的错误响应 (4xx/5xx JSON error — not a 2xx success).
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const raw = await res.clone().text();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // The token endpoint was actually probed (failure is upstream's verdict, not
    // the route refusing to call).
    expect(mock.tokenCalls).toHaveLength(1);

    // And 错误响应里不包含 owner 的明文飞书 app secret
    expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);

    // And 没有向上游飞书多维表格新增记录接口发起请求
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 写记录上游报错时返回错误且不泄漏 token", async () => {
    // Given 一个已保存完整飞书凭据的 owner
    await configureOwner({ feishu: true });
    // And 一份已发布的表单（带 slug 提交的前置门，§16.5）
    const slug = await publishFormAndGetSlug();
    // And 上游飞书 tenant_access_token 接口将返回 code 为 0
    // And 上游飞书多维表格新增记录接口将返回非 0 的业务错误码
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: { status: 200, body: BITABLE_BAD_BODY },
    });

    // When 答题者带着合法 slug 向 /api/submit 提交一份作答
    const res = await postSubmit(makeSubmission(slug));

    // Then 代理返回可辨识的错误响应
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const raw = await res.clone().text();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // Both stages were attempted (token OK, then write failed upstream).
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.recordCalls).toHaveLength(1);

    // And 错误响应里不包含换取到的 tenant_access_token
    expect(raw).not.toContain(UPSTREAM_TENANT_TOKEN);
    // And 错误响应里不包含 owner 的明文飞书 app secret
    expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);
  });

  it("Scenario: 整个响应里不含任何明文凭据", async () => {
    // Given 一个已保存完整飞书凭据的 owner
    await configureOwner({ feishu: true });
    // And 一份已发布的表单（带 slug 提交的前置门，§16.5）
    const slug = await publishFormAndGetSlug();
    // And 两段上游都将返回 code 为 0 (the success path still must not echo creds).
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: { status: 200, body: BITABLE_OK_BODY },
    });

    // When 答题者带着合法 slug 向 /api/submit 提交一份作答
    const res = await postSubmit(makeSubmission(slug));

    // The route must actually serve the submit (200) — guards this leakage scan
    // from passing vacuously against a 404 with an empty body before the route exists.
    expect(res.status).toBe(200);

    // Scan the ENTIRE raw response (body + every header) for plaintext credentials.
    const raw = await res.clone().text();
    // Then 整个响应里不包含 owner 的明文飞书 app secret
    expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);
    // And 整个响应里不包含换取到的 tenant_access_token
    expect(raw).not.toContain(UPSTREAM_TENANT_TOKEN);

    // Headers must not echo credentials either (SPEC §15.7).
    for (const [, value] of res.headers) {
      expect(value).not.toContain(OWNER_FEISHU_APP_SECRET);
      expect(value).not.toContain(UPSTREAM_TENANT_TOKEN);
    }
  });
});
