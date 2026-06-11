import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sign as honoSign } from "hono/jwt";
import { applySchema, resetConfig, resetForms, testEnv, login, authHeader } from "./helpers";

// Outer-loop acceptance specs for owner 鉴权, driven through the real Hono app in
// workerd via SELF.fetch. Realizes every scenario of workers/features/auth.feature:
//   1. 正确密码登录得到 token
//   2. 错误密码登录返回 401（无 token）
//   3. 缺少 password 字段登录返回 401（无 token）
//   4. 登录响应里不含 owner 密码与签名密钥
//   5. 不带 token 访问 owner-only 端点 → 401，业务逻辑未执行
//   6. 带无效 token 访问 owner-only 端点 → 401，业务逻辑未执行
//   7. 带过期 token 访问 owner-only 端点 → 401，业务逻辑未执行
//   8. 带有效 token 访问 owner-only 端点 → 通过，进入业务逻辑
//   9. 公开端点无需 token 即可访问（GET /api/forms/:slug）
//  10. 401 错误响应里不泄漏签名密钥
//
// Representative owner-only endpoint under test: GET /api/config. Its 200 path
// returns the masked-config view (the business logic), so a 401 with that view
// ABSENT is observable proof the handler was never reached (§17.4). For the
// "valid token passes" / leak scans we seed a config so the handler has a
// distinctive, non-empty body to look for.
//
// Contract: SPEC.md §17 (后端 · owner 鉴权).

const BASE = "https://api.local";

// The fixed test secrets injected as miniflare bindings (vitest.config.ts §17.6).
// They must NEVER appear in any login / 401 response (§17.7), so we scan for them.
const OWNER_PASSWORD = testEnv.OWNER_PASSWORD;
const AUTH_SECRET = testEnv.AUTH_SECRET;
const WRONG_PASSWORD = "definitely-not-the-owner-password-xxxx";

// A distinctive DeepSeek model string we seed via POST /api/config (with a valid
// token), so the GET /api/config success body is recognizably non-empty — letting
// us assert "business logic ran" (model echoed) vs "401, handler skipped".
const SEEDED_MODEL = "deepseek-chat-AUTHPROBE-marker";
const SEEDED_KEY = "sk-authprobe-DEEPSEEK-secret-0123456789";

function postLogin(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** GET /api/config (owner-only) with an optional Authorization header. */
function getConfig(headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/api/config`, { headers });
}

/** Seed an owner config via POST /api/config (owner-only — needs the token). */
async function seedConfig(token: string): Promise<void> {
  const res = await SELF.fetch(`${BASE}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ deepseek: { apiKey: SEEDED_KEY, model: SEEDED_MODEL } }),
  });
  if (res.status !== 200) {
    throw new Error(`setup seedConfig failed: ${res.status} ${await res.text()}`);
  }
}

/** Publish a form (owner-only) and return its public slug for the public-fetch scenario. */
async function publishForm(token: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ meta: { title: "鉴权测试表单" }, fields: [] }),
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

