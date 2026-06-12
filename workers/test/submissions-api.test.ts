import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { applySchema, resetConfig, resetForms, login, authHeader } from "./helpers";
import { FEISHU_BITABLE_RECORDS_URL, FEISHU_BITABLE_FIELDS_URL } from "../src/submit";
import { FEISHU_TENANT_TOKEN_URL } from "../src/feishu";

// Outer-loop acceptance specs for the data backend `GET /api/forms/:slug/submissions`,
// driven through the real Hono app in workerd via SELF.fetch, with BOTH Feishu
// upstreams (the tenant_access_token exchange + the Bitable RECORD-LIST read) mocked
// locally — never hits open.feishu.cn (see installFeishuMock). Realizes every
// scenario of workers/features/submissions.feature:
//   1. 无鉴权访问 → 401，不打上游
//   2. 列出提交并返回 count（两条记录）
//   3. 空表 → []，count 0
//   4. 读记录请求打到配置的 app_token/table_id，并带 Bearer tenant_access_token
//   5. 不存在 slug → 404，不打上游
//   6. owner 未配飞书 → 409，不打上游
//   7. 换 token 失败 → 502，不泄漏 app_secret，不打记录读取
//   8. 读记录上游报错 → 502，不泄漏 token / app_secret
//   9. 整个响应不含 app_secret / tenant_access_token / app_token / table_id
//
// The submissions read REUSES the same bitable URL template as the §15 write, so
// the two are distinguished by METHOD: write is POST, read is GET (§18.3). The mock
// dispatches the bitable URL on method to keep them apart.
//
// Contract: SPEC.md §18 (后端 · 数据后台 · 提交列表).

const BASE = "https://api.local";

// Concrete owner credential fixtures — distinctive + long so any leak into the
// response (body / message / header) is caught by a substring scan (§18.6).
const OWNER_DEEPSEEK_KEY = "sk-owner-DEEPSEEK-secret-0123456789abcdef";
const OWNER_FEISHU_APP_ID = "cli_fixtureAppId9999";
const OWNER_FEISHU_APP_SECRET = "feishu-APP-SECRET-qrstuvwxyz-7777-SHHH";
const OWNER_FEISHU_APP_TOKEN = "bascnFixtureAppTokenXYZ";
const OWNER_FEISHU_TABLE_ID = "tblFixture123";

// The token the mocked exchange hands back; it must ONLY ever ride the read
// request's Authorization header — never any /submissions response (§18.6).
const UPSTREAM_TENANT_TOKEN = "t-xxxxxxxxxxxxxxxx-SECRET-9999";

// The exact record-list URL the route must hit: template with the owner's
// app_token / table_id filled in (§18.3 — same template as the §15 write).
const RECORDS_URL = FEISHU_BITABLE_RECORDS_URL.replace(
  "{app_token}",
  OWNER_FEISHU_APP_TOKEN,
).replace("{table_id}", OWNER_FEISHU_TABLE_ID);

// The fields endpoint — NOT used by the submissions read itself, but the publish
// SETUP (POST /api/forms with Feishu configured) fans out a best-effort 预建 in
// waitUntil (§16.8) that lists + creates columns here. The mock absorbs that fan-out
// so it doesn't default-deny THROW; the test drains it before asserting on the read.
const FIELDS_URL = FEISHU_BITABLE_FIELDS_URL.replace("{app_token}", OWNER_FEISHU_APP_TOKEN).replace(
  "{table_id}",
  OWNER_FEISHU_TABLE_ID,
);
function pathKey(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}
const FIELDS_PATH = pathKey(FIELDS_URL);
const FIELDS_LIST_BODY = JSON.stringify({ code: 0, msg: "success", data: { items: [] } });
const FIELD_CREATE_OK_BODY = JSON.stringify({ code: 0, msg: "success" });

const FEISHU_TOKEN_OK_BODY = JSON.stringify({
  code: 0,
  msg: "ok",
  tenant_access_token: UPSTREAM_TENANT_TOKEN,
  expire: 7200,
});
const FEISHU_TOKEN_BAD_BODY = JSON.stringify({ code: 99991663, msg: "app ticket invalid" });

