import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { applySchema, resetConfig, resetForms, testEnv, login, authHeader } from "./helpers";
import { FEISHU_BITABLE_RECORDS_URL, FEISHU_BITABLE_FIELDS_URL } from "../src/submit";
import { FEISHU_TENANT_TOKEN_URL } from "../src/feishu";

// Auth split (SPEC.md §17.1): POST /api/forms (publish) and the POST /api/config
// setup are owner-only → they carry `Authorization: Bearer <jwt>` from login().
// The PUBLIC reads/writes stay UNAUTHENTICATED and unchanged: GET /api/forms/:slug
// (public form fetch) and POST /api/submit (answerer submit) send NO token —
// proving the shared /api/forms prefix does not drag the public read behind auth.

// Outer-loop acceptance specs for 表单发布 + 公开填写拉取, driven through the real
// Hono app in workerd via SELF.fetch against a local miniflare D1. Realizes every
// scenario of workers/features/form-publish.feature:
//   1. POST /api/forms → 201 { slug } 且 forms 表落库
//   2. GET /api/forms/:slug → 200 PublicForm (meta + fields 与发布时一致)
//   3. GET /api/forms/:slug 响应不含任何 owner 凭据 / owner_id
//   4. GET /api/forms/:slug 不存在 → 404
//   5. submit 带合法 slug → 200 走飞书写入 (mock 两段)
//   6. submit 带不存在 slug → 404 且不打飞书上游
//   7. submit 缺 formSlug → 400 且不打飞书上游
//   8. 发布缺 meta 标题 → 400 且不落库
//   9. 发布 fields 为空数组 → 201，公开拉取 fields 为空数组
//
// Contract: SPEC.md §16.

const BASE = "https://api.local";

/** Decode a JWT's `sub` claim (no verification — just read the payload's owner id). */
function decodeJwtSub(token: string): string {
  const payload = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      ),
    ),
  ) as { sub?: string };
  return payload.sub ?? "";
}

// Concrete owner credential fixtures — distinctive + long so that, were any to
// ever leak into the PUBLIC form-fetch response, a substring scan catches it
// unmistakably. These are written into D1 via POST /api/config (encrypted at
// rest); the public GET /api/forms/:slug must never re-surface them.
const OWNER_DEEPSEEK_KEY = "sk-owner-DEEPSEEK-secret-0123456789abcdef";
const OWNER_FEISHU_APP_ID = "cli_fixtureAppId9999";
const OWNER_FEISHU_APP_SECRET = "feishu-APP-SECRET-qrstuvwxyz-7777-SHHH";
const OWNER_FEISHU_APP_TOKEN = "bascnFixtureAppTokenXYZ";
const OWNER_FEISHU_TABLE_ID = "tblFixture123";

// Stage-① token + the recordId stage-② hands back for the submit-with-slug path.
const UPSTREAM_TENANT_TOKEN = "t-xxxxxxxxxxxxxxxx-SECRET-9999";
const UPSTREAM_RECORD_ID = "rec-xxxxxxxxxxxxxx";

// The exact add-record URL the submit route must hit (template with the owner's
// app_token / table_id filled in, SPEC.md §15.5).
const BITABLE_URL = FEISHU_BITABLE_RECORDS_URL.replace(
  "{app_token}",
  OWNER_FEISHU_APP_TOKEN,
).replace("{table_id}", OWNER_FEISHU_TABLE_ID);

// The fields endpoint — the publish 预建 (§16.8) + the submit's steady-state
// listBitableColumns (§15.8 升级) both hit it. The mock absorbs both; the submit
// scenario drains the publish fan-out before asserting on the write.
const BITABLE_FIELDS_URL = FEISHU_BITABLE_FIELDS_URL.replace(
  "{app_token}",
  OWNER_FEISHU_APP_TOKEN,
).replace("{table_id}", OWNER_FEISHU_TABLE_ID);
function pathKey(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}
const BITABLE_FIELDS_PATH = pathKey(BITABLE_FIELDS_URL);

const FEISHU_TOKEN_OK_BODY = JSON.stringify({
  code: 0,
  msg: "ok",
  tenant_access_token: UPSTREAM_TENANT_TOKEN,
  expire: 7200,
});
const BITABLE_OK_BODY = JSON.stringify({
  code: 0,
  msg: "success",
  data: { record: { record_id: UPSTREAM_RECORD_ID } },
});
// List-fields reply: the submitted labels (姓名 text / 兴趣 multi-select) already
// exist as columns, so the steady-state submit writes by real type — no self-heal.
const FIELDS_LIST_BODY = JSON.stringify({
  code: 0,
  msg: "success",
  data: {
    items: [
      { field_name: "姓名", type: 1 },
      { field_name: "兴趣", type: 4 },
    ],
  },
});
const FIELD_CREATE_OK_BODY = JSON.stringify({ code: 0, msg: "success" });

