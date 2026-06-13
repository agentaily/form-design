import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  applySchema,
  resetConfig,
  resetForms,
  resetSubmissions,
  testEnv,
  login,
  authHeader,
} from "./helpers";
import { FEISHU_BITABLE_RECORDS_URL, FEISHU_BITABLE_FIELDS_URL } from "../src/submit";
import { FEISHU_TENANT_TOKEN_URL } from "../src/feishu";

// Outer-loop acceptance specs for the §20 submit gates (status gate + required-
// answers validation), driven through the real Hono app via SELF.fetch with BOTH
// Feishu upstreams mocked. Realizes every scenario of
// workers/features/submit-validation.feature:
//   1. published + 必填填齐 → 200 写飞书
//   2. closed → 409「表单未开放提交」，不打飞书上游
//   3. draft → 409，不打飞书上游
//   4. 漏填必填 → 400，不打飞书上游
//   5. 必填空串 → 400，不打飞书上游
//   6. 必填多选空数组 → 400，不打飞书上游
//   7. 非必填缺失 → 200（不影响提交）
//   8. 状态门优先于 owner 配置：未配飞书 + closed → 409「未开放」（非「未配飞书」）
//
// 关键边界：状态门 / 必填校验都在打飞书 *之前*（src/index.ts 1.6 / 1.7）→ 拒收时
// 飞书 mock 必须零调用。两个 409 文案不同（未开放 vs 未配飞书），靠 error 文案区分。
//
// draft / closed 形态：POST /api/forms 发布即 published；本套件在发布后直接改 D1 的
// status 列把它打成 draft / closed（隔离于同样未实现的 PATCH 路由）。
//
// Contract: SPEC.md §20.

const BASE = "https://api.local";

const OWNER_FEISHU_APP_ID = "cli_fixtureAppId9999";
const OWNER_FEISHU_APP_SECRET = "feishu-APP-SECRET-qrstuvwxyz-7777-SHHH";
const OWNER_FEISHU_APP_TOKEN = "bascnFixtureAppTokenXYZ";
const OWNER_FEISHU_TABLE_ID = "tblFixture123";
const OWNER_DEEPSEEK_KEY = "sk-owner-DEEPSEEK-secret-0123456789abcdef";

const UPSTREAM_TENANT_TOKEN = "t-xxxxxxxxxxxxxxxx-SECRET-9999";
const UPSTREAM_RECORD_ID = "rec-xxxxxxxxxxxxxx";

const BITABLE_URL = FEISHU_BITABLE_RECORDS_URL.replace(
  "{app_token}",
  OWNER_FEISHU_APP_TOKEN,
).replace("{table_id}", OWNER_FEISHU_TABLE_ID);

// The fields endpoint (§15.8 升级：稳态提交先 GET 列出列真实类型；预建 / 自愈 POST 建列）。
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
// List-fields reply: 姓名(text) already exists as a column, so the steady-state
// listBitableColumns writes the submitted text value by its real type — no self-heal.
const FIELDS_LIST_BODY = JSON.stringify({
  code: 0,
  msg: "success",
  data: { items: [{ field_name: "姓名", type: 1 }] },
});
const FIELD_CREATE_OK_BODY = JSON.stringify({ code: 0, msg: "success" });

// --- Two-stage Feishu fetch mock (default-deny, ordered) ----------------------
// Same shape as submit-api.test.ts: omit a stage ⇒ any call to it THROWS, which
// is load-bearing for "不打飞书上游" — when a gate must reject before Feishu, we
// configure NEITHER stage and assert per-stage call counts are 0.

interface UpstreamReply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}
interface FeishuMockOpts {
  token?: UpstreamReply;
  record?: UpstreamReply;
  /** list-fields GET reply (§15.8 升级). Defaults to FIELDS_LIST_BODY; `null` forbids. */
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
 * Drain the publish-triggered background `preCreateBitableColumnsBestEffort` (§16.8)
 * — wait for its token exchange to land on the mock, then settle so any list/create
 * follow-ups also land, so the caller can `resetCalls()` and assert on the submit alone.
 */
async function drainBackgroundPreCreate(mock: FeishuMock): Promise<void> {
  const deadline = Date.now() + 800;
  while (mock.tokenCalls.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 25));
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

/** Publish a form (owner-only) and return its slug. `fields` configures required-ness. */
async function publishForm(fields: unknown[]): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ meta: { title: "校验测试表单" }, fields }),
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

