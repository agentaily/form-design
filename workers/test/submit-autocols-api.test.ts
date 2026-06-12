import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { applySchema, resetConfig, resetForms, login, authHeader } from "./helpers";
import {
  FEISHU_BITABLE_RECORDS_URL,
  FEISHU_BITABLE_FIELDS_URL,
  FEISHU_FIELD_TYPE_TEXT,
  FEISHU_CODE_FIELD_NOT_FOUND,
  FEISHU_CODE_FIELD_DUPLICATED,
} from "../src/submit";
import { FEISHU_TENANT_TOKEN_URL } from "../src/feishu";

// Outer-loop acceptance specs for §15.8 飞书列自动创建（自愈）, driven through the
// real Hono app in workerd via SELF.fetch, with ALL Feishu upstreams mocked
// locally — never hits open.feishu.cn.
//
// The §15.8 self-heal is REACTIVE: a steady-state write (target columns already
// exist → first add-record returns code 0) hits ONLY the token-exchange + the
// add-record endpoints, never the two field endpoints. Only when add-record
// returns code 1254045 (FieldNameNotFound, no record produced) does the route
//   GET  .../fields           list existing column names
//   POST .../fields           create each missing column (type 1, 文本)
//   POST .../records          retry the write exactly ONCE
// This file realizes every §15.8 scenario of workers/features/submit.feature:
//   1. 写记录遇列不存在 → 补建缺失列 → 重试成功 (200 + recordId)
//   2. 自愈只建缺失的列（已存在的列不重复建）
//   3. 列已存在（稳态）→ 零字段端点调用
//   4. 建列遇 FieldNameDuplicated (1254014) → 幂等成功 → 200
//   5. 自愈后重试仍失败 → 502，响应不含 token / app_secret
//
// Contract: SPEC.md §15.8.

const BASE = "https://api.local";

// Concrete owner credential fixtures — distinctive + long enough that any leak
// into a response body / message / header is caught unmistakably by a substring
// scan. Written into D1 (encrypted) via POST /api/config; asserted to never
// reappear in any /api/submit response (§15.7).
const OWNER_DEEPSEEK_KEY = "sk-owner-DEEPSEEK-secret-0123456789abcdef";
const OWNER_FEISHU_APP_ID = "cli_fixtureAppId9999";
const OWNER_FEISHU_APP_SECRET = "feishu-APP-SECRET-qrstuvwxyz-7777-SHHH";
const OWNER_FEISHU_APP_TOKEN = "bascnFixtureAppTokenXYZ";
const OWNER_FEISHU_TABLE_ID = "tblFixture123";

// The token the mocked exchange (stage ①) hands back; it must ONLY ever ride the
// Authorization header on the record / field calls — never in any response (§15.7).
const UPSTREAM_TENANT_TOKEN = "t-xxxxxxxxxxxxxxxx-SECRET-9999";
const UPSTREAM_RECORD_ID = "rec-xxxxxxxxxxxxxx";

// The exact add-record URL the route must hit: the records template with the
// owner's app_token / table_id filled in (SPEC.md §15.5).
const BITABLE_RECORDS_URL = FEISHU_BITABLE_RECORDS_URL.replace(
  "{app_token}",
  OWNER_FEISHU_APP_TOKEN,
).replace("{table_id}", OWNER_FEISHU_TABLE_ID);

// The fields template with app_token / table_id filled in. The lister appends a
// `?page_size=100` query; the creator POSTs to the bare URL. We dispatch on the
// URL's pathname (origin+path, query stripped) so BOTH land on the field handler.
const BITABLE_FIELDS_URL = FEISHU_BITABLE_FIELDS_URL.replace(
  "{app_token}",
  OWNER_FEISHU_APP_TOKEN,
).replace("{table_id}", OWNER_FEISHU_TABLE_ID);