// A representative published form: meta + a text field and a checkbox field with
// options (§16.2 example shape). Reused as the publish body and as the expected
// projection on public fetch.
const FORM_META = { title: "活动报名表", description: "请填写你的报名信息" };
const FORM_FIELDS = [
  { id: "f_name", type: "text", label: "姓名", required: true },
  {
    id: "f_hobby",
    type: "checkbox",
    label: "兴趣",
    options: [
      { label: "阅读", value: "read" },
      { label: "运动", value: "sport" },
    ],
  },
];
const PUBLISH_BODY = { meta: FORM_META, fields: FORM_FIELDS };

// --- Two-stage Feishu fetch mock (default-deny, ordered) ----------------------
//
// Mirrors submit-api.test.ts: the submit flow first exchanges app_id/app_secret
// for a tenant_access_token (stage ①), then writes one record (stage ②). We
// dispatch on the exact upstream URL; any unmatched URL THROWS. Omitting a stage
// makes a call to it throw — load-bearing for the "不打飞书上游" assertions: when
// submit must reject (bad / missing slug) BEFORE touching Feishu, we configure
// NEITHER stage and assert per-stage call counts are 0.

interface UpstreamReply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface FeishuMockOpts {
  token?: UpstreamReply;
  record?: UpstreamReply;
  /** list-fields GET reply (§15.8 升级 + §16.8 预建). Defaults to FIELDS_LIST_BODY. */
  fieldsList?: UpstreamReply | null;
  fieldCreate?: UpstreamReply;
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  bodyText: string;
  body: unknown;
}

interface FeishuMock {
  readonly tokenCalls: CapturedCall[];
  readonly recordCalls: CapturedCall[];
  readonly fieldsListCalls: CapturedCall[];
  readonly fieldCreateCalls: CapturedCall[];
  resetCalls(): void;
  restore(): void;
}