// Two upstream records mapped from data.items[] → { recordId, fields, createdTime? }.
const REC_1_ID = "recAAAAAAAA0001";
const REC_2_ID = "recBBBBBBBB0002";
const RECORDS_TWO_BODY = JSON.stringify({
  code: 0,
  msg: "success",
  data: {
    total: 2,
    items: [
      {
        record_id: REC_1_ID,
        created_time: 1700000000000,
        fields: { 姓名: "张三", 兴趣: ["阅读", "运动"] },
      },
      {
        record_id: REC_2_ID,
        created_time: 1700000111111,
        fields: { 姓名: "李四", 兴趣: ["编程"] },
      },
    ],
  },
});
const RECORDS_EMPTY_BODY = JSON.stringify({
  code: 0,
  msg: "success",
  data: { total: 0, items: [] },
});
const RECORDS_BAD_BODY = JSON.stringify({ code: 1254005, msg: "TableNotFound" });

// --- Two-stage Feishu fetch mock (default-deny; bitable dispatched on METHOD) --
//
// The submissions flow fans out IN ORDER: exchange app_id/app_secret for a
// tenant_access_token (token stage), then GET the record list (records stage).
// We dispatch on the exact upstream URL, and — because the bitable read REUSES the
// §15 write URL — additionally on METHOD for that URL (GET = read; anything else
// would be a violation). Any unmatched URL/method THROWS:
//   - omit `token` ⇒ the route must NOT exchange a token (e.g. 401/404/409) — a
//     call records a violation as a hard failure.
//   - omit `records` ⇒ the route must NOT reach the read (e.g. token exchange
//     failed) — proving "不打记录读取".

interface UpstreamReply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface FeishuMockOpts {
  /** Reply for the tenant_access_token exchange. Omit ⇒ must NOT be called. */
  token?: UpstreamReply;
  /** Reply for the Bitable GET record-list read. Omit ⇒ must NOT be called. */
  records?: UpstreamReply;
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  bodyText: string;
  body: unknown;
}

interface FeishuMock {
  /** tenant_access_token exchange calls, in order. */
  readonly tokenCalls: CapturedCall[];
  /** Bitable record-list GET calls, in order. */
  readonly recordCalls: CapturedCall[];
  /** list-fields (GET) calls — only the publish-setup pre-create touches these. */
  readonly fieldsListCalls: CapturedCall[];
  /** create-field (POST) calls — only the publish-setup pre-create touches these. */
  readonly fieldCreateCalls: CapturedCall[];
  /** Empty every captured-call array (discards the publish background fan-out). */
  resetCalls(): void;
  restore(): void;
}

