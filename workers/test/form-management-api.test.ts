import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applySchema, resetConfig, resetForms, login, authHeader } from "./helpers";

// Outer-loop acceptance specs for §21 表单管理 CRUD (owner-only: 列表 / 改状态 /
// 删除), driven through the real Hono app via SELF.fetch. Realizes every scenario
// of workers/features/form-management.feature:
//   1. GET /api/forms 列表（含 status；不含 fields 全量 / 任何凭据；count 对）
//   2. 列表不泄漏 owner 凭据
//   3. 无 token 列表 → 401
//   4. PATCH 改 closed → 200 + status=closed
//   5. PATCH 改回 published → 200 + status=published
//   6. PATCH 不存在 slug → 404
//   7. PATCH 非法 status → 400
//   8. 无 token PATCH → 401
//   9. DELETE → 200，删后公开拉取 404
//  10. DELETE 不存在 → 404
//  11. 无 token DELETE → 401
//  12. 删一份不影响另一份（公开拉取仍 200）
//  13. 列表的 guard 不影响公开拉取（GET /api/forms/:slug 仍 200）
//
// 路由共存陷阱（§21.1）：GET /api/forms（owner-only 列表）与 GET /api/forms/:slug
// （公开拉取）是两条路由——guard 只能挂前者。本套件显式回归公开拉取仍 200。
//
// Contract: SPEC.md §21.

const BASE = "https://api.local";

// owner 凭据 fixtures：用于「列表不泄漏凭据」扫描（distinctive + long）。
const OWNER_DEEPSEEK_KEY = "sk-owner-DEEPSEEK-secret-0123456789abcdef";
const OWNER_FEISHU_APP_SECRET = "feishu-APP-SECRET-qrstuvwxyz-7777-SHHH";

let token: string;

async function configureOwner(): Promise<void> {
  const res = await SELF.fetch(`${BASE}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({
      deepseek: { apiKey: OWNER_DEEPSEEK_KEY, model: "deepseek-chat" },
      feishu: {
        appId: "cli_fixtureAppId9999",
        appSecret: OWNER_FEISHU_APP_SECRET,
        appToken: "bascnFixtureAppTokenXYZ",
        tableId: "tblFixture123",
      },
    }),
  });
  if (res.status !== 200) {
    throw new Error(`setup configureOwner failed: ${res.status} ${await res.text()}`);
  }
}

/** Publish a form (owner-only) with a distinct title and return its slug. */
async function publishForm(title: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({
      meta: { title },
      fields: [{ id: "f_name", type: "text", label: "姓名" }],
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

/** GET /api/forms (owner-only list) with optional headers. */
function getForms(headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/api/forms`, { headers });
}

/** PATCH /api/forms/:slug with optional headers + body. */
function patchForm(
  slug: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(`${BASE}/api/forms/${slug}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** DELETE /api/forms/:slug with optional headers. */
function deleteForm(slug: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/api/forms/${slug}`, { method: "DELETE", headers });
}