/** Force the form's status column directly in D1 (isolates §20 from the §21 PATCH route). */
async function setStatus(slug: string, status: "draft" | "closed" | "published"): Promise<void> {
  await testEnv.DB.prepare("UPDATE forms SET status = ? WHERE slug = ?").bind(status, slug).run();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Short settle so any background best-effort sync (feishu-configured happy paths) drains. */
const settle = () => sleep(50);

/** Count rows in the D1 submissions store (the primary store, §15). */
async function countSubmissions(): Promise<number> {
  const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM submissions").first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

// POST /api/submit is PUBLIC (§17.1) → no Authorization header.
function postSubmit(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const REQUIRED_NAME = { id: "f_name", type: "text", label: "姓名", required: true };
const OPTIONAL_AGE = { id: "f_age", type: "number", label: "年龄" };
const REQUIRED_HOBBY = { id: "f_hobby", type: "checkbox", label: "兴趣", required: true };

describe("submit validation gates POST /api/submit (workers/features/submit-validation.feature)", () => {
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

  it("Scenario: 向已发布表单提交满足必填的作答正常写入", async () => {
    // Given 完整飞书凭据 + 含必填字段且 published 的表单
    await configureOwner({ feishu: true });
    // 上游两段都 OK。先装 mock 再发布，drain 掉发布预建后台扇出（§16.8）。
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: { status: 200, body: BITABLE_OK_BODY },
    });
    const slug = await publishForm([REQUIRED_NAME]);
    await drainBackgroundPreCreate(mock);
    mock.resetCalls();

    // When 提交填齐了所有必填字段的作答
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "姓名", value: "张三" }] });

    // Then 200 + ok 为真 + 落 D1 主存（飞书同步是后台 best-effort，本节只验「过了门、落了库」）。
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; id?: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBeTypeOf("string");
    expect(await countSubmissions()).toBe(1);
    // Let the background feishu sync drain (token+record configured → succeeds, no throw).
    await settle();
  });

  it("Scenario: 向已关闭表单提交返回 409 且不打飞书上游", async () => {
    // Given 完整飞书凭据 + 一份 closed 的表单
    await configureOwner({ feishu: true });
    const slug = await publishForm([REQUIRED_NAME]);
    await setStatus(slug, "closed");
    // 两段都 OMITTED：任何飞书调用都会 THROW，证明状态门在打飞书前拒收。
    mock = installFeishuMock({});

    // When 提交一份作答
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "姓名", value: "张三" }] });

    // Then 409 + 提示表单未开放提交
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");
    // 文案为「表单未开放提交」语义，且 *不是*「未配飞书」。
    expect(body.error).not.toContain("未配置飞书");

    // And 没有提交被写入 D1 主存 + 没有向上游飞书发起任何请求
    expect(await countSubmissions()).toBe(0);
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 向草稿表单提交返回 409 且不落 D1 不同步飞书", async () => {
    await configureOwner({ feishu: true });
    const slug = await publishForm([REQUIRED_NAME]);
    await setStatus(slug, "draft");
    mock = installFeishuMock({});

    const res = await postSubmit({ formSlug: slug, answers: [{ label: "姓名", value: "张三" }] });

    expect(res.status).toBe(409);
    expect(await countSubmissions()).toBe(0);
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 漏填必填字段返回 400 且不落 D1 不同步飞书", async () => {
    // Given 完整飞书凭据 + 含必填字段「姓名」且 published 的表单
    await configureOwner({ feishu: true });
    const slug = await publishForm([REQUIRED_NAME]);
    mock = installFeishuMock({});

    // When 提交一份不含「姓名」答案的作答（带一条无关答案以过 parseSubmitRequest 的非空数组校验）
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "其它", value: "x" }] });

    // Then 400 + 不落 D1 + 不打上游
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");
    expect(await countSubmissions()).toBe(0);
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 必填字段填了空值视为漏填返回 400", async () => {
    await configureOwner({ feishu: true });
    const slug = await publishForm([REQUIRED_NAME]);
    mock = installFeishuMock({});

    // When「姓名」答案为空字符串
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "姓名", value: "" }] });

    expect(res.status).toBe(400);
    expect(await countSubmissions()).toBe(0);
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 多选必填字段为空数组视为漏填返回 400", async () => {
    await configureOwner({ feishu: true });
    const slug = await publishForm([REQUIRED_HOBBY]);
    mock = installFeishuMock({});

    // When「兴趣」答案为空数组
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "兴趣", value: [] }] });

    expect(res.status).toBe(400);
    expect(await countSubmissions()).toBe(0);
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 非必填字段缺失不影响提交", async () => {
    // Given 完整飞书凭据 + 一个必填字段 + 一个非必填字段，published
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: { status: 200, body: BITABLE_OK_BODY },
    });
    // 表单含 number 字段「年龄」→ 发布预建会按数字列建它；drain 掉这股后台扇出。
    const slug = await publishForm([REQUIRED_NAME, OPTIONAL_AGE]);
    await drainBackgroundPreCreate(mock);
    mock.resetCalls();

    // When 只填了必填字段（缺非必填的「年龄」）
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "姓名", value: "张三" }] });

    // Then 200 + ok 为真 + 落 D1 主存
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
    expect(await countSubmissions()).toBe(1);
    await settle();
  });

  it("Scenario: 状态门在校验失败时绝不触碰 owner 配置", async () => {
    // Given 一个 *未配飞书* 的 owner + 一份 closed 的表单
    await configureOwner({ feishu: false });
    const slug = await publishForm([REQUIRED_NAME]);
    await setStatus(slug, "closed");
    mock = installFeishuMock({});

    // When 提交一份作答
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "姓名", value: "张三" }] });

    // Then 409，且文案是「表单未开放提交」而 *非*「owner 未配置飞书」——
    // 证明状态门先于 owner 配置读取触发（两个 409 的文案区分，§20.4）。
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");
    expect(body.error).not.toContain("未配置飞书");
    expect(await countSubmissions()).toBe(0);
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });
});