function installFeishuMock(opts: FeishuMockOpts): FeishuMock {
  const tokenCalls: CapturedCall[] = [];
  const recordCalls: CapturedCall[] = [];
  const fieldsListCalls: CapturedCall[] = [];
  const fieldCreateCalls: CapturedCall[] = [];
  const fieldsListReply: UpstreamReply | null =
    opts.fieldsList === undefined ? { status: 200, body: FIELDS_LIST_BODY } : opts.fieldsList;
  const fieldCreateReply: UpstreamReply = opts.fieldCreate ?? {
    status: 200,
    body: FIELD_CREATE_OK_BODY,
  };

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
    if (pathKey(req.url) === BITABLE_FIELDS_PATH) {
      if (req.method === "GET") {
        if (!fieldsListReply) {
          throw new Error(`unexpected list-fields upstream call to ${req.url} (forbidden)`);
        }
        fieldsListCalls.push(captured);
        return new Response(fieldsListReply.body, {
          status: fieldsListReply.status,
          headers: fieldsListReply.headers ?? { "content-type": "application/json" },
        });
      }
      if (req.method === "POST") {
        fieldCreateCalls.push(captured);
        return new Response(fieldCreateReply.body, {
          status: fieldCreateReply.status,
          headers: fieldCreateReply.headers ?? { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected method ${req.method} on fields endpoint ${req.url}`);
    }
    throw new Error(
      `unexpected outbound fetch to ${req.url} (only the Feishu token + records + fields are mocked)`,
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
 * Drain the publish-triggered background `preCreateBitableColumnsBestEffort` (§16.8)
 * — wait for its token exchange to land, then settle, so the caller can `resetCalls()`
 * and assert on the submit traffic alone.
 */
async function drainBackgroundPreCreate(mock: FeishuMock): Promise<void> {
  const deadline = Date.now() + 800;
  while (mock.tokenCalls.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 25));
}

/**
 * Seed D1 with the owner config via the real, already-implemented POST /api/config
 * (secrets encrypted at rest). Used by the leak-scan + submit scenarios so there
 * ARE credentials in D1 that the public form fetch could (must not) surface.
 */
// Owner-only setup (§17.1): POST /api/config + POST /api/forms attach the token.
let token: string;

async function configureOwner(opts: { feishu: boolean }): Promise<void> {
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

// POST /api/forms is owner-only (§17.1) → carries the token.
function postForm(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
}

// GET /api/forms/:slug is PUBLIC (§17.1) → intentionally NO Authorization header.
function getForm(slug: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/forms/${slug}`);
}

// POST /api/submit is PUBLIC (§17.1) → intentionally NO Authorization header.
function postSubmit(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Publish PUBLISH_BODY (or a given body) and return the resulting slug. */
async function publishAndGetSlug(body: unknown = PUBLISH_BODY): Promise<string> {
  const res = await postForm(body);
  if (res.status !== 201) {
    throw new Error(`setup publish failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { slug?: string };
  if (typeof json.slug !== "string" || json.slug.length === 0) {
    throw new Error(`setup publish returned no slug: ${JSON.stringify(json)}`);
  }
  return json.slug;
}

/** Count rows in the forms table (asserts落库 / 不落库). */
async function formsRowCount(): Promise<number> {
  const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM forms").first<{ n: number }>();
  return row?.n ?? 0;
}

const SUBMISSION_ANSWERS = [
  { label: "姓名", value: "张三" },
  { label: "兴趣", value: ["阅读", "运动"] },
];

describe("forms POST /api/forms + GET /api/forms/:slug (workers/features/form-publish.feature)", () => {
  let mock: FeishuMock | undefined;

  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    // owner-only setup (POST /api/config + POST /api/forms) needs a token. The
    // public reads (getForm / postSubmit) deliberately don't use it.
    token = await login();
  });

  afterEach(() => {
    mock?.restore();
    mock = undefined;
  });

  it("Scenario: 发布表单得到 slug 并落库", async () => {
    // Given 一份含 meta 与若干字段的合法表单定义
    // When owner 向 /api/forms 发布该表单
    const res = await postForm(PUBLISH_BODY);

    // Then 响应状态码为 201
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { slug?: string };
    // And 响应体带有一个非空的 slug
    expect(body.slug).toBeTypeOf("string");
    expect(body.slug && body.slug.length).toBeGreaterThan(0);

    // And 该 slug 对应的表单已存入 forms 表
    const row = await testEnv.DB.prepare(
      "SELECT slug, owner_id, meta_json, schema_json FROM forms WHERE slug = ?",
    )
      .bind(body.slug)
      .first<{ slug: string; owner_id: string; meta_json: string; schema_json: string }>();
    expect(row).not.toBeNull();
    expect(row?.slug).toBe(body.slug);
    // 多用户改造后 owner_id 是发布它的 owner 的真实 user id（session.sub，§17.9 第 1 条），
    // 不再恒填 'default'：它应是发布所用 token 的 sub（一个非空 UUID）。
    expect(row?.owner_id).toBe(decodeJwtSub(token));
    expect(row?.owner_id).not.toBe("default");
    expect(row?.owner_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(JSON.parse(row!.meta_json)).toMatchObject({ title: FORM_META.title });
    expect(JSON.parse(row!.schema_json)).toHaveLength(FORM_FIELDS.length);
  });

  it("Scenario: 公开拉取返回表单的 meta 与 fields", async () => {
    // Given 一份已发布的表单
    const slug = await publishAndGetSlug();

    // When 答题者无鉴权地拉取该 slug 对应的表单
    const res = await getForm(slug);

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      slug?: string;
      meta?: typeof FORM_META;
      fields?: typeof FORM_FIELDS;
    };
    expect(body.slug).toBe(slug);
    // And 响应体的 meta 与发布时一致
    expect(body.meta).toEqual(FORM_META);
    // And 响应体的 fields 与发布时一致
    expect(body.fields).toEqual(FORM_FIELDS);
  });

  it("Scenario: 公开拉取的响应不含任何 owner 凭据", async () => {
    // Given owner 已在集成配置里保存了 DeepSeek key 与完整飞书凭据
    await configureOwner({ feishu: true });
    // And 一份已发布的表单
    const slug = await publishAndGetSlug();

    // When 答题者无鉴权地拉取该 slug 对应的表单
    const res = await getForm(slug);
    expect(res.status).toBe(200);

    // Scan the ENTIRE raw response (body + every header) for any plaintext
    // credential the owner saved. The public form fetch reads only `forms`, never
    // owner_config, so none of these may ever appear (§16.4).
    const raw = await res.clone().text();
    // Then 整个响应里不包含 owner 的明文 DeepSeek key
    expect(raw).not.toContain(OWNER_DEEPSEEK_KEY);
    // And 整个响应里不包含 owner 的明文飞书 app secret
    expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);
    // And 整个响应里不包含 owner 的飞书 app token 与 table id
    expect(raw).not.toContain(OWNER_FEISHU_APP_TOKEN);
    expect(raw).not.toContain(OWNER_FEISHU_TABLE_ID);

    // And 整个响应里不包含 owner_id 字段 (key absent from the projected JSON, §16.4).
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("owner_id");
    expect(Object.keys(body)).not.toContain("status");
    expect(Object.keys(body)).not.toContain("created_at");

    // Headers must not echo credentials either.
    for (const [, value] of res.headers) {
      expect(value).not.toContain(OWNER_DEEPSEEK_KEY);
      expect(value).not.toContain(OWNER_FEISHU_APP_SECRET);
      expect(value).not.toContain(OWNER_FEISHU_APP_TOKEN);
    }
  });

  it("Scenario: 拉取不存在的 slug 返回 404", async () => {
    // Given 一个从未发布过的 slug
    // When 答题者无鉴权地拉取该 slug 对应的表单
    const res = await getForm("nonexistent-slug-zzz");

    // Then 响应状态码为 404
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");
  });

  it("Scenario: submit 带合法 slug 时正常走飞书写入", async () => {
    // Given 一个已保存完整飞书凭据的 owner
    await configureOwner({ feishu: true });
    // And 上游飞书两段都将返回 code 为 0。先装 mock 再发布，drain 掉发布预建后台扇出（§16.8）。
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: { status: 200, body: BITABLE_OK_BODY },
    });
    // And 一份已发布的表单
    const slug = await publishAndGetSlug();
    await drainBackgroundPreCreate(mock);
    mock.resetCalls();

    // When 答题者带着该表单的 slug 向 /api/submit 提交一份作答
    const res = await postSubmit({ formSlug: slug, answers: SUBMISSION_ANSWERS });

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; recordId?: string };
    // And 响应体的 ok 为真
    expect(body.ok).toBe(true);
    expect(body.recordId).toBe(UPSTREAM_RECORD_ID);

    // And 写记录请求打到了 owner 配置的 app token 与 table id 对应的端点
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.recordCalls).toHaveLength(1);
    expect(mock.recordCalls[0].url).toBe(BITABLE_URL);
  });

  it("Scenario: submit 带不存在的 slug 返回 404 且不打飞书上游", async () => {
    // Given 一个已保存完整飞书凭据的 owner
    await configureOwner({ feishu: true });
    // And 一个从未发布过的 slug
    // BOTH upstream replies OMITTED: any Feishu call would THROW, proving the route
    // rejects the unknown slug BEFORE exchanging a token / writing a record (§16.5).
    mock = installFeishuMock({});

    // When 答题者带着该不存在的 slug 向 /api/submit 提交一份作答
    const res = await postSubmit({ formSlug: "nonexistent-slug-zzz", answers: SUBMISSION_ANSWERS });

    // Then 响应状态码为 404
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // And 没有向上游飞书发起任何请求
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: submit 缺少 formSlug 时返回 400 且不打飞书上游", async () => {
    // Given 一个已保存完整飞书凭据的 owner
    await configureOwner({ feishu: true });
    // Upstream replies OMITTED: the 400 must short-circuit before any Feishu call.
    mock = installFeishuMock({});

    // When 答题者向 /api/submit 提交一份缺少 formSlug 的作答
    const res = await postSubmit({ answers: SUBMISSION_ANSWERS });

    // Then 响应状态码为 400
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // And 没有向上游飞书发起任何请求
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 发布缺少 meta 标题的表单返回 400 且不落库", async () => {
    // Given 一份缺少 meta 标题的表单定义
    // When owner 向 /api/forms 发布该表单
    const res = await postForm({ meta: { description: "无标题" }, fields: FORM_FIELDS });

    // Then 响应状态码为 400
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // And forms 表里没有新增任何表单
    expect(await formsRowCount()).toBe(0);
  });

  it("Scenario: 发布字段数组为空的表单仍可成功", async () => {
    // Given 一份 meta 合法但 fields 为空数组的表单定义
    // When owner 向 /api/forms 发布该表单
    const res = await postForm({ meta: { title: "空表单" }, fields: [] });

    // Then 响应状态码为 201
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug?: string };
    // And 响应体带有一个非空的 slug
    expect(body.slug).toBeTypeOf("string");
    expect(body.slug && body.slug.length).toBeGreaterThan(0);

    // And 公开拉取该 slug 得到的 fields 为空数组
    const pub = await getForm(body.slug!);
    expect(pub.status).toBe(200);
    const pubBody = (await pub.json()) as { fields?: unknown };
    expect(pubBody.fields).toEqual([]);
  });
});