/** origin + pathname (no query / hash), used to match the GET-with-?page_size lister. */
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
// HTTP 200 carrying the business code 1254045 (FieldNameNotFound, no record). The
// ONLY trigger of the §15.8 self-heal. (§15.5)
const BITABLE_FIELD_MISSING_BODY = JSON.stringify({
  code: FEISHU_CODE_FIELD_NOT_FOUND,
  msg: "FieldNameNotFound",
});

/** Build a list-fields OK body whose `data.items[].field_name` is the given names. */
function fieldsListBody(names: string[]): string {
  return JSON.stringify({
    code: 0,
    msg: "success",
    data: { items: names.map((n) => ({ field_name: n })) },
  });
}
const FIELD_CREATE_OK_BODY = JSON.stringify({ code: 0, msg: "success" });
// Creating a column whose name already exists → 1254014, treated as idempotent
// SUCCESS by the self-heal (§15.8 幂等与并发).
const FIELD_CREATE_DUP_BODY = JSON.stringify({
  code: FEISHU_CODE_FIELD_DUPLICATED,
  msg: "FieldNameDuplicated",
});

// --- Four-endpoint Feishu fetch mock (default-deny, ordered + sequenced) -------
//
// The §15.8 flow fans out to up to FOUR upstreams: ① token exchange,
// ② add-record (POST records), ③ list-fields (GET fields), ④ create-field
// (POST fields). We dispatch on the exact upstream URL / pathname + method; any
// unmatched call THROWS. The throw is load-bearing:
//   - omit `record` ⇒ the route must NOT write a record.
//   - omit `fieldsList` ⇒ the route must NOT list fields (steady state ⇒ this
//     stays omitted, proving "稳态不打字段端点").
//   - omit `fieldCreate` ⇒ the route must NOT create any field.
// The add-record endpoint takes a SEQUENCE of replies (one per call, in order):
// the self-heal scenario seeds [1254045, code 0] so the first write fails-with-
// missing-column and the retry succeeds. Each endpoint records its calls + args
// so we can assert per-endpoint counts (steady ⇒ fields list/create = 0; self-
// heal ⇒ list = 1, create = only-missing, record = 2).

interface UpstreamReply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface FeishuMockOpts {
  /** Reply for the tenant_access_token exchange (①). Omit ⇒ must NOT be called. */
  token?: UpstreamReply;
  /**
   * Replies for the Bitable add-record write (②), consumed IN ORDER one per call.
   * A single reply ⇒ steady state (one write). Two replies ⇒ self-heal retry.
   * Omit ⇒ the record endpoint must NOT be called. If more calls arrive than
   * replies, the mock THROWS (an unexpected extra write attempt — e.g. a retry
   * loop that won't stop).
   */
  record?: UpstreamReply[];
  /** Reply for the list-fields GET (③). Omit ⇒ must NOT be called (steady state). */
  fieldsList?: UpstreamReply;
  /** Reply for each create-field POST (④). Omit ⇒ must NOT be called. */
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
  /** ① tenant_access_token exchange calls, in order. */
  readonly tokenCalls: CapturedCall[];
  /** ② Bitable add-record (POST records) calls, in order. */
  readonly recordCalls: CapturedCall[];
  /** ③ list-fields (GET fields) calls, in order. */
  readonly fieldsListCalls: CapturedCall[];
  /** ④ create-field (POST fields) calls, in order. */
  readonly fieldCreateCalls: CapturedCall[];
  restore(): void;
}

