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

// Outer-loop acceptance specs for the D1-primary storage semantics (PR-2). Realizes
// workers/features/submissions-storage.feature: 提交先落 D1 主存（必成）、飞书降为可选
// best-effort 后台同步（成功回填 record id / 失败记 sync_error / 未配则不同步），以及
// 「提交 → 数据后台从 D1 读回」端到端闭环。Driven through the real Hono app via SELF.fetch.
//
// Contract: SPEC.md §15（落 D1 主存 + 飞书可选同步）、§18（数据后台读 D1）.

const BASE = "https://api.local";

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
function pathKey(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}
const FIELDS_PATH = pathKey(BITABLE_FIELDS_URL);

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
const FIELDS_LIST_BODY = JSON.stringify({
  code: 0,
  msg: "success",
  data: { items: [{ field_name: "姓名", type: 1 }] },
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const settle = () => sleep(60);

interface MockOpts {
  /** token-exchange reply. Omit ⇒ a call THROWS (forbidden). */
  token?: string;
  /** add-record reply body. Omit ⇒ a call THROWS (forbidden). */
  record?: string;
}

/** Feishu mock: absorbs the best-effort background sync; default-deny on anything else. */
function installFeishuMock(opts: MockOpts): {
  tokenCalled(): boolean;
  recordCalled(): boolean;
  restore(): void;
} {
  let tokenCalls = 0;
  let recordCalls = 0;
  const realFetch = globalThis.fetch;
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as RequestInfo, init);
    if (req.url === FEISHU_TENANT_TOKEN_URL) {
      if (!opts.token) throw new Error(`unexpected token call to ${req.url}`);
      tokenCalls += 1;
      return new Response(opts.token, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (req.url === BITABLE_URL) {
      if (!opts.record) throw new Error(`unexpected record call to ${req.url}`);
      recordCalls += 1;
      return new Response(opts.record, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (pathKey(req.url) === FIELDS_PATH) {
      return new Response(FIELDS_LIST_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected outbound fetch to ${req.url}`);
  };
  globalThis.fetch = stub as typeof fetch;
  return {
    tokenCalled: () => tokenCalls > 0,
    recordCalled: () => recordCalls > 0,
    restore: () => (globalThis.fetch = realFetch),
  };
}

interface Receipt {
  feishu_record_id: string | null;
  feishu_synced_at: string | null;
  feishu_sync_error: string | null;
}
interface Row {
  answers_json: string;
  feishu_record_id: string | null;
  feishu_synced_at: string | null;
  feishu_sync_error: string | null;
}

async function getRow(id: string): Promise<Row | null> {
  return testEnv.DB.prepare(
    "SELECT answers_json, feishu_record_id, feishu_synced_at, feishu_sync_error FROM submissions WHERE id = ?",
  )
    .bind(id)
    .first<Row>();
}

async function waitForSyncSettled(id: string): Promise<Receipt> {
  const deadline = Date.now() + 1500;
  let row = await getRow(id);
  while (
    Date.now() < deadline &&
    (row === null || (row.feishu_record_id === null && row.feishu_sync_error === null))
  ) {
    await sleep(5);
    row = await getRow(id);
  }
  return row
    ? {
        feishu_record_id: row.feishu_record_id,
        feishu_synced_at: row.feishu_synced_at,
        feishu_sync_error: row.feishu_sync_error,
      }
    : { feishu_record_id: null, feishu_synced_at: null, feishu_sync_error: null };
}

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
  if (res.status !== 200) throw new Error(`configureOwner failed: ${res.status}`);
}

async function publishFormAndGetSlug(): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({
      meta: { title: "存储语义测试表单" },
      fields: [{ id: "f_name", type: "text", label: "姓名" }],
    }),
  });
  if (res.status !== 201) throw new Error(`publishForm failed: ${res.status}`);
  return ((await res.json()) as { slug?: string }).slug as string;
}

const ANSWER = { label: "姓名", value: "张三" };

async function submit(slug: string): Promise<{ status: number; id?: string }> {
  const res = await SELF.fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ formSlug: slug, answers: [ANSWER] }),
  });
  const json = res.status === 200 ? ((await res.json()) as { id?: string }) : {};
  return { status: res.status, id: json.id };
}

describe("submissions storage (workers/features/submissions-storage.feature)", () => {
  let mock: { restore(): void } | undefined;

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

  it("Scenario: 提交先写 D1 主存并返回提交 id", async () => {
    await configureOwner({ feishu: true });
    mock = installFeishuMock({ token: FEISHU_TOKEN_OK_BODY, record: BITABLE_OK_BODY });
    const slug = await publishFormAndGetSlug();
    await settle(); // drain publish pre-create

    const { status, id } = await submit(slug);
    expect(status).toBe(200);
    expect(id).toBeTypeOf("string");

    // D1 主存里存在该提交，且作答与提交内容一致。
    const row = await getRow(id!);
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.answers_json)).toEqual([ANSWER]);
  });

  it("Scenario: 未配飞书时照常落 D1 且回执为空、不向飞书发任何请求", async () => {
    await configureOwner({ feishu: false });
    const slug = await publishFormAndGetSlug();
    // ALL replies forbidden → any feishu call THROWS.
    mock = installFeishuMock({});

    const { status, id } = await submit(slug);
    expect(status).toBe(200);

    await settle();
    const row = await getRow(id!);
    expect(row).not.toBeNull();
    // 飞书回执全空（未同步）。
    expect(row!.feishu_record_id).toBeNull();
    expect(row!.feishu_synced_at).toBeNull();
    expect(row!.feishu_sync_error).toBeNull();
  });

  it("Scenario: 配了飞书且同步成功时回填飞书 record id", async () => {
    await configureOwner({ feishu: true });
    mock = installFeishuMock({ token: FEISHU_TOKEN_OK_BODY, record: BITABLE_OK_BODY });
    const slug = await publishFormAndGetSlug();
    await settle();

    const { status, id } = await submit(slug);
    expect(status).toBe(200);

    const receipt = await waitForSyncSettled(id!);
    expect(receipt.feishu_record_id).toBe(UPSTREAM_RECORD_ID);
    expect(receipt.feishu_synced_at).toBeTypeOf("string");
    expect(receipt.feishu_sync_error).toBeNull();
  });

  it("Scenario: 配了飞书但同步失败时提交仍在 D1 且记下同步错误", async () => {
    await configureOwner({ feishu: true });
    // token exchange returns non-zero code → sync fails before any record write.
    mock = installFeishuMock({ token: FEISHU_TOKEN_BAD_BODY });
    const slug = await publishFormAndGetSlug();
    await settle();

    const { status, id } = await submit(slug);
    expect(status).toBe(200);

    const receipt = await waitForSyncSettled(id!);
    // 提交仍在 D1；记下同步错误（非敏感）；无 record id。
    expect(await getRow(id!)).not.toBeNull();
    expect(receipt.feishu_sync_error).toBeTypeOf("string");
    expect(receipt.feishu_sync_error).not.toContain(OWNER_FEISHU_APP_SECRET);
    expect(receipt.feishu_record_id).toBeNull();
  });

  it("Scenario: 提交后数据后台从 D1 读回这条提交（端到端）", async () => {
    // owner 未配飞书：提交直接落 D1、无后台同步，最贴合「D1 是主存」端到端验证。
    await configureOwner({ feishu: false });
    const slug = await publishFormAndGetSlug();
    mock = installFeishuMock({});

    const { status } = await submit(slug);
    expect(status).toBe(200);

    // owner 带 token 从数据后台读回（D1 读）。
    const res = await SELF.fetch(`${BASE}/api/forms/${slug}/submissions`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      submissions?: Array<{ answers?: Array<{ label: string; value: string | string[] }> }>;
      count?: number;
    };
    expect(body.count).toBe(1);
    expect(body.submissions).toHaveLength(1);
    // 读回的作答与刚提交的内容一致。
    expect(body.submissions![0].answers).toEqual([ANSWER]);
  });
});
