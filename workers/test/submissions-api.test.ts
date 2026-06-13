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

// 架构转向（PR-2）：数据后台 GET /api/forms/:slug/submissions 改从 **D1 主存** 读回提交，
// 不再读飞书。Outer-loop acceptance specs driven through the real Hono app via SELF.fetch.
// Submissions are seeded via the REAL public POST /api/submit (so owner_id is set exactly
// as prod would — by getFormOwner reverse-lookup), then read back via the owner-only GET.
//
// 飞书已降为可选后台同步：unconfigured 的 seeding submit 不发任何飞书请求；为「不泄漏凭据」场景
// 才配飞书（secrets 落 owner_config）并装一个吸收后台同步的 mock——验证 D1 读路径结构上不可能
// 回出 owner_config 里的凭据（它们根本不在 submissions 表）。
//
// Realizes workers/features/submissions.feature（从 D1 主存读回）。Contract: SPEC.md §18.

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

/**
 * A permissive Feishu mock that absorbs the best-effort background sync (token → list →
 * record) so a feishu-configured seeding submit never hits the real network. Returns a
 * restore handle + a `synced()` poller. Throws on any non-Feishu URL (default-deny).
 */
function installFeishuMock(): { restore(): void } {
  const realFetch = globalThis.fetch;
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as RequestInfo, init);
    if (req.url === FEISHU_TENANT_TOKEN_URL) {
      return new Response(FEISHU_TOKEN_OK_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (req.url === BITABLE_URL) {
      return new Response(BITABLE_OK_BODY, {
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
  return { restore: () => (globalThis.fetch = realFetch) };
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
  if (res.status !== 200) {
    throw new Error(`setup configureOwner failed: ${res.status} ${await res.text()}`);
  }
}

async function publishFormAndGetSlug(): Promise<string> {
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
  return json.slug as string;
}

/** Seed one submission via the real public POST /api/submit (owner_id set as prod would). */
async function seedSubmission(slug: string, answers: unknown[]): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ formSlug: slug, answers }),
  });
  if (res.status !== 200) {
    throw new Error(`seed submit failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { id?: string };
  return json.id as string;
}

/** GET the submissions list for a slug, with optional headers (token / none). */
function getSubmissions(slug: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/api/forms/${slug}/submissions`, { headers });
}

interface SubmissionsBody {
  submissions?: Array<{
    id?: string;
    answers?: Array<{ label: string; value: string | string[] }>;
    createdAt?: string;
    feishu?: { recordId: string | null; syncedAt: string | null; error: string | null };
  }>;
  count?: number;
}

describe("submissions GET /api/forms/:slug/submissions (workers/features/submissions.feature)", () => {
  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    await resetSubmissions();
  });

  it("Scenario: 无鉴权访问数据后台返回 401", async () => {
    // Given 一份已发布的表单 (publish needs a token; the read is owner-only).
    token = await login();
    await configureOwner({ feishu: false });
    const slug = await publishFormAndGetSlug();

    // When 未鉴权地请求该表单的提交列表 (no Authorization header)
    const res = await getSubmissions(slug);

    // Then 401
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");
  });

  it("Scenario: 列出该表单已落 D1 的提交并返回 count", async () => {
    // Given 一个已登录的 owner（未配飞书，seeding 不触发任何飞书同步）+ 一份已发布表单 + 两条提交
    token = await login();
    await configureOwner({ feishu: false });
    const slug = await publishFormAndGetSlug();
    await seedSubmission(slug, [{ label: "姓名", value: "张三" }]);
    await seedSubmission(slug, [{ label: "姓名", value: "李四" }]);

    // When owner 带有效 token 请求该表单的提交列表
    const res = await getSubmissions(slug, authHeader(token));

    // Then 200 + 两条提交 + count 2
    expect(res.status).toBe(200);
    const body = (await res.json()) as SubmissionsBody;
    expect(body.submissions).toHaveLength(2);
    for (const sub of body.submissions!) {
      expect(sub.id).toBeTypeOf("string");
      expect(Array.isArray(sub.answers)).toBe(true);
    }
    // 两份作答都在（顺序与插入相关，这里只校验集合包含）。
    const names = body.submissions!.flatMap((s) => s.answers!.map((a) => a.value));
    expect(names).toContain("张三");
    expect(names).toContain("李四");
    expect(body.count).toBe(2);
  });

  it("Scenario: 空表时返回空列表且 count 为 0", async () => {
    token = await login();
    await configureOwner({ feishu: false });
    const slug = await publishFormAndGetSlug();

    const res = await getSubmissions(slug, authHeader(token));

    expect(res.status).toBe(200);
    const body = (await res.json()) as SubmissionsBody;
    expect(body.submissions).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("Scenario: 拉取不存在的 slug 返回 404", async () => {
    token = await login();
    await configureOwner({ feishu: false });

    const res = await getSubmissions("nonexistent-slug-zzz", authHeader(token));

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");
  });

  it("Scenario: owner 未配飞书也能照常读回已落 D1 的提交", async () => {
    // 语义翻转：数据后台读 D1 不依赖飞书配置 —— 未配飞书也照常返回提交（不再 409）。
    token = await login();
    await configureOwner({ feishu: false });
    const slug = await publishFormAndGetSlug();
    await seedSubmission(slug, [{ label: "姓名", value: "王五" }]);

    const res = await getSubmissions(slug, authHeader(token));

    expect(res.status).toBe(200);
    const body = (await res.json()) as SubmissionsBody;
    expect(body.submissions).toHaveLength(1);
    expect(body.count).toBe(1);
  });

  it("Scenario: 整个响应里不含任何明文凭据或 owner_id", async () => {
    // Given owner 配了飞书（secrets 落 owner_config）。装 mock 吸收 seeding submit 的后台同步，
    // 验证「数据后台从 D1 读」结构上不可能回出 owner_config 里的凭据。
    token = await login();
    await configureOwner({ feishu: true });
    const mock = installFeishuMock();
    try {
      const slug = await publishFormAndGetSlug();
      await seedSubmission(slug, [{ label: "姓名", value: "张三" }]);
      await seedSubmission(slug, [{ label: "姓名", value: "李四" }]);
      // Let any background sync drain so it doesn't leak into the next test.
      await sleep(80);

      const res = await getSubmissions(slug, authHeader(token));
      expect(res.status).toBe(200);

      const raw = await res.clone().text();
      // Then 整个响应不含任何明文凭据（它们在 owner_config，不在 submissions 表）。
      expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);
      expect(raw).not.toContain(OWNER_FEISHU_APP_TOKEN);
      expect(raw).not.toContain(OWNER_FEISHU_TABLE_ID);
      expect(raw).not.toContain(OWNER_DEEPSEEK_KEY);
      expect(raw).not.toContain(UPSTREAM_TENANT_TOKEN);
      // And 响应体里不含 owner_id（顶层 + 每条提交）。
      const body = (await res.json()) as SubmissionsBody & Record<string, unknown>;
      expect(Object.keys(body)).not.toContain("owner_id");
      for (const sub of body.submissions ?? []) {
        expect(Object.keys(sub)).not.toContain("owner_id");
      }
      for (const [, value] of res.headers) {
        expect(value).not.toContain(OWNER_FEISHU_APP_SECRET);
        expect(value).not.toContain(UPSTREAM_TENANT_TOKEN);
      }
    } finally {
      mock.restore();
    }
  });
});
