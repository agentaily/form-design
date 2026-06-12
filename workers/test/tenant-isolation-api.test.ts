import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  applySchema,
  resetConfig,
  resetForms,
  resetUsers,
  registerOwner,
  authHeader,
  type TestOwner,
} from "./helpers";
import { FEISHU_BITABLE_RECORDS_URL } from "../src/submit";
import { FEISHU_TENANT_TOKEN_URL } from "../src/feishu";

// Outer-loop acceptance specs for 多租户数据隔离 + 横向越权防护 — the HEAD-PRIORITY
// security suite. Driven through the real Hono app in workerd via SELF.fetch with
// TWO real owners (A & B), each registered with a distinct email and carrying its
// own session token. Realizes every scenario of
// workers/features/tenant-isolation.feature:
//
//   列表 / 配置：互不可见
//     - 两个 owner 的表单列表互不可见
//     - 两个 owner 的集成配置互相隔离
//     - 一个 owner 保存配置不影响另一个 owner 的配置
//   横向越权：A 拿 B 的 slug
//     - A 用 B 的 slug PATCH 改状态 → 404，B 的表单未被改动
//     - A 用 B 的 slug DELETE → 404，B 的表单仍存在
//     - A 用 B 的 slug 看提交 → 404，不读飞书配置 / 不打飞书上游
//     - 跨 owner 的 404 与不存在的 slug 不可区分（不暴露存在性）
//   看提交：读当前 owner 自己的飞书
//     - owner 看提交读的是自己的飞书配置
//   公开 submit：写进 slug 所属 owner 的飞书
//     - 匿名提交写进该 slug 所属 owner 的飞书
//     - 不同 owner 的 slug 各自路由到各自的飞书
//
// 关键安全约定（§17.9）：owner-only 的按 slug 操作，对「slug 不存在」与「slug 存在但
// 不属于你」必须返回同一个 404——绝不用 403 / 不同响应，否则泄漏别人表单的存在性。
//
// Contract: SPEC.md §17.9 (头等越权约束).

const BASE = "https://api.local";

// --- Distinctive per-owner Feishu credentials. The two owners' app_token /
// table_id differ, so the submit-routing scenarios can prove an answer landed in
// the SLUG-OWNER's bitable (their app_token/table_id), not a fixed / wrong owner's.
const A_FEISHU = {
  appId: "cli_OWNER_A_appId_1111",
  appSecret: "feishu-OWNER-A-secret-AAAA-1111",
  appToken: "bascnOWNER_A_appToken",
  tableId: "tblOWNER_A_111",
};
const B_FEISHU = {
  appId: "cli_OWNER_B_appId_2222",
  appSecret: "feishu-OWNER-B-secret-BBBB-2222",
  appToken: "bascnOWNER_B_appToken",
  tableId: "tblOWNER_B_222",
};

const A_DEEPSEEK_KEY = "sk-owner-A-DEEPSEEK-secret-aaaa1111";
const B_DEEPSEEK_KEY = "sk-owner-B-DEEPSEEK-secret-bbbb2222";

const UPSTREAM_TENANT_TOKEN = "t-tenant-access-token-SECRET-9999";
const UPSTREAM_RECORD_ID = "rec-isolation-xxxx";

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
const RECORDS_EMPTY_BODY = JSON.stringify({
  code: 0,
  msg: "success",
  data: { total: 0, items: [] },
});

/** The exact bitable URL for a given owner's app_token / table_id. */
function bitableUrl(feishu: { appToken: string; tableId: string }): string {
  return FEISHU_BITABLE_RECORDS_URL.replace("{app_token}", feishu.appToken).replace(
    "{table_id}",
    feishu.tableId,
  );
}

// --- Feishu fetch mock that records WHICH bitable URL each write hit -----------
//
// The submit / submissions flows exchange app_id/app_secret for a tenant token,
// then write/read at the configured app_token/table_id URL. The mock answers the
// token exchange + ANY bitable record URL, recording every call so we can assert
// the answer landed at the SLUG-OWNER's bitable URL (and crucially NOT the other
// owner's). Default-deny: an unmatched origin throws (no real network).

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

