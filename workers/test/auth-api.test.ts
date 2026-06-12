import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sign as honoSign } from "hono/jwt";
import {
  applySchema,
  resetConfig,
  resetForms,
  resetUsers,
  testEnv,
  uniqueEmail,
  registerOwner,
  authHeader,
  TEST_PASSWORD,
} from "./helpers";

// Outer-loop acceptance specs for owner 鉴权 (open-registration multi-user), driven
// through the real Hono app in workerd via SELF.fetch. Realizes every scenario of
// workers/features/auth.feature:
//   注册（POST /api/auth/register）
//     - 邮箱 + 密码注册成功得到 token（注册即登录），token.sub 是新用户的真实 id
//     - 注册已占用邮箱 → 409，不新建用户、不签 token
//     - 弱密码（< 8）→ 400，不新建用户
//     - 邮箱形状非法 → 400，不新建用户
//     - 注册响应不含明文密码与签名密钥
//   登录（POST /api/auth/login）
//     - 已注册用户用邮箱 + 密码登录 → 200，token.sub 是该用户真实 id
//     - 错误密码 → 统一 401，不签 token
//     - 邮箱未注册 → 统一 401，与「密码错误」不可区分，不签 token
//     - 缺字段 → 401，不签 token
//     - 登录响应不含明文密码与签名密钥
//   owner-only 端点保护（不变的鉴权门）
//     - 无 token / 无效 token / 过期 token → 401，业务逻辑未执行
//     - 有效 token → 通过，进入业务逻辑
//     - 公开端点无需 token（GET /api/forms/:slug）
//     - 401 响应不泄漏签名密钥
//
// Representative owner-only endpoint under test: GET /api/config. Its 200 path
// returns the masked-config view (the business logic), so a 401 with that view
// ABSENT is observable proof the handler was never reached. For the "valid token
// passes" / leak scans we seed a config so the handler has a distinctive, non-empty
// body to look for.
//
// Contract: SPEC.md §17 (后端 · owner 鉴权：多用户注册登录).

const BASE = "https://api.local";

// The fixed test signing secret injected as a miniflare binding (vitest.config.ts).
// It must NEVER appear in any register / login / 401 response (§17.6), so we scan.
const AUTH_SECRET = testEnv.AUTH_SECRET;

// A distinctive DeepSeek model string we seed via POST /api/config (with a valid
// token), so the GET /api/config success body is recognizably non-empty — letting
// us assert "business logic ran" (model echoed) vs "401, handler skipped".
const SEEDED_MODEL = "deepseek-chat-AUTHPROBE-marker";
const SEEDED_KEY = "sk-authprobe-DEEPSEEK-secret-0123456789";

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