describe("owner auth (workers/features/auth.feature)", () => {
  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
  });

  it("Scenario: 正确密码登录得到 token", async () => {
    // Given 一个配置了 owner 密码的后端 (OWNER_PASSWORD injected as a binding)
    // When owner 用正确的密码请求登录
    const res = await postLogin({ password: OWNER_PASSWORD });

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { token?: string };
    // And 响应体带有一个非空的 token
    expect(body.token).toBeTypeOf("string");
    expect(body.token && body.token.length).toBeGreaterThan(0);
    // A JWT has three dot-separated segments — sanity that it's a signed token.
    expect(body.token!.split(".")).toHaveLength(3);
  });

  it("Scenario: 错误密码登录返回 401", async () => {
    // Given 一个配置了 owner 密码的后端
    // When owner 用错误的密码请求登录
    const res = await postLogin({ password: WRONG_PASSWORD });

    // Then 响应状态码为 401
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { token?: string; error?: string };
    // And 没有签发任何 token
    expect(body.token).toBeUndefined();
    expect(body.error).toBeTypeOf("string");
  });

  it("Scenario: 缺少密码字段登录返回 401", async () => {
    // Given 一个配置了 owner 密码的后端
    // When owner 提交缺少 password 字段的登录请求
    const res = await postLogin({ notTheField: "x" });

    // Then 响应状态码为 401 (统一 401，不区分密码错 / 缺字段，§17.2)
    expect(res.status).toBe(401);
    const body = (await res.json()) as { token?: string; error?: string };
    // And 没有签发任何 token
    expect(body.token).toBeUndefined();
    expect(body.error).toBeTypeOf("string");
  });

  it("Scenario: 登录响应里不含 owner 密码与签名密钥", async () => {
    // Given 一个配置了 owner 密码的后端
    // When owner 用正确的密码请求登录
    const res = await postLogin({ password: OWNER_PASSWORD });
    expect(res.status).toBe(200);

    // Scan the ENTIRE raw response (body + every header).
    const raw = await res.clone().text();
    // Then 整个响应里不包含 owner 登录密码
    expect(raw).not.toContain(OWNER_PASSWORD);
    // And 整个响应里不包含 JWT 签名密钥
    expect(raw).not.toContain(AUTH_SECRET);
    for (const [, value] of res.headers) {
      expect(value).not.toContain(OWNER_PASSWORD);
      expect(value).not.toContain(AUTH_SECRET);
    }
  });

  it("Scenario: 不带 token 访问 owner-only 端点返回 401", async () => {
    // Seed a config WITH a valid token first, so that — had the unauthenticated
    // request actually reached the handler — its body would echo SEEDED_MODEL.
    // Its absence below proves the business logic was never executed.
    const token = await login();
    await seedConfig(token);

    // When 未鉴权地请求一个 owner-only 端点 (no Authorization header)
    const res = await getConfig();

    // Then 响应状态码为 401
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const raw = await res.clone().text();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");
    // And 该 owner-only 端点的业务逻辑没有被执行 — the masked-config view (which
    // would carry the seeded model) is absent from the 401 body.
    expect(raw).not.toContain(SEEDED_MODEL);
  });

  it("Scenario: 带无效 token 访问 owner-only 端点返回 401", async () => {
    // Given 一个配置了 owner 密码的后端 (+ seeded config to detect handler entry)
    const token = await login();
    await seedConfig(token);

    // When 带一个伪造或无法验签的 token 请求一个 owner-only 端点
    const res = await getConfig(authHeader("not.a.valid-jwt-signature"));

    // Then 响应状态码为 401
    expect(res.status).toBe(401);
    const raw = await res.clone().text();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");
    // And 该 owner-only 端点的业务逻辑没有被执行
    expect(raw).not.toContain(SEEDED_MODEL);
  });

  it("Scenario: 带过期 token 访问 owner-only 端点返回 401", async () => {
    // Given 一个配置了 owner 密码的后端 (+ seeded config to detect handler entry)
    const goodToken = await login();
    await seedConfig(goodToken);

    // And 一个已过期的 session token — signed with the REAL test AUTH_SECRET but
    // with exp in the past, so only the 未过期 check can reject it (§17.4).
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = await honoSign({ sub: "default", exp: past }, AUTH_SECRET, "HS256");

    // When 带该过期 token 请求一个 owner-only 端点
    const res = await getConfig(authHeader(expired));

    // Then 响应状态码为 401
    expect(res.status).toBe(401);
    const raw = await res.clone().text();
    // And 该 owner-only 端点的业务逻辑没有被执行
    expect(raw).not.toContain(SEEDED_MODEL);
  });

  it("Scenario: 带有效 token 访问 owner-only 端点通过鉴权", async () => {
    // Given 一个配置了 owner 密码的后端
    // And owner 已用正确密码登录拿到 token
    const token = await login();
    await seedConfig(token);

    // When 带该有效 token 请求一个 owner-only 端点
    const res = await getConfig(authHeader(token));

    // Then 鉴权通过且请求进入该端点的业务逻辑 — 200 with the masked-config view,
    // echoing the seeded (plaintext, non-secret) model: proof the handler ran.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deepseek?: { model?: string | null };
    };
    expect(body.deepseek?.model).toBe(SEEDED_MODEL);
  });

  it("Scenario: 公开端点无需 token 即可访问", async () => {
    // Given 一份已发布的表单 (publish needs an owner token; the public FETCH does not)
    const token = await login();
    const slug = await publishForm(token);

    // When 答题者无鉴权地拉取该 slug 对应的表单 (no Authorization header)
    const res = await SELF.fetch(`${BASE}/api/forms/${slug}`);

    // Then 鉴权通过且请求进入该端点的业务逻辑 — the public GET returns the form,
    // NOT a 401. The shared /api/forms prefix must not drag the public read behind auth.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug?: string; meta?: { title?: string } };
    expect(body.slug).toBe(slug);
    expect(body.meta?.title).toBe("鉴权测试表单");
  });

  it("Scenario: 401 错误响应里不泄漏签名密钥", async () => {
    // Given 一个配置了 owner 密码的后端
    // When 带一个伪造或无法验签的 token 请求一个 owner-only 端点
    const res = await getConfig(authHeader("forged.jwt.token-cannot-verify"));

    // Then 响应状态码为 401
    expect(res.status).toBe(401);
    // And 整个响应里不包含 JWT 签名密钥
    const raw = await res.clone().text();
    expect(raw).not.toContain(AUTH_SECRET);
    for (const [, value] of res.headers) {
      expect(value).not.toContain(AUTH_SECRET);
    }
  });
});