function installFeishuMock(): FeishuMock {
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
      tokenCalls.push(captured);
      return new Response(FEISHU_TOKEN_OK_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Both owners' bitable URLs are accepted and recorded — the assertion is on
    // WHICH one was hit, so we must not pre-restrict to one.
    if (req.url === bitableUrl(A_FEISHU) || req.url === bitableUrl(B_FEISHU)) {
      recordCalls.push(captured);
      const body = req.method === "GET" ? RECORDS_EMPTY_BODY : BITABLE_OK_BODY;
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    // Default-deny: any other outbound fetch is a violation (e.g. routing the
    // answer to a bitable nobody configured) — fail loudly.
    throw new Error(`unexpected outbound fetch to ${req.url}`);
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

// --- per-owner helpers --------------------------------------------------------

/** Save an owner's config via POST /api/config (owner-only — uses their token). */
async function configureOwner(
  token: string,
  cfg: { deepseek?: { apiKey: string }; feishu?: typeof A_FEISHU },
): Promise<void> {
  const res = await SELF.fetch(`${BASE}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(cfg),
  });
  if (res.status !== 200) {
    throw new Error(`setup configureOwner failed: ${res.status} ${await res.text()}`);
  }
}

/** Publish a form as `token`'s owner and return its slug. */
async function publishForm(token: string, title: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({
      meta: { title },
      fields: [{ id: "f_name", type: "text", label: "姓名", required: true }],
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

function listForms(token: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/forms`, { headers: authHeader(token) });
}
function getConfig(token: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/config`, { headers: authHeader(token) });
}
function patchForm(token: string, slug: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/forms/${slug}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
}
function deleteForm(token: string, slug: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/forms/${slug}`, { method: "DELETE", headers: authHeader(token) });
}
function getSubmissions(token: string, slug: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/forms/${slug}/submissions`, { headers: authHeader(token) });
}
// POST /api/submit is PUBLIC (no token).
function postSubmit(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SUBMISSION = { answers: [{ label: "姓名", value: "张三" }] };

describe("tenant isolation + 横向越权 (workers/features/tenant-isolation.feature)", () => {
  let mock: FeishuMock | undefined;

  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    await resetUsers();
  });

  afterEach(() => {
    mock?.restore();
    mock = undefined;
  });

  // --- 列表 / 配置：互不可见 -------------------------------------------------

  it("Scenario: 两个 owner 的表单列表互不可见", async () => {
    // Given owner A 与 owner B 各自注册并登录
    const A = await registerOwner();
    const B = await registerOwner();
    // And A 发布了一份表单 And B 发布了一份表单
    const slugA = await publishForm(A.token, "A 的报名表");
    const slugB = await publishForm(B.token, "B 的报名表");

    // When A 用自己的 token 列出表单
    const res = await listForms(A.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      forms?: Array<{ slug?: string }>;
      count?: number;
    };
    const slugs = (body.forms ?? []).map((f) => f.slug);

    // Then 列表只含 A 自己发布的表单
    expect(slugs).toEqual([slugA]);
    expect(body.count).toBe(1);
    // And 列表不含 B 发布的任何表单
    expect(slugs).not.toContain(slugB);
  });

  it("Scenario: 两个 owner 的集成配置互相隔离", async () => {
    // Given owner A 与 owner B 各自注册并登录
    const A = await registerOwner();
    const B = await registerOwner();
    // And A 保存了自己的 DeepSeek 配置
    await configureOwner(A.token, { deepseek: { apiKey: A_DEEPSEEK_KEY } });

    // When B 用自己的 token 读取集成配置
    const res = await getConfig(B.token);
    expect(res.status).toBe(200);
    const raw = await res.clone().text();
    const view = (await res.json()) as {
      deepseek: { apiKey: string | null; model: string | null };
      updatedAt: string | null;
    };

    // Then B 读到的是 B 自己的配置（A 配置前为未配置的空骨架）
    expect(view.deepseek.apiKey).toBeNull();
    expect(view.updatedAt).toBeNull();
    // And B 读不到 A 的任何配置值 — A's key never surfaces (not even masked) in B's read.
    expect(raw).not.toContain(A_DEEPSEEK_KEY);
  });

  it("Scenario: 一个 owner 保存配置不影响另一个 owner 的配置", async () => {
    // Given owner A 与 owner B 各自注册并登录
    const A = await registerOwner();
    const B = await registerOwner();
    // And A 与 B 各自保存了不同的 DeepSeek 配置 (distinct, recognizable models).
    await configureOwner(A.token, { deepseek: { apiKey: A_DEEPSEEK_KEY } });
    await configureOwner(B.token, { deepseek: { apiKey: B_DEEPSEEK_KEY } });

    // When A 重新读取自己的配置
    const res = await getConfig(A.token);
    expect(res.status).toBe(200);
    const raw = await res.clone().text();
    const view = (await res.json()) as { deepseek: { apiKey: string | null } };

    // Then A 读到的仍是 A 自己保存的那份 (masked key present, updatedAt set).
    expect(view.deepseek.apiKey).toBeTypeOf("string");
    expect(view.deepseek.apiKey).toContain("…");
    // And A 的配置不被 B 的保存覆盖 — A's masked key reflects A's tail (1111), never B's.
    expect(view.deepseek.apiKey).toContain("1111");
    expect(view.deepseek.apiKey).not.toContain("2222");
    // B's plaintext key never bleeds into A's read either.
    expect(raw).not.toContain(B_DEEPSEEK_KEY);
  });

  // --- 横向越权：A 拿 B 的 slug ---------------------------------------------

  it("Scenario: A 用 B 的 slug 改表单状态返回 404", async () => {
    // Given owner A 与 owner B 各自注册并登录 And B 发布了一份表单，得到 slug S
    const A = await registerOwner();
    const B = await registerOwner();
    const slugS = await publishForm(B.token, "B 的待改表单");

    // When A 用自己的 token PATCH slug S 改状态
    const res = await patchForm(A.token, slugS, { status: "closed" });

    // Then 响应状态码为 404 (same code as not-found — no existence leak)
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // And B 的那份表单状态未被改动 — B reads it back and it is STILL published, proving
    // A's cross-owner PATCH touched zero rows.
    const bView = await patchForm(B.token, slugS, {}); // no-op read-back as B
    expect(bView.status).toBe(200);
    expect(((await bView.json()) as { status?: string }).status).toBe("published");
  });

  it("Scenario: A 用 B 的 slug 删表单返回 404", async () => {
    // Given owner A 与 owner B 各自注册并登录 And B 发布了一份表单，得到 slug S
    const A = await registerOwner();
    const B = await registerOwner();
    const slugS = await publishForm(B.token, "B 的待删表单");

    // When A 用自己的 token DELETE slug S
    const res = await deleteForm(A.token, slugS);

    // Then 响应状态码为 404
    expect(res.status).toBe(404);

    // And B 的那份表单仍然存在 — public fetch still 200, and B's list still has it.
    const pub = await SELF.fetch(`${BASE}/api/forms/${slugS}`);
    expect(pub.status).toBe(200);
    const bList = (await (await listForms(B.token)).json()) as { forms?: Array<{ slug?: string }> };
    expect((bList.forms ?? []).map((f) => f.slug)).toContain(slugS);
  });

  it("Scenario: A 用 B 的 slug 看提交返回 404 且不打飞书上游", async () => {
    // Given owner A 与 owner B 各自注册并登录 And B 发布了一份表单，得到 slug S.
    // A configures Feishu so a buggy handler COULD reach upstream with A's creds —
    // the mock would record it. The 404 must short-circuit before any of that.
    const A = await registerOwner();
    const B = await registerOwner();
    await configureOwner(A.token, { deepseek: { apiKey: A_DEEPSEEK_KEY }, feishu: A_FEISHU });
    const slugS = await publishForm(B.token, "B 的提交表单");
    mock = installFeishuMock();

    // When A 用自己的 token 拉取 slug S 的提交列表
    const res = await getSubmissions(A.token, slugS);

    // Then 响应状态码为 404
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // And 没有读取任何飞书配置、没有打飞书上游 — the ownership gate rejected BEFORE
    // reading config / exchanging a token / reading records.
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  it("Scenario: 跨 owner 的 404 与不存在的 slug 不可区分（不暴露存在性）", async () => {
    // Given owner A 与 owner B 各自注册并登录
    // And B 发布了一份表单，得到一个真实存在但归 B 的 slug S
    const A = await registerOwner();
    const B = await registerOwner();
    await configureOwner(A.token, { deepseek: { apiKey: A_DEEPSEEK_KEY }, feishu: A_FEISHU });
    const slugS = await publishForm(B.token, "B 的存在性测试表单");
    const ghostSlug = "definitely-not-a-real-slug-zzz";
    mock = installFeishuMock();

    // When A 分别用一个不存在的 slug 与 B 的真实 slug S 请求 PATCH / DELETE / 看提交
    const patchGhost = await patchForm(A.token, ghostSlug, { status: "closed" });
    const patchReal = await patchForm(A.token, slugS, { status: "closed" });
    const delGhost = await deleteForm(A.token, ghostSlug);
    const delReal = await deleteForm(A.token, slugS);
    const subGhost = await getSubmissions(A.token, ghostSlug);
    const subReal = await getSubmissions(A.token, slugS);

    // Then 两种情况都返回 404
    for (const r of [patchGhost, patchReal, delGhost, delReal, subGhost, subReal]) {
      expect(r.status).toBe(404);
    }

    // And 两种情况的响应不可区分（不泄漏 S 确实存在）— identical status AND body for the
    // cross-owner real slug vs the truly-nonexistent slug, on EACH endpoint. A 403 /
    // different message / different code on the real-but-not-yours slug would leak
    // "this slug exists, just not yours" (§17.9).
    expect(patchReal.status).toBe(patchGhost.status);
    expect(await patchReal.text()).toBe(await patchGhost.text());
    expect(delReal.status).toBe(delGhost.status);
    expect(await delReal.text()).toBe(await delGhost.text());
    expect(subReal.status).toBe(subGhost.status);
    expect(await subReal.text()).toBe(await subGhost.text());

    // And neither path touched Feishu (the ownership/existence gate is upstream of it).
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.recordCalls).toHaveLength(0);
  });

  // --- 看提交：读当前 owner 自己的飞书 --------------------------------------

  it("Scenario: owner 看提交读的是自己的飞书配置", async () => {
    // Given owner A 注册并登录 And A 配好了自己的飞书并发布了一份表单. B exists with a
    // DIFFERENT Feishu config — a buggy "read any owner's creds" handler could pick
    // B's; the mock proves the read went to A's bitable URL, not B's.
    const A = await registerOwner();
    const B = await registerOwner();
    await configureOwner(A.token, { deepseek: { apiKey: A_DEEPSEEK_KEY }, feishu: A_FEISHU });
    await configureOwner(B.token, { deepseek: { apiKey: B_DEEPSEEK_KEY }, feishu: B_FEISHU });
    const slugA = await publishForm(A.token, "A 的提交表单");
    mock = installFeishuMock();

    // When A 拉取自己那份表单的提交列表
    const res = await getSubmissions(A.token, slugA);
    expect(res.status).toBe(200);

    // Then 后端用 A 自己的飞书凭据去拉记录 — token exchange carried A's app_id/app_secret,
    // and the record read hit A's app_token/table_id URL.
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.tokenCalls[0].body).toMatchObject({
      app_id: A_FEISHU.appId,
      app_secret: A_FEISHU.appSecret,
    });
    expect(mock.recordCalls).toHaveLength(1);
    expect(mock.recordCalls[0].url).toBe(bitableUrl(A_FEISHU));
    // And 绝不使用其它 owner 的飞书凭据 — never B's URL / app_secret anywhere.
    expect(mock.recordCalls[0].url).not.toBe(bitableUrl(B_FEISHU));
    const allBodies = [...mock.tokenCalls, ...mock.recordCalls].map((c) => c.bodyText).join("\n");
    expect(allBodies).not.toContain(B_FEISHU.appSecret);
  });

  // --- 公开 submit：写进 slug 所属 owner 的飞书 ------------------------------

  it("Scenario: 匿名提交写进该 slug 所属 owner 的飞书", async () => {
    // Given owner A 与 owner B 各自注册并登录 And A 与 B 各配好了自己的飞书
    // And A 发布了一份表单，得到 slug SA
    const A = await registerOwner();
    const B = await registerOwner();
    await configureOwner(A.token, { deepseek: { apiKey: A_DEEPSEEK_KEY }, feishu: A_FEISHU });
    await configureOwner(B.token, { deepseek: { apiKey: B_DEEPSEEK_KEY }, feishu: B_FEISHU });
    const slugSA = await publishForm(A.token, "A 的公开表单");
    mock = installFeishuMock();

    // When 一个匿名答题者向 slug SA 提交一份作答 (PUBLIC — no token)
    const res = await postSubmit({ formSlug: slugSA, ...SUBMISSION });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);

    // Then 这份作答写进 A（slug SA 所属 owner）的飞书表 — the token exchange used A's
    // app_secret and the record write hit A's bitable URL.
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.tokenCalls[0].body).toMatchObject({
      app_id: A_FEISHU.appId,
      app_secret: A_FEISHU.appSecret,
    });
    expect(mock.recordCalls).toHaveLength(1);
    expect(mock.recordCalls[0].url).toBe(bitableUrl(A_FEISHU));
    // And 这份作答绝不写进 B 或任何其它 owner 的飞书表.
    expect(mock.recordCalls[0].url).not.toBe(bitableUrl(B_FEISHU));
    const allBodies = [...mock.tokenCalls, ...mock.recordCalls].map((c) => c.bodyText).join("\n");
    expect(allBodies).not.toContain(B_FEISHU.appSecret);
  });

  it("Scenario: 不同 owner 的 slug 各自路由到各自的飞书", async () => {
    // Given owner A 与 owner B 各自注册并登录
    // And A 与 B 各配好了自己的飞书、各发布一份表单（slug SA / slug SB）
    const A = await registerOwner();
    const B = await registerOwner();
    await configureOwner(A.token, { deepseek: { apiKey: A_DEEPSEEK_KEY }, feishu: A_FEISHU });
    await configureOwner(B.token, { deepseek: { apiKey: B_DEEPSEEK_KEY }, feishu: B_FEISHU });
    const slugSA = await publishForm(A.token, "A 路由表单");
    const slugSB = await publishForm(B.token, "B 路由表单");
    mock = installFeishuMock();

    // When 匿名答题者分别向 SA 与 SB 各提交一份作答
    const resA = await postSubmit({ formSlug: slugSA, ...SUBMISSION });
    const resB = await postSubmit({ formSlug: slugSB, ...SUBMISSION });
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Then 向 SA 的作答写进 A 的飞书 And 向 SB 的作答写进 B 的飞书 — exactly two record
    // writes, one to A's bitable URL and one to B's, each via the matching app_secret.
    expect(mock.recordCalls).toHaveLength(2);
    const recordUrls = mock.recordCalls.map((c) => c.url).sort();
    expect(recordUrls).toEqual([bitableUrl(A_FEISHU), bitableUrl(B_FEISHU)].sort());

    // The token exchanges used BOTH owners' distinct app_secrets (one each), proving
    // each slug routed to its own owner's tenant — never a single shared owner.
    const tokenSecrets = mock.tokenCalls.map((c) => (c.body as { app_secret?: string }).app_secret);
    expect(tokenSecrets).toContain(A_FEISHU.appSecret);
    expect(tokenSecrets).toContain(B_FEISHU.appSecret);
  });
});