/** GET /api/forms/:slug — PUBLIC 公开拉取 (no token). */
function getPublicForm(slug: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/forms/${slug}`);
}

describe("form management CRUD (workers/features/form-management.feature)", () => {
  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    token = await login();
  });

  // --- GET /api/forms 列表 ---------------------------------------------------

  it("Scenario: owner 列出自己发布的表单", async () => {
    // Given owner 已登录拿 token And 已发布两份表单
    const slugA = await publishForm("报名表 A");
    const slugB = await publishForm("报名表 B");

    // When owner 带 token 请求列表
    const res = await getForms(authHeader(token));

    // Then 200 + forms 含这两份 + 每项带 slug/meta/status + count 对
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      forms?: Array<{ slug?: string; meta?: { title?: string }; status?: string }>;
      count?: number;
    };
    expect(Array.isArray(body.forms)).toBe(true);
    expect(body.count).toBe(2);
    expect(body.forms).toHaveLength(2);

    const bySlug = new Map((body.forms ?? []).map((f) => [f.slug, f]));
    expect(bySlug.has(slugA)).toBe(true);
    expect(bySlug.has(slugB)).toBe(true);
    for (const f of body.forms ?? []) {
      expect(f.slug).toBeTypeOf("string");
      expect(f.meta?.title).toBeTypeOf("string");
      expect(f.status).toBe("published"); // 发布即 published（§16.7）
    }
  });

  it("Scenario: 列表项不含 fields 全量与任何 owner 凭据", async () => {
    // Given owner 已保存 DeepSeek key + 完整飞书凭据 And 已发布一份表单
    await configureOwner();
    await publishForm("含凭据扫描的表单");

    // When owner 带 token 请求列表
    const res = await getForms(authHeader(token));
    expect(res.status).toBe(200);

    const raw = await res.clone().text();
    // 整个响应不含任何明文凭据（凭据在 owner_config，不在 forms 表，§21.2）。
    expect(raw).not.toContain(OWNER_DEEPSEEK_KEY);
    expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);

    const body = (await res.json()) as { forms?: Array<Record<string, unknown>> };
    // 列表项不含 fields 全量（概览，详情走 GET /api/forms/:slug，§21.2）。
    for (const f of body.forms ?? []) {
      expect(Object.keys(f)).not.toContain("fields");
    }
  });

  it("Scenario: 不带 token 请求列表返回 401", async () => {
    // When 未鉴权地请求列表
    const res = await getForms();
    // Then 401
    expect(res.status).toBe(401);
  });

  // --- PATCH /api/forms/:slug 改状态 -----------------------------------------

  it("Scenario: owner 把表单状态改为 closed", async () => {
    // Given owner 已发布一份 published 的表单
    const slug = await publishForm("待关闭的表单");

    // When owner 带 token 把 status 改为 closed
    const res = await patchForm(slug, { status: "closed" }, authHeader(token));

    // Then 200 + status 变为 closed
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string; slug?: string };
    expect(body.status).toBe("closed");
  });

  it("Scenario: owner 把已关闭表单重新开放为 published", async () => {
    // Given 一份 closed 的表单（先发布再 PATCH 成 closed）
    const slug = await publishForm("待重开的表单");
    const closeRes = await patchForm(slug, { status: "closed" }, authHeader(token));
    expect(closeRes.status).toBe(200);

    // When owner 带 token 把 status 改为 published
    const res = await patchForm(slug, { status: "published" }, authHeader(token));

    // Then 200 + status 变为 published
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe("published");
  });

  it("Scenario: PATCH 不存在的 slug 返回 404", async () => {
    // Given 一个从未发布过的 slug
    const res = await patchForm("nonexistent-slug-zzz", { status: "closed" }, authHeader(token));
    // Then 404
    expect(res.status).toBe(404);
  });

  it("Scenario: PATCH 非法的 status 值返回 400", async () => {
    const slug = await publishForm("非法 status 测试");
    // When 改成乱值
    const bogus = await patchForm(slug, { status: "open" }, authHeader(token));
    expect(bogus.status).toBe(400);
    // And 改成 draft（PATCH 不允许回退草稿，§21.3）也是 400
    const draft = await patchForm(slug, { status: "draft" }, authHeader(token));
    expect(draft.status).toBe(400);
  });

  it("Scenario: 不带 token 请求 PATCH 返回 401", async () => {
    // Given owner 已发布一份表单
    const slug = await publishForm("无 token PATCH 测试");
    // When 未鉴权地 PATCH
    const res = await patchForm(slug, { status: "closed" });
    // Then 401
    expect(res.status).toBe(401);
  });

  // --- DELETE /api/forms/:slug -----------------------------------------------

  it("Scenario: owner 删除一份表单", async () => {
    // Given owner 已发布一份表单
    const slug = await publishForm("待删除的表单");

    // When owner 带 token 删除该表单
    const res = await deleteForm(slug, authHeader(token));
    // Then 200
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; slug?: string };
    expect(body.ok).toBe(true);

    // And 之后公开拉取该 slug 返回 404
    const pub = await getPublicForm(slug);
    expect(pub.status).toBe(404);
  });

  it("Scenario: 删除不存在的 slug 返回 404", async () => {
    const res = await deleteForm("nonexistent-slug-zzz", authHeader(token));
    expect(res.status).toBe(404);
  });

  it("Scenario: 不带 token 请求删除返回 401", async () => {
    // Given owner 已发布一份表单
    const slug = await publishForm("无 token DELETE 测试");
    // When 未鉴权地删除
    const res = await deleteForm(slug);
    // Then 401
    expect(res.status).toBe(401);
  });

  it("Scenario: 删除表单不影响公开拉取其它表单", async () => {
    // Given owner 已发布两份表单
    const slugA = await publishForm("将被删除的表单");
    const slugB = await publishForm("应当保留的表单");

    // When owner 删除其中一份
    const del = await deleteForm(slugA, authHeader(token));
    expect(del.status).toBe(200);

    // Then 另一份表单的公开拉取仍返回 200
    const pubB = await getPublicForm(slugB);
    expect(pubB.status).toBe(200);
    // 而被删的那份已 404（确认删除真正生效，避免空洞通过）。
    const pubA = await getPublicForm(slugA);
    expect(pubA.status).toBe(404);
  });

  // --- 路由共存回归（§21.1）-------------------------------------------------

  it("Scenario: 列表的 guard 不影响公开拉取", async () => {
    // Given 一份已发布的表单
    const slug = await publishForm("公开拉取回归表单");

    // When 答题者无鉴权地拉取该 slug 对应的表单
    const res = await getPublicForm(slug);

    // Then 200 —— GET /api/forms（列表 guard）没有罩住 GET /api/forms/:slug（公开）。
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug?: string; meta?: unknown; fields?: unknown };
    expect(body.slug).toBe(slug);
    expect(body.meta).toBeTypeOf("object");
    expect(Array.isArray(body.fields)).toBe(true);
  });
});
