import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { applySchema, resetConfig, resetForms, testEnv, login, authHeader } from "./helpers";
import { FEISHU_BITABLE_RECORDS_URL } from "../src/submit";
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
    token = await login();
  });

  afterEach(() => {
    mock?.restore();
    mock = undefined;
  });

  it("Scenario: 向已发布表单提交满足必填的作答正常写入", async () => {
    // Given 完整飞书凭据 + 含必填字段且 published 的表单
    await configureOwner({ feishu: true });
    const slug = await publishForm([REQUIRED_NAME]);
    // 上游两段都 OK
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: { status: 200, body: BITABLE_OK_BODY },
    });

    // When 提交填齐了所有必填字段的作答
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "姓名", value: "张三" }] });

    // Then 200 + ok 为真
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.recordCalls).toHaveLength(1);
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

    // And 没有向上游飞书发起任何请求
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 向草稿表单提交返回 409 且不打飞书上游", async () => {
    await configureOwner({ feishu: true });
    const slug = await publishForm([REQUIRED_NAME]);
    await setStatus(slug, "draft");
    mock = installFeishuMock({});

    const res = await postSubmit({ formSlug: slug, answers: [{ label: "姓名", value: "张三" }] });

    expect(res.status).toBe(409);
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 漏填必填字段返回 400 且不打飞书上游", async () => {
    // Given 完整飞书凭据 + 含必填字段「姓名」且 published 的表单
    await configureOwner({ feishu: true });
    const slug = await publishForm([REQUIRED_NAME]);
    mock = installFeishuMock({});

    // When 提交一份不含「姓名」答案的作答（带一条无关答案以过 parseSubmitRequest 的非空数组校验）
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "其它", value: "x" }] });

    // Then 400 + 不打上游
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");
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
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 非必填字段缺失不影响提交", async () => {
    // Given 完整飞书凭据 + 一个必填字段 + 一个非必填字段，published
    await configureOwner({ feishu: true });
    const slug = await publishForm([REQUIRED_NAME, OPTIONAL_AGE]);
    mock = installFeishuMock({
      token: { status: 200, body: FEISHU_TOKEN_OK_BODY },
      record: { status: 200, body: BITABLE_OK_BODY },
    });

    // When 只填了必填字段（缺非必填的「年龄」）
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "姓名", value: "张三" }] });

    // Then 200 + ok 为真
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
    expect(mock.recordCalls).toHaveLength(1);
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
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });
});