function postRegister(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

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

/** Count rows in the users table (asserts 新建 / 不新建 user). */
async function usersRowCount(): Promise<number> {
  const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

describe("owner auth (workers/features/auth.feature)", () => {
  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    await resetUsers();
  });

  // --- 注册（POST /api/auth/register）---------------------------------------

  it("Scenario: 用邮箱 + 密码注册成功得到 token（注册即登录）", async () => {
    // Given 一个开放注册的后端 (clean users table in beforeEach)
    // When 访客用一个未注册的合法邮箱与一个 8 位及以上的密码请求注册
    const email = uniqueEmail();
    const res = await postRegister({ email, password: TEST_PASSWORD });

    // Then 响应状态码为 201
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { token?: string };
    // And 响应体带有一个非空的 token (a 3-segment signed JWT)
    expect(body.token).toBeTypeOf("string");
    expect(body.token && body.token.length).toBeGreaterThan(0);
    expect(body.token!.split(".")).toHaveLength(3);

    // And 该 token 的主体是新建用户的真实 user id — a UUID, not 'default'. It must
    // equal the row's id (the data-isolation key), proving 注册即登录 binds the token
    // to the freshly created account.
    const sub = decodeJwtSub(body.token!);
    expect(sub).not.toBe("default");
    expect(sub).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const userId = await testEnv.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind(email)
      .first<{ id: string }>();
    expect(sub).toBe(userId?.id);
  });

  it("Scenario: 注册一个已被占用的邮箱返回 409", async () => {
    // Given 一个已注册了某邮箱的后端
    const email = uniqueEmail();
    expect((await postRegister({ email, password: TEST_PASSWORD })).status).toBe(201);
    expect(await usersRowCount()).toBe(1);

    // When 访客用同一个邮箱再次请求注册 (a DIFFERENT password — email is the de-dup key)
    const res = await postRegister({ email, password: "another-strong-password-2" });

    // Then 响应状态码为 409
    expect(res.status).toBe(409);
    const body = (await res.json()) as { token?: string; error?: string };
    expect(body.error).toBeTypeOf("string");
    // And 没有签发任何 token
    expect(body.token).toBeUndefined();
    // And 没有新建任何用户 (still exactly the one from the first register)
    expect(await usersRowCount()).toBe(1);
  });

  it("Scenario: 注册时密码过弱返回 400", async () => {
    // When 访客用一个少于 8 位的密码请求注册
    const res = await postRegister({ email: uniqueEmail(), password: "short" });

    // Then 响应状态码为 400
    expect(res.status).toBe(400);
    const body = (await res.json()) as { token?: string; error?: string };
    expect(body.error).toBeTypeOf("string");
    expect(body.token).toBeUndefined();
    // And 没有新建任何用户
    expect(await usersRowCount()).toBe(0);
  });

  it("Scenario: 注册时邮箱形状非法返回 400", async () => {
    // When 访客用一个形状非法的邮箱请求注册 (no @, not an email)
    const res = await postRegister({ email: "not-an-email", password: TEST_PASSWORD });

    // Then 响应状态码为 400
    expect(res.status).toBe(400);
    const body = (await res.json()) as { token?: string; error?: string };
    expect(body.error).toBeTypeOf("string");
    expect(body.token).toBeUndefined();
    // And 没有新建任何用户
    expect(await usersRowCount()).toBe(0);
  });

  it("Scenario: 注册响应里不含明文密码与签名密钥", async () => {
    // When 访客成功注册 (a distinctive password we then scan for)
    const password = "PLAINTEXT-secret-register-zzz-9999";
    const res = await postRegister({ email: uniqueEmail(), password });
    expect(res.status).toBe(201);

    // Scan the ENTIRE raw response (body + every header).
    const raw = await res.clone().text();
    // Then 整个响应里不包含注册时提交的明文密码
    expect(raw).not.toContain(password);
    // And 整个响应里不包含 JWT 签名密钥
    expect(raw).not.toContain(AUTH_SECRET);
    for (const [, value] of res.headers) {
      expect(value).not.toContain(password);
      expect(value).not.toContain(AUTH_SECRET);
    }
  });

  // --- 登录（POST /api/auth/login）------------------------------------------

  it("Scenario: 已注册用户用邮箱 + 密码登录得到 token", async () => {
    // Given 一个已注册了某邮箱与密码的后端
    const email = uniqueEmail();
    const reg = await postRegister({ email, password: TEST_PASSWORD });
    const registeredSub = decodeJwtSub(((await reg.json()) as { token: string }).token);

    // When 该用户用正确的邮箱与密码请求登录
    const res = await postLogin({ email, password: TEST_PASSWORD });

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string };
    // And 响应体带有一个非空的 token
    expect(body.token).toBeTypeOf("string");
    expect(body.token!.split(".")).toHaveLength(3);
    // And 该 token 的主体是该用户的真实 user id — the SAME id register issued, so the
    // login token isolates data to the same account.
    expect(decodeJwtSub(body.token!)).toBe(registeredSub);
  });

  it("Scenario: 密码错误登录返回统一 401", async () => {
    // Given 一个已注册了某邮箱与密码的后端
    const email = uniqueEmail();
    expect((await postRegister({ email, password: TEST_PASSWORD })).status).toBe(201);

    // When 该用户用正确邮箱但错误密码请求登录
    const res = await postLogin({ email, password: "definitely-the-wrong-password-x" });

    // Then 响应状态码为 401
    expect(res.status).toBe(401);
    const body = (await res.json()) as { token?: string; error?: string };
    expect(body.error).toBeTypeOf("string");
    // And 没有签发任何 token
    expect(body.token).toBeUndefined();
  });

  it("Scenario: 邮箱未注册登录返回统一 401（不暴露邮箱是否存在）", async () => {
    // Given 一个已注册了某邮箱与密码的后端 (so we have a real 'wrong password' baseline)
    const email = uniqueEmail();
    expect((await postRegister({ email, password: TEST_PASSWORD })).status).toBe(201);

    // The wrong-password response (registered email, bad password).
    const wrongPwRes = await postLogin({ email, password: "the-wrong-password-yyy" });
    expect(wrongPwRes.status).toBe(401);
    const wrongPwBody = await wrongPwRes.clone().text();

    // When 访客用一个从未注册的邮箱请求登录
    const ghostRes = await postLogin({ email: uniqueEmail("ghost"), password: TEST_PASSWORD });

    // Then 响应状态码为 401
    expect(ghostRes.status).toBe(401);
    const ghostBody = await ghostRes.clone().text();
    const json = (await ghostRes.json()) as { token?: string };
    // And 没有签发任何 token
    expect(json.token).toBeUndefined();
    // And 错误响应与「密码错误」时不可区分 — identical status AND body, so latency aside
    // (the decoy-hash timing equalization lives in the impl) nothing observable
    // distinguishes 邮箱不存在 from 密码错误 (§17.3 anti-enumeration).
    expect(ghostRes.status).toBe(wrongPwRes.status);
    expect(ghostBody).toBe(wrongPwBody);
  });

  it("Scenario: 缺少字段登录返回 401", async () => {
    // When 用户提交缺少 email 或 password 字段的登录请求
    const missingEmail = await postLogin({ password: TEST_PASSWORD });
    const missingPassword = await postLogin({ email: uniqueEmail() });

    // Then 响应状态码为 401 (统一 401，不区分缺字段 / 密码错，§17.3)
    expect(missingEmail.status).toBe(401);
    expect(missingPassword.status).toBe(401);
    // And 没有签发任何 token
    expect(((await missingEmail.json()) as { token?: string }).token).toBeUndefined();
    expect(((await missingPassword.json()) as { token?: string }).token).toBeUndefined();
  });

  it("Scenario: 登录响应里不含明文密码与签名密钥", async () => {
    // Given 一个已注册了某邮箱与密码的后端 (distinctive password we scan for)
    const email = uniqueEmail();
    const password = "PLAINTEXT-secret-login-zzz-9999";
    expect((await postRegister({ email, password })).status).toBe(201);

    // When 该用户用正确的邮箱与密码请求登录
    const res = await postLogin({ email, password });
    expect(res.status).toBe(200);

    const raw = await res.clone().text();
    // Then 整个响应里不包含提交的明文密码
    expect(raw).not.toContain(password);
    // And 整个响应里不包含 JWT 签名密钥
    expect(raw).not.toContain(AUTH_SECRET);
    for (const [, value] of res.headers) {
      expect(value).not.toContain(password);
      expect(value).not.toContain(AUTH_SECRET);
    }
  });

  // --- owner-only 端点保护（不变的鉴权门）-----------------------------------

  it("Scenario: 不带 token 访问 owner-only 端点返回 401", async () => {
    // Seed a config WITH a valid token first, so that — had the unauthenticated
    // request actually reached the handler — its body would echo SEEDED_MODEL.
    // Its absence below proves the business logic was never executed.
    const { token } = await registerOwner();
    await seedConfig(token);

    // When 未鉴权地请求一个 owner-only 端点 (no Authorization header)
    const res = await getConfig();

    // Then 响应状态码为 401
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const raw = await res.clone().text();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");
    // And 该 owner-only 端点的业务逻辑没有被执行 — the masked-config view (which would
    // carry the seeded model) is absent from the 401 body.
    expect(raw).not.toContain(SEEDED_MODEL);
  });

  it("Scenario: 带无效 token 访问 owner-only 端点返回 401", async () => {
    const { token } = await registerOwner();
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
    const { token } = await registerOwner();
    await seedConfig(token);

    // And 一个已过期的 session token — signed with the REAL test AUTH_SECRET but with
    // exp in the past, so ONLY the 未过期 check can reject it (not a bad signature).
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = await honoSign(
      { sub: "00000000-0000-0000-0000-000000000000", exp: past },
      AUTH_SECRET,
      "HS256",
    );

    // When 带该过期 token 请求一个 owner-only 端点
    const res = await getConfig(authHeader(expired));

    // Then 响应状态码为 401
    expect(res.status).toBe(401);
    const raw = await res.clone().text();
    // And 该 owner-only 端点的业务逻辑没有被执行
    expect(raw).not.toContain(SEEDED_MODEL);
  });

  it("Scenario: 带有效 token 访问 owner-only 端点通过鉴权", async () => {
    // Given 一个已注册并登录拿到 token 的 owner
    const { token } = await registerOwner();
    await seedConfig(token);

    // When 带该有效 token 请求一个 owner-only 端点
    const res = await getConfig(authHeader(token));

    // Then 鉴权通过且请求进入该端点的业务逻辑 — 200 with the masked-config view,
    // echoing the seeded (plaintext, non-secret) model: proof the handler ran.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deepseek?: { model?: string | null } };
    expect(body.deepseek?.model).toBe(SEEDED_MODEL);
  });

  it("Scenario: 公开端点无需 token 即可访问", async () => {
    // Given 一份已发布的表单 (publish needs an owner token; the public FETCH does not)
    const { token } = await registerOwner();
    const slug = await publishForm(token);

    // When 答题者无鉴权地拉取该 slug 对应的表单 (no Authorization header)
    const res = await SELF.fetch(`${BASE}/api/forms/${slug}`);

    // Then 鉴权通过且请求进入该端点的业务逻辑 — the public GET returns the form, NOT a
    // 401. The shared /api/forms prefix must not drag the public read behind auth.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug?: string; meta?: { title?: string } };
    expect(body.slug).toBe(slug);
    expect(body.meta?.title).toBe("鉴权测试表单");
  });

  it("Scenario: 401 错误响应里不泄漏签名密钥", async () => {
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
