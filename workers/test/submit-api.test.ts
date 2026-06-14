import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  applySchema,
  resetConfig,
  resetForms,
  resetSubmissions,
  testEnv,
  waitForFormFeishuTable,
  login,
  authHeader,
} from "./helpers";
import { FEISHU_BITABLE_RECORDS_URL, FEISHU_BITABLE_FIELDS_URL } from "../src/submit";
import { FEISHU_BITABLE_APPS_URL, FEISHU_BITABLE_TABLES_URL } from "../src/feishu-schema";
import { FEISHU_TENANT_TOKEN_URL } from "../src/feishu";

// POST /api/submit stays PUBLIC (SPEC.md §17.1) — answerers send NO token; postSubmit
// never sends one. Its SETUP (POST /api/config to save creds, POST /api/forms to
// publish) hits owner-only endpoints, so those carry a Bearer from login().
//
// 架构转向（PR-2）：提交主存翻转到 **D1**，飞书降为**可选后台同步**。Outer-loop acceptance
// specs for POST /api/submit, driven through the real Hono app via SELF.fetch with ALL
// Feishu upstreams mocked locally — never hits open.feishu.cn (installFeishuMock).
//
// 关键时序：飞书同步现在在 `c.executionCtx.waitUntil(...)` 后台跑（响应返回后才发生）。所以：
//   - 断言「提交是否落库」直接查 D1（同步、立即可见）；
//   - 断言「同步上游调用 / 回执」前，先 `waitForSyncSettled(id)` 轮询 D1 直到回执（record_id
//     或 sync_error）落定，再看 mock 捕获的 token/record/fields 调用。
//   - 未配飞书 / 校验拒收 → 没有后台同步，用 `settle()` 短暂静置后断言零飞书调用。
// 此外，发布作为 setup（owner 已配飞书）会在 waitUntil 触发 preCreateBitableColumnsBestEffort，
// 打到 mock；setup 后 drain 掉这股后台扇出再 reset 捕获，使断言只反映提交本身的同步。
//
// Realizes workers/features/submit.feature（D1 主存 + 飞书可选后台同步）+ §15.8 自愈（后台）。
// Contract: SPEC.md §15、§16.8.

const BASE = "https://api.local";

// Concrete owner credential fixtures — distinctive + long so any leak into a response
// (body / message / header) is caught by a substring scan (§15.7).
const OWNER_DEEPSEEK_KEY = "sk-owner-DEEPSEEK-secret-0123456789abcdef";
const OWNER_FEISHU_APP_ID = "cli_fixtureAppId9999";
const OWNER_FEISHU_APP_SECRET = "feishu-APP-SECRET-qrstuvwxyz-7777-SHHH";
const OWNER_FEISHU_APP_TOKEN = "bascnFixtureAppTokenXYZ";
const OWNER_FEISHU_TABLE_ID = "tblFixture123";

const UPSTREAM_TENANT_TOKEN = "t-xxxxxxxxxxxxxxxx-SECRET-9999";
const UPSTREAM_RECORD_ID = "rec-xxxxxxxxxxxxxx";

const BITABLE_URL = FEISHU_BITABLE_RECORDS_URL.replace(
  "{app_token}",
  OWNER_FEISHU_APP_TOKEN,
).replace("{table_id}", OWNER_FEISHU_TABLE_ID);

const BITABLE_FIELDS_URL = FEISHU_BITABLE_FIELDS_URL.replace(
  "{app_token}",
  OWNER_FEISHU_APP_TOKEN,
).replace("{table_id}", OWNER_FEISHU_TABLE_ID);
/** origin + pathname (no query / hash), to match the GET-with-?page_size lister. */
function pathKey(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}
const BITABLE_FIELDS_PATH = pathKey(BITABLE_FIELDS_URL);

// §16.9 发布即自动建表：建 app / 建数据表端点 + OK 夹具。刻意让 create-app 返回
// OWNER_FEISHU_APP_TOKEN、create-table 返回 OWNER_FEISHU_TABLE_ID，故发布把 per-form 表落成既有
// BITABLE_URL / BITABLE_FIELDS_URL 那对，提交同步命中既有 URL，无需另设夹具。
const TABLES_URL = FEISHU_BITABLE_TABLES_URL.replace("{app_token}", OWNER_FEISHU_APP_TOKEN);
const APP_CREATE_OK_BODY = JSON.stringify({
  code: 0,
  msg: "success",
  data: { app: { app_token: OWNER_FEISHU_APP_TOKEN } },
});
const TABLE_CREATE_OK_BODY = JSON.stringify({
  code: 0,
  msg: "success",
  data: { table_id: OWNER_FEISHU_TABLE_ID },
});