function installFeishuMock(opts: FeishuMockOpts): FeishuMock {
  const tokenCalls: CapturedCall[] = [];
  const recordCalls: CapturedCall[] = [];
  const fieldsListCalls: CapturedCall[] = [];
  const fieldCreateCalls: CapturedCall[] = [];

  const realFetch = globalThis.fetch;
  const reply = (r: UpstreamReply): Response =>
    new Response(r.body, {
      status: r.status,
      headers: r.headers ?? { "content-type": "application/json" },
    });

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

    // ① token exchange.
    if (req.url === FEISHU_TENANT_TOKEN_URL) {
      if (!opts.token) {
        throw new Error(
          `unexpected token-exchange upstream call to ${req.url} (no reply configured)`,
        );
      }
      tokenCalls.push(captured);
      return reply(opts.token);
    }

    // ② add-record write — sequenced: nth call gets the nth configured reply.
    if (req.url === BITABLE_RECORDS_URL) {
      if (!opts.record || opts.record.length === 0) {
        throw new Error(`unexpected add-record upstream call to ${req.url} (no reply configured)`);
      }
      const idx = recordCalls.length;
      if (idx >= opts.record.length) {
        // More writes than configured replies ⇒ the route attempted an extra
        // (unbounded) retry. §15.8 retries exactly ONCE — surface the violation.
        throw new Error(
          `add-record called ${idx + 1} times but only ${opts.record.length} reply(ies) configured (§15.8: retry at most once)`,
        );
      }
      recordCalls.push(captured);
      return reply(opts.record[idx]);
    }

    // ③ / ④ field endpoints share a pathname; method distinguishes list vs create.
    if (pathKey(req.url) === BITABLE_FIELDS_PATH) {
      if (req.method === "GET") {
        if (!opts.fieldsList) {
          throw new Error(
            `unexpected list-fields upstream call to ${req.url} (no reply configured — steady state must not list fields)`,
          );
        }
        fieldsListCalls.push(captured);
        return reply(opts.fieldsList);
      }
      if (req.method === "POST") {
        if (!opts.fieldCreate) {
          throw new Error(
            `unexpected create-field upstream call to ${req.url} (no reply configured)`,
          );
        }
        fieldCreateCalls.push(captured);
        return reply(opts.fieldCreate);
      }
      throw new Error(`unexpected method ${req.method} on fields endpoint ${req.url}`);
    }

    // Default-deny: the route must only ever talk to the four configured Feishu
    // upstreams (and only the configured app_token/table_id URLs).
    throw new Error(
      `unexpected outbound fetch to ${req.method} ${req.url} (only the Feishu token + records + fields endpoints are mocked)`,
    );
  };

  globalThis.fetch = stub as typeof fetch;
  return {
    tokenCalls,
    recordCalls,
    fieldsListCalls,
    fieldCreateCalls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

// Owner-only setup token (§17.1) for the POST /api/config + POST /api/forms calls.
let token: string;

async function configureOwner(): Promise<void> {
  const res = await SELF.fetch(`${BASE}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({
      // DeepSeek is the required block — POST /api/config 400s without it.
      deepseek: { apiKey: OWNER_DEEPSEEK_KEY, model: "deepseek-chat" },
      feishu: {
        appId: OWNER_FEISHU_APP_ID,
        appSecret: OWNER_FEISHU_APP_SECRET,
        appToken: OWNER_FEISHU_APP_TOKEN,
        tableId: OWNER_FEISHU_TABLE_ID,
      },
    }),
  });
  if (res.status !== 200) {
    throw new Error(`setup configureOwner failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Publish a form whose field labels MATCH the answer labels submitted below, so
 * the §20 required-field validation passes and the route actually reaches the
 * §15 / §15.8 Feishu write. `labels` become required text fields.
 */
async function publishFormWithLabels(labels: string[]): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({
      meta: { title: "自愈建列测试表单" },
      fields: labels.map((label, i) => ({
        id: `f_${i}`,
        type: "text",
        label,
        required: true,
      })),
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

// POST /api/submit is PUBLIC (§17.1) → intentionally NO Authorization header.
function postSubmit(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Convenience: a submission of text answers, one per (label, value) pair. */
function submission(
  slug: string,
  answers: Array<{ label: string; value: string }>,
): { formSlug: string; answers: Array<{ label: string; value: string }> } {
  return { formSlug: slug, answers };
}

describe("submit auto-create-columns POST /api/submit (workers/features/submit.feature §15.8)", () => {
  let mock: FeishuMock | undefined;

  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    token = await login();
  });

  afterEach(() => {
    mock?.restore();
    mock = undefined;
  });

  it("Scenario: 写记录遇列不存在时自动建缺失列并重试成功", async () => {
    // Given 一个已保存完整飞书凭据的 owner + 一份已发布的表单
    await configureOwner();
    const slug = await publishFormWithLabels(["姓名", "城市"]);

    // And token OK；首写返回 1254045（缺列）；列出现有列（不含两列）；建列成功；重试写成功。
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: [
        { status: 200, body: BITABLE_FIELD_MISSING_BODY },
        { status: 200, body: BITABLE_OK_BODY },
      ],
      fieldsList: { status: 200, body: fieldsListBody([]) },
      fieldCreate: { status: 200, body: FIELD_CREATE_OK_BODY },
    });

    // When 答题者带着该表单的 slug 提交作答（两列都缺）
    const res = await postSubmit(
      submission(slug, [
        { label: "姓名", value: "张三" },
        { label: "城市", value: "北京" },
      ]),
    );

    // Then 响应状态码为 200，ok 为真，带 recordId
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; recordId?: string };
    expect(body.ok).toBe(true);
    expect(body.recordId).toBe(UPSTREAM_RECORD_ID);

    // And 列出过该表的现有字段恰好一次
    expect(mock.fieldsListCalls).toHaveLength(1);
    // The list is a GET carrying the token only on the Authorization header (§15.7).
    expect(mock.fieldsListCalls[0].method).toBe("GET");
    expect(mock.fieldsListCalls[0].headers.get("authorization")).toBe(
      `Bearer ${UPSTREAM_TENANT_TOKEN}`,
    );

    // And 对每个缺失的列各新建字段一次（两列都缺 → 两次），各为 type 1（文本）。
    expect(mock.fieldCreateCalls).toHaveLength(2);
    const created = mock.fieldCreateCalls.map(
      (c) => (c.body as { field_name?: string; type?: number }).field_name,
    );
    expect(created).toEqual(expect.arrayContaining(["姓名", "城市"]));
    for (const c of mock.fieldCreateCalls) {
      expect(c.method).toBe("POST");
      expect((c.body as { type?: number }).type).toBe(FEISHU_FIELD_TYPE_TEXT);
      expect(c.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_TENANT_TOKEN}`);
    }

    // And 对多维表格新增记录接口共发起两次请求（首写缺列失败 + 补列后重试成功）。
    expect(mock.recordCalls).toHaveLength(2);
    expect(mock.tokenCalls).toHaveLength(1);
  });

  it("Scenario: 自愈只新建缺失的列不重复建已存在的列", async () => {
    // Given owner + 表单，两列「姓名」「城市」。
    await configureOwner();
    const slug = await publishFormWithLabels(["姓名", "城市"]);

    // And 列出现有列时「姓名」已存在、「城市」缺失 → 只该对「城市」建一次列。
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: [
        { status: 200, body: BITABLE_FIELD_MISSING_BODY },
        { status: 200, body: BITABLE_OK_BODY },
      ],
      fieldsList: { status: 200, body: fieldsListBody(["姓名"]) },
      fieldCreate: { status: 200, body: FIELD_CREATE_OK_BODY },
    });

    // When 提交含一个已存在列（姓名）与一个缺失列（城市）的作答
    const res = await postSubmit(
      submission(slug, [
        { label: "姓名", value: "张三" },
        { label: "城市", value: "北京" },
      ]),
    );

    // Then 200。
    expect(res.status).toBe(200);

    // And 后端只对缺失的「城市」发起新建字段请求，未对已存在的「姓名」建列。
    expect(mock.fieldsListCalls).toHaveLength(1);
    expect(mock.fieldCreateCalls).toHaveLength(1);
    const created = mock.fieldCreateCalls.map(
      (c) => (c.body as { field_name?: string }).field_name,
    );
    expect(created).toEqual(["城市"]);
    expect(created).not.toContain("姓名");
    expect(mock.recordCalls).toHaveLength(2);
  });

  it("Scenario: 列已存在时稳态提交不调用任何字段端点", async () => {
    // Given owner + 表单。
    await configureOwner();
    const slug = await publishFormWithLabels(["姓名"]);

    // And 首写即 code 0（列已存在）。fieldsList / fieldCreate 都 OMITTED：
    // 任何字段端点调用都会 THROW —— 这是「稳态零开销」断言的承重设计。record 只配 1 个回复。
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: [{ status: 200, body: BITABLE_OK_BODY }],
    });

    // When 提交一份作答。
    const res = await postSubmit(submission(slug, [{ label: "姓名", value: "张三" }]));

    // Then 200。
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; recordId?: string };
    expect(body.ok).toBe(true);
    expect(body.recordId).toBe(UPSTREAM_RECORD_ID);

    // And 没有向飞书列出字段 / 新建字段接口发起任何请求（稳态零开销）。
    expect(mock.fieldsListCalls).toHaveLength(0);
    expect(mock.fieldCreateCalls).toHaveLength(0);
    // And 对多维表格新增记录接口只发起一次请求。
    expect(mock.recordCalls).toHaveLength(1);
    expect(mock.tokenCalls).toHaveLength(1);
  });

  it("Scenario: 新建字段遇 FieldNameDuplicated 视为成功", async () => {
    // Given owner + 表单。
    await configureOwner();
    const slug = await publishFormWithLabels(["姓名"]);

    // And 首写缺列；列出为空；建列返回 1254014（并发下别处刚建）；重试写成功。
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: [
        { status: 200, body: BITABLE_FIELD_MISSING_BODY },
        { status: 200, body: BITABLE_OK_BODY },
      ],
      fieldsList: { status: 200, body: fieldsListBody([]) },
      fieldCreate: { status: 200, body: FIELD_CREATE_DUP_BODY },
    });

    // When 提交一份作答。
    const res = await postSubmit(submission(slug, [{ label: "姓名", value: "张三" }]));

    // Then 200 + ok 为真 —— 1254014 当幂等成功，自愈照常走到重试写入。
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
    expect(mock.fieldsListCalls).toHaveLength(1);
    expect(mock.fieldCreateCalls).toHaveLength(1);
    expect(mock.recordCalls).toHaveLength(2);
  });

  it("Scenario: 自愈后重试写入仍失败时返回 502 且不泄漏凭据", async () => {
    // Given owner + 表单。
    await configureOwner();
    const slug = await publishFormWithLabels(["姓名"]);

    // And 两次写记录都返回 1254045（补列后仍缺，或别的原因）；列出 / 建列都成功。
    // record 只配 2 个回复：若路由发起第 3 次写，mock 会 THROW（证明只重试一次）。
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: [
        { status: 200, body: BITABLE_FIELD_MISSING_BODY },
        { status: 200, body: BITABLE_FIELD_MISSING_BODY },
      ],
      fieldsList: { status: 200, body: fieldsListBody([]) },
      fieldCreate: { status: 200, body: FIELD_CREATE_OK_BODY },
    });

    // When 提交一份作答。
    const res = await postSubmit(submission(slug, [{ label: "姓名", value: "张三" }]));

    // Then 502（自愈后重试仍失败是终态写失败，§15.6）。
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    const raw = await res.clone().text();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // And 只重试一次：record 恰好两次（若有第 3 次 mock 已抛错）。
    expect(mock.recordCalls).toHaveLength(2);

    // And 错误响应里不含 owner 的明文 app secret，也不含换取到的 tenant_access_token（§15.7）。
    expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);
    expect(raw).not.toContain(UPSTREAM_TENANT_TOKEN);
    for (const [, value] of res.headers) {
      expect(value).not.toContain(OWNER_FEISHU_APP_SECRET);
      expect(value).not.toContain(UPSTREAM_TENANT_TOKEN);
    }
  });
});