function installFeishuMock(opts: FeishuMockOpts): FeishuMock {
  const tokenCalls: CapturedCall[] = [];
  const recordCalls: CapturedCall[] = [];
  const fieldsListCalls: CapturedCall[] = [];
  const fieldCreateCalls: CapturedCall[] = [];

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
    if (req.url === RECORDS_URL) {
      // The read REUSES the write URL — only a GET is a legitimate record-list read.
      if (req.method !== "GET") {
        throw new Error(`unexpected ${req.method} to ${req.url} (record list read must be GET)`);
      }
      if (!opts.records) {
        throw new Error(`unexpected record-list upstream call to ${req.url} (no reply configured)`);
      }
      recordCalls.push(captured);
      return new Response(opts.records.body, {
        status: opts.records.status,
        headers: opts.records.headers ?? { "content-type": "application/json" },
      });
    }
    // The publish-setup best-effort 预建 (§16.8) lists + creates columns here. The
    // submissions read never touches this endpoint — these calls only ever come from
    // the background fan-out, which the test drains + resets away before asserting.
    if (pathKey(req.url) === FIELDS_PATH) {
      if (req.method === "GET") {
        fieldsListCalls.push(captured);
        return new Response(FIELDS_LIST_BODY, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (req.method === "POST") {
        fieldCreateCalls.push(captured);
        return new Response(FIELD_CREATE_OK_BODY, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected method ${req.method} on fields endpoint ${req.url}`);
    }
    // Default-deny: only the configured Feishu upstreams are allowed.
    throw new Error(
      `unexpected outbound fetch to ${req.url} (only the Feishu token + ${RECORDS_URL} GET + fields are mocked)`,
    );
  };

  globalThis.fetch = stub as typeof fetch;
  return {
    tokenCalls,
    recordCalls,
    fieldsListCalls,
    fieldCreateCalls,
    resetCalls: () => {
      tokenCalls.length = 0;
      recordCalls.length = 0;
      fieldsListCalls.length = 0;
      fieldCreateCalls.length = 0;
    },
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

/**
 * Drain the publish-setup background `preCreateBitableColumnsBestEffort` (§16.8) —
 * wait for its token exchange to land, then settle so any list/create follow-ups also
 * land, so the caller can `resetCalls()` and assert on the submissions read alone.
 */
async function drainBackgroundPreCreate(mock: FeishuMock): Promise<void> {
  const deadline = Date.now() + 800;
  while (mock.tokenCalls.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 25));
}

/**
 * Seed D1 with the owner config via the real POST /api/config (owner-only —
 * needs a token). Secrets are encrypted at rest; the submissions route reads back
 * THIS config (credentials never come from the request).
 */
async function configureOwner(token: string, opts: { feishu: boolean }): Promise<void> {
  const body: Record<string, unknown> = {
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
  const res = await SELF.fetch(`${BASE}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new Error(`setup configureOwner failed: ${res.status} ${await res.text()}`);
  }
}

/** Publish a form (owner-only) and return its slug. */
async function publishFormAndGetSlug(token: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({
      meta: { title: "数据后台测试表单" },
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

/** GET the submissions list for a slug, with optional headers (token / none). */
function getSubmissions(slug: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/api/forms/${slug}/submissions`, { headers });
}

interface SubmissionsBody {
  submissions?: Array<{
    recordId?: string;
    fields?: Record<string, unknown>;
    createdTime?: number;
  }>;
  count?: number;
}

describe("submissions GET /api/forms/:slug/submissions (workers/features/submissions.feature)", () => {
  let mock: FeishuMock | undefined;

  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
  });

  afterEach(() => {
    mock?.restore();
    mock = undefined;
  });

  it("Scenario: 无鉴权访问数据后台返回 401", async () => {
    // Given 一份已发布的表单 (publish needs a token; the submissions read is owner-only)
    const token = await login();
    await configureOwner(token, { feishu: true });
    const slug = await publishFormAndGetSlug(token);
    // BOTH upstream replies OMITTED: any Feishu call would THROW, proving the 401
    // short-circuits at the auth gate before any upstream is touched (§18.5).
    mock = installFeishuMock({});

    // When 未鉴权地请求该表单的提交列表 (no Authorization header)
    const res = await getSubmissions(slug);

    // Then 响应状态码为 401
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // And 没有向上游飞书发起任何请求
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 列出提交并返回 count", async () => {
    // Given 一个已登录的 owner + 已保存完整飞书凭据 + 一份已发布的表单
    const token = await login();
    await configureOwner(token, { feishu: true });
    // And 上游 token 接口 code 0；记录列表接口 code 0 且带两条记录。先装 mock 再发布，
    // drain 掉发布预建后台扇出（§16.8），使下面的 token/record 计数只反映这次读取。
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      records: { status: 200, body: RECORDS_TWO_BODY },
    });
    const slug = await publishFormAndGetSlug(token);
    await drainBackgroundPreCreate(mock);
    mock.resetCalls();

    // When owner 带有效 token 请求该表单的提交列表
    const res = await getSubmissions(slug, authHeader(token));

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    const body = (await res.json()) as SubmissionsBody;

    // And 响应体的 submissions 含两条提交
    expect(body.submissions).toHaveLength(2);
    // And 每条提交带有 recordId 与 fields
    for (const sub of body.submissions!) {
      expect(sub.recordId).toBeTypeOf("string");
      expect(sub.fields).toBeTypeOf("object");
    }
    expect(body.submissions![0].recordId).toBe(REC_1_ID);
    expect(body.submissions![0].fields).toEqual({ 姓名: "张三", 兴趣: ["阅读", "运动"] });
    expect(body.submissions![1].recordId).toBe(REC_2_ID);

    // And 响应体的 count 为 2
    expect(body.count).toBe(2);

    // Both upstream stages were hit exactly once, in order.
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.recordCalls).toHaveLength(1);
  });

  it("Scenario: 空表时返回空列表且 count 为 0", async () => {
    // Given 一个已登录的 owner + 已配飞书 + 已发布表单
    const token = await login();
    await configureOwner(token, { feishu: true });
    // And token code 0；记录列表 code 0 且无任何记录。装 mock → 发布 → drain → reset。
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      records: { status: 200, body: RECORDS_EMPTY_BODY },
    });
    const slug = await publishFormAndGetSlug(token);
    await drainBackgroundPreCreate(mock);
    mock.resetCalls();

    // When owner 带有效 token 请求该表单的提交列表
    const res = await getSubmissions(slug, authHeader(token));

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    const body = (await res.json()) as SubmissionsBody;
    // And 响应体的 submissions 为空数组（正常态，非错误）
    expect(body.submissions).toEqual([]);
    // And 响应体的 count 为 0
    expect(body.count).toBe(0);

    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.recordCalls).toHaveLength(1);
  });

  it("Scenario: 读记录请求打到 owner 配置的 app token 与 table id 对应端点", async () => {
    // Given 一个已登录的 owner + 已配飞书 + 已发布表单
    const token = await login();
    await configureOwner(token, { feishu: true });
    // And token code 0；记录列表 code 0 且带两条记录。装 mock → 发布 → drain → reset。
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      records: { status: 200, body: RECORDS_TWO_BODY },
    });
    const slug = await publishFormAndGetSlug(token);
    await drainBackgroundPreCreate(mock);
    mock.resetCalls();

    // When owner 带有效 token 请求该表单的提交列表
    const res = await getSubmissions(slug, authHeader(token));
    expect(res.status).toBe(200);

    // The token-exchange carried the owner's SAVED app_id/app_secret (proves creds
    // came from config, not the request).
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.tokenCalls[0].body).toMatchObject({
      app_id: OWNER_FEISHU_APP_ID,
      app_secret: OWNER_FEISHU_APP_SECRET,
    });

    expect(mock.recordCalls).toHaveLength(1);
    const recordCall = mock.recordCalls[0];
    // Then 读记录请求打到了 owner 配置的 app token 与 table id 对应的端点
    expect(recordCall.url).toBe(RECORDS_URL);
    // It is a GET (the read variant of the shared write URL, §18.3).
    expect(recordCall.method).toBe("GET");
    // And 读记录请求带有换取到的 tenant_access_token 作为 Bearer 凭据
    expect(recordCall.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_TENANT_TOKEN}`);
  });

  it("Scenario: 拉取不存在的 slug 返回 404 且不打飞书上游", async () => {
    // Given 一个已登录的 owner + 已配飞书 + 一个从未发布过的 slug
    const token = await login();
    await configureOwner(token, { feishu: true });
    // BOTH upstream replies OMITTED: the 404 must short-circuit before any Feishu call.
    mock = installFeishuMock({});

    // When owner 带有效 token 请求该不存在 slug 的提交列表
    const res = await getSubmissions("nonexistent-slug-zzz", authHeader(token));

    // Then 响应状态码为 404
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // And 没有向上游飞书发起任何请求
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: owner 未配飞书时返回 409 且不打上游", async () => {
    // Given 一个已登录的 owner + 未配置飞书的 owner (DeepSeek only) + 已发布表单
    const token = await login();
    await configureOwner(token, { feishu: false });
    const slug = await publishFormAndGetSlug(token);
    // Upstream replies OMITTED: the 409 must short-circuit before any Feishu call.
    mock = installFeishuMock({});

    // When owner 带有效 token 请求该表单的提交列表
    const res = await getSubmissions(slug, authHeader(token));

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

  it("Scenario: 换 tenant_access_token 失败时返回错误且不泄漏 app secret", async () => {
    // Given 一个已登录的 owner + 已配飞书 + 已发布表单
    const token = await login();
    await configureOwner(token, { feishu: true });
    // And token 接口返回非 0 业务错误码 (HTTP 仍 200!). The records reply is OMITTED:
    // reaching the read after a failed token exchange would THROW (proving 不打记录读取).
    // 装 mock → 发布（其后台预建的 token 换取同样失败、被静默吞）→ drain → reset。
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_BAD_BODY },
    });
    const slug = await publishFormAndGetSlug(token);
    await drainBackgroundPreCreate(mock);
    mock.resetCalls();

    // When owner 带有效 token 请求该表单的提交列表
    const res = await getSubmissions(slug, authHeader(token));

    // Then 代理返回可辨识的错误响应 (4xx/5xx JSON error — not a 2xx success)
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const raw = await res.clone().text();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // The token endpoint was actually probed (failure is upstream's verdict).
    expect(mock.tokenCalls).toHaveLength(1);
    // And 错误响应里不包含 owner 的明文飞书 app secret
    expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);
    // And 没有向上游飞书多维表格记录列表接口发起请求
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 读记录上游报错时返回错误且不泄漏 token", async () => {
    // Given 一个已登录的 owner + 已配飞书 + 已发布表单
    const token = await login();
    await configureOwner(token, { feishu: true });
    // And token code 0；记录列表接口返回非 0 业务错误码。装 mock → 发布 → drain → reset。
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      records: { status: 200, body: RECORDS_BAD_BODY },
    });
    const slug = await publishFormAndGetSlug(token);
    await drainBackgroundPreCreate(mock);
    mock.resetCalls();

    // When owner 带有效 token 请求该表单的提交列表
    const res = await getSubmissions(slug, authHeader(token));

    // Then 代理返回可辨识的错误响应
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const raw = await res.clone().text();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // Both stages were attempted (token OK, then read failed upstream).
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.recordCalls).toHaveLength(1);

    // And 错误响应里不包含换取到的 tenant_access_token
    expect(raw).not.toContain(UPSTREAM_TENANT_TOKEN);
    // And 错误响应里不包含 owner 的明文飞书 app secret
    expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);
  });

  it("Scenario: 整个响应里不含任何明文凭据", async () => {
    // Given 一个已登录的 owner + 已配飞书 + 已发布表单 + 两段上游都 code 0 (success path
    // is the one that returns the most data — still must not echo creds).
    const token = await login();
    await configureOwner(token, { feishu: true });
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      records: { status: 200, body: RECORDS_TWO_BODY },
    });
    const slug = await publishFormAndGetSlug(token);
    await drainBackgroundPreCreate(mock);
    mock.resetCalls();

    // When owner 带有效 token 请求该表单的提交列表
    const res = await getSubmissions(slug, authHeader(token));
    // The route must actually serve the list (200) so this scan isn't vacuous.
    expect(res.status).toBe(200);

    // Scan the ENTIRE raw response (body + every header) for any plaintext credential
    // or "where the data lives" identifier (§18.6).
    const raw = await res.clone().text();
    // Then 整个响应里不包含 owner 的明文飞书 app secret
    expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);
    // And 整个响应里不包含换取到的 tenant_access_token
    expect(raw).not.toContain(UPSTREAM_TENANT_TOKEN);
    // And 整个响应里不包含 owner 配置的飞书 app token 与 table id
    expect(raw).not.toContain(OWNER_FEISHU_APP_TOKEN);
    expect(raw).not.toContain(OWNER_FEISHU_TABLE_ID);
    // Defense in depth: the DeepSeek key must not leak either, and no owner_id.
    expect(raw).not.toContain(OWNER_DEEPSEEK_KEY);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("owner_id");

    // Headers must not echo credentials either.
    for (const [, value] of res.headers) {
      expect(value).not.toContain(OWNER_FEISHU_APP_SECRET);
      expect(value).not.toContain(UPSTREAM_TENANT_TOKEN);
      expect(value).not.toContain(OWNER_FEISHU_APP_TOKEN);
      expect(value).not.toContain(OWNER_FEISHU_TABLE_ID);
    }
  });
});