// list-columns OK body: table already has 姓名(text) + 兴趣(multi-select), so the
// steady-state listBitableColumns finds every submitted label — no self-heal.
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

// --- Feishu fetch mock (default-deny, dispatched on URL + method) -------------
// Same shape as before: omit `token`/`record` ⇒ a call to it THROWS (load-bearing
// for "没有向上游飞书发起任何请求"). list-fields GET + create-field POST share a path,
// split by method.

interface UpstreamReply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}
interface FeishuMockOpts {
  token?: UpstreamReply;
  record?: UpstreamReply;
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
        throw new Error(`unexpected token-exchange upstream call to ${req.url} (no reply)`);
      }
      tokenCalls.push(captured);
      return new Response(opts.token.body, {
        status: opts.token.status,
        headers: opts.token.headers ?? { "content-type": "application/json" },
      });
    }
    // §16.9 发布即自动建表：建 app（POST /apps）/ 建数据表（POST /apps/{token}/tables）恒 OK，
    // 让发布把 per-form 表落进 form 行；提交据此同步。两端点在发布后台 best-effort 调用。
    if (req.url === FEISHU_BITABLE_APPS_URL && req.method === "POST") {
      return new Response(APP_CREATE_OK_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (req.url === TABLES_URL && req.method === "POST") {
      return new Response(TABLE_CREATE_OK_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (req.url === BITABLE_URL) {
      if (!opts.record) {
        throw new Error(`unexpected add-record upstream call to ${req.url} (no reply)`);
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
 * Drain the publish-triggered background `preCreateBitableColumnsBestEffort` (§16.8):
 * wait for its token exchange to land on the mock, then settle so any list/create
 * follow-ups also land — so the caller can `resetCalls()` and assert on the submit alone.
 */
async function drainBackgroundPreCreate(mock: FeishuMock): Promise<void> {
  const deadline = Date.now() + 800;
  while (mock.tokenCalls.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 25));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Short settle so any (forbidden) background fan-out would have a chance to fire. */
const settle = () => sleep(50);

interface Receipt {
  feishu_record_id: string | null;
  feishu_synced_at: string | null;
  feishu_sync_error: string | null;
}

async function getReceipt(id: string): Promise<Receipt | null> {
  return testEnv.DB.prepare(
    "SELECT feishu_record_id, feishu_synced_at, feishu_sync_error FROM submissions WHERE id = ?",
  )
    .bind(id)
    .first<Receipt>();
}

/** A submission row's stored answers (parsed from answers_json) + receipt. */
async function getSubmissionRow(
  id: string,
): Promise<{ answers: unknown; receipt: Receipt } | null> {
  const row = await testEnv.DB.prepare(
    "SELECT answers_json, feishu_record_id, feishu_synced_at, feishu_sync_error FROM submissions WHERE id = ?",
  )
    .bind(id)
    .first<{
      answers_json: string;
      feishu_record_id: string | null;
      feishu_synced_at: string | null;
      feishu_sync_error: string | null;
    }>();
  if (row === null) return null;
  return {
    answers: JSON.parse(row.answers_json),
    receipt: {
      feishu_record_id: row.feishu_record_id,
      feishu_synced_at: row.feishu_synced_at,
      feishu_sync_error: row.feishu_sync_error,
    },
  };
}

async function countSubmissions(): Promise<number> {
  const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM submissions").first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

/**
 * Poll D1 until the submission's background Feishu sync has SETTLED — i.e. its receipt
 * carries a record_id (success) OR a sync_error (failure). Returns the final receipt.
 * The background sync runs in `waitUntil` after the 200, so tests await this before
 * asserting on the mock's captured sync calls. Times out (returns last seen) after ~1.5s.
 */
async function waitForSyncSettled(id: string): Promise<Receipt> {
  const deadline = Date.now() + 1500;
  let row = await getReceipt(id);
  while (
    Date.now() < deadline &&
    (row === null || (row.feishu_record_id === null && row.feishu_sync_error === null))
  ) {
    await sleep(5);
    row = await getReceipt(id);
  }
  return row ?? { feishu_record_id: null, feishu_synced_at: null, feishu_sync_error: null };
}

// Owner-only setup token (§17.1) for POST /api/config + POST /api/forms.
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

// POST /api/submit is PUBLIC (§17.1) → intentionally NO Authorization header.
function postSubmit(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Publish a form via the real POST /api/forms and return its slug. */
async function publishFormAndGetSlug(): Promise<string> {
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

/** Publish + drain the publish-background auto-create + reset captures, so the per-stage
 *  counts reflect the submit's own background sync alone. Gates deterministically on the
 *  per-form Feishu table writeback (§16.9) — NOT a fixed sleep — so the subsequent submit
 *  reliably reads a non-null `getFormFeishuTable(slug)` even under CI load. Callers here
 *  always have Feishu configured (the table WILL be written). */
async function publishWithMockDrained(installed: FeishuMock): Promise<string> {
  const slug = await publishFormAndGetSlug();
  await drainBackgroundPreCreate(installed);
  await waitForFormFeishuTable(slug);
  installed.resetCalls();
  return slug;
}

const TEXT_ANSWER = { label: "姓名", value: "张三" };
const MULTI_ANSWER = { label: "兴趣", value: ["阅读", "运动"] };

function makeSubmission(slug: string): { formSlug: string; answers: unknown[] } {
  return { formSlug: slug, answers: [TEXT_ANSWER, MULTI_ANSWER] };
}

/** Submit + assert 200 + return the new submission id from the { ok, id } body. */
async function submitAndGetId(slug: string): Promise<string> {
  const res = await postSubmit(makeSubmission(slug));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok?: boolean; id?: string };
  expect(body.ok).toBe(true);
  expect(body.id).toBeTypeOf("string");
  return body.id as string;
}

describe("submit POST /api/submit (workers/features/submit.feature)", () => {
  let mock: FeishuMock | undefined;

  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    await resetSubmissions();
    token = await login();
  });

  afterEach(() => {
    mock?.restore();
    mock = undefined;
  });

  it("Scenario: 提交成功落 D1 主存并返回提交 id", async () => {
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: { status: 200, body: BITABLE_OK_BODY },
    });
    const slug = await publishWithMockDrained(mock);

    const res = await postSubmit(makeSubmission(slug));
    // Then 200 + ok + id
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; id?: string; recordId?: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBeTypeOf("string");
    // 提交主存是 D1，不在同步响应里回飞书 recordId（它是异步同步产物）。
    expect(body.recordId).toBeUndefined();

    // And 该提交已写入 D1 主存
    const row = await getSubmissionRow(body.id as string);
    expect(row).not.toBeNull();

    // And 后台同步成功后该提交回填了飞书 record id
    const receipt = await waitForSyncSettled(body.id as string);
    expect(receipt.feishu_record_id).toBe(UPSTREAM_RECORD_ID);
    expect(receipt.feishu_sync_error).toBeNull();
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.recordCalls).toHaveLength(1);
    expect(mock.fieldsListCalls).toHaveLength(1);
    expect(mock.fieldCreateCalls).toHaveLength(0);
  });

  it("Scenario: answers 正确映射进后台同步的飞书 fields", async () => {
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: { status: 200, body: BITABLE_OK_BODY },
    });
    const slug = await publishWithMockDrained(mock);

    const id = await submitAndGetId(slug);
    await waitForSyncSettled(id);

    // The token-exchange request carried the owner's SAVED app_id/app_secret.
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.tokenCalls[0].body).toMatchObject({
      app_id: OWNER_FEISHU_APP_ID,
      app_secret: OWNER_FEISHU_APP_SECRET,
    });

    expect(mock.recordCalls).toHaveLength(1);
    const recordCall = mock.recordCalls[0];
    // And 打到了 owner 配置的 app token/table id 端点 + 带 Bearer tenant token（只在这里，§15.7）。
    expect(recordCall.url).toBe(BITABLE_URL);
    expect(recordCall.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_TENANT_TOKEN}`);

    const fields = (recordCall.body as { fields?: Record<string, unknown> }).fields;
    expect(fields).toBeTypeOf("object");
    expect(fields?.[TEXT_ANSWER.label]).toBe(TEXT_ANSWER.value);
    expect(fields?.[MULTI_ANSWER.label]).toEqual(MULTI_ANSWER.value);
  });

  it("Scenario: 未配飞书也照常落 D1 并返回成功且不向飞书发任何请求", async () => {
    // Given 一个未配置飞书的 owner (DeepSeek only).
    await configureOwner({ feishu: false });
    const slug = await publishFormAndGetSlug();
    // ALL replies OMITTED: any Feishu call would THROW → proves zero outbound calls.
    mock = installFeishuMock({});

    const res = await postSubmit(makeSubmission(slug));

    // Then 200 + ok（语义翻转：未配飞书不再 409）
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; id?: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBeTypeOf("string");

    // And 该提交已写入 D1 主存，且飞书回执为空（未同步）
    await settle();
    const row = await getSubmissionRow(body.id as string);
    expect(row).not.toBeNull();
    expect(row!.receipt.feishu_record_id).toBeNull();
    expect(row!.receipt.feishu_synced_at).toBeNull();
    expect(row!.receipt.feishu_sync_error).toBeNull();

    // And 没有向上游飞书发起任何请求
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
    expect(mock.fieldsListCalls).toHaveLength(0);
  });

  it("Scenario: 空 answers 时返回 400 且不落 D1 不同步", async () => {
    await configureOwner({ feishu: true });
    const slug = await publishFormAndGetSlug();
    mock = installFeishuMock({});

    const res = await postSubmit({ formSlug: slug, answers: [] });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    await settle();
    expect(await countSubmissions()).toBe(0);
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 缺少 answers 时返回 400 且不落 D1 不同步", async () => {
    await configureOwner({ feishu: true });
    const slug = await publishFormAndGetSlug();
    mock = installFeishuMock({});

    const res = await postSubmit({ formSlug: slug, foo: "bar" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    await settle();
    expect(await countSubmissions()).toBe(0);
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 同步换 token 失败时提交仍成功并记同步错误且不泄漏 app secret", async () => {
    await configureOwner({ feishu: true });
    // §16.9：per-form 表在发布时建好（用全 OK 的 mock），故先发布把表建妥再换「换 token 失败」的
    // mock 测**提交同步**那一跳的 token 失败——否则 token 失败发生在发布自动建表、表根本没建成，
    // 提交会因 form 无飞书表而干净跳过（不记 sync_error），就测不到「同步换 token 失败记错误」。
    const okMock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: { status: 200, body: BITABLE_OK_BODY },
    });
    const slug = await publishWithMockDrained(okMock);
    okMock.restore();
    // 提交同步用的 mock：token exchange returns a non-zero business code (HTTP 200!). record-write
    // reply OMITTED + list-fields forbidden: reaching them after a failed token would THROW.
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_BAD_BODY },
      fieldsList: null,
    });

    const res = await postSubmit(makeSubmission(slug));
    const raw = await res.clone().text();

    // Then 提交仍成功（D1 主存已写），同步失败被吞
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; id?: string };
    expect(body.ok).toBe(true);

    const receipt = await waitForSyncSettled(body.id as string);
    // And 该提交记录了飞书同步失败、无 record id
    expect(receipt.feishu_sync_error).toBeTypeOf("string");
    expect(receipt.feishu_record_id).toBeNull();
    // 该提交确实落了 D1
    expect(await getSubmissionRow(body.id as string)).not.toBeNull();
    // token 端点被探了（失败是上游裁决）；记录写端点不该被触达。
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.recordCalls).toHaveLength(0);

    // And 整个响应不含明文 app secret，且 sync_error 也不含（只是错误名）。
    expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);
    expect(receipt.feishu_sync_error).not.toContain(OWNER_FEISHU_APP_SECRET);
  });

  it("Scenario: 同步写记录失败时提交仍成功并记同步错误且不泄漏 token", async () => {
    await configureOwner({ feishu: true });
    // token OK, then add-record returns a non-zero code (1254000, NOT 1254045 — a普通
    // 写失败，不自愈)。
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: { status: 200, body: BITABLE_BAD_BODY },
    });
    const slug = await publishWithMockDrained(mock);

    const res = await postSubmit(makeSubmission(slug));
    const raw = await res.clone().text();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; id?: string };
    expect(body.ok).toBe(true);

    const receipt = await waitForSyncSettled(body.id as string);
    expect(await getSubmissionRow(body.id as string)).not.toBeNull();
    expect(receipt.feishu_sync_error).toBeTypeOf("string");
    // Both stages were attempted (token OK, then write failed upstream).
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.recordCalls).toHaveLength(1);

    // And 整个响应不含 tenant token，且回执只含非敏感错误名。
    expect(raw).not.toContain(UPSTREAM_TENANT_TOKEN);
    expect(receipt.feishu_sync_error).not.toContain(UPSTREAM_TENANT_TOKEN);
    expect(receipt.feishu_sync_error).not.toContain(OWNER_FEISHU_APP_SECRET);
  });

  it("Scenario: 整个响应里不含任何明文凭据", async () => {
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: { status: 200, body: BITABLE_OK_BODY },
    });
    const slug = await publishWithMockDrained(mock);

    const res = await postSubmit(makeSubmission(slug));
    expect(res.status).toBe(200);

    const raw = await res.clone().text();
    expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);
    expect(raw).not.toContain(UPSTREAM_TENANT_TOKEN);
    for (const [, value] of res.headers) {
      expect(value).not.toContain(OWNER_FEISHU_APP_SECRET);
      expect(value).not.toContain(UPSTREAM_TENANT_TOKEN);
    }
  });

  // 注：submit.feature 的 §15.8 自愈场景（后台同步遇缺列建列重试 / 自愈仍失败仍 200 记错误 /
  // 列已存在只写一次）由 submit-autocols-api.test.ts 在后台同步路径上完整 realize，本文件不重复。
});
