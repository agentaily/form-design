import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { sign as honoSign } from "hono/jwt";
import {
  applySchema,
  resetConfig,
  resetForms,
  resetUsers,
  resetAuthTokens,
  installResendMock,
  registerOwner,
  authHeader,
  AUTH_BASE,
  testEnv,
  type ResendMock,
} from "./helpers";
import { issueToken } from "../src/tokens";

// Outer-loop acceptance specs for 邮箱验证（软验证）(SPEC.md §23), driven through the
// real Hono app in workerd via SELF.fetch. Realizes every backend Scenario of
// features/email-verification.feature:
//   注册即发（best-effort）
//     - 注册 → 201 + 一封验证邮件
//     - 注册时发信失败（Resend 5xx）→ 仍 201（注册不被发信拖垮）
//   owner-only 重发（永远成功）
//     - 未验证 owner 重发（Bearer）→ 200 + 再发一封
//     - 已验证 owner 重发 → 200 no-op，不再发信
//     - 会话失效（无 token）→ 401
//   公开确认
//     - 有效链接 → 302 …/verify-email?status=ok 且 email_verified 置 1
//     - 同一链接第二次 → 302 …?status=invalid 且状态不变
//     - 过期链接 / 伪造 token → 302 …?status=invalid，不改任何账号状态
//
// 真发信走 Resend (src/email.ts)；外环 mock 掉它，从拦截到的邮件 html 里提取 ?token= 明文，
// 再拿它去调 confirm 端点（最忠实于真实流程，§23.4）。
//
// Contract: SPEC.md §23 (邮箱验证) + §22 (发信 / auth_tokens) + §17.2 (去重三态).

const REGISTER = `${AUTH_BASE}/api/auth/register`;
const VERIFY_REQUEST = `${AUTH_BASE}/api/auth/verify-email/request`;
const VERIFY_CONFIRM = `${AUTH_BASE}/api/auth/verify-email/confirm`;
const APP_BASE_URL = "https://form-design.agentaily.com"; // wrangler.toml [vars] (§22.1)

function postRegister(body: unknown): Promise<Response> {
  return SELF.fetch(REGISTER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** POST /api/auth/verify-email/request (owner-only) with an optional Authorization header. */
function postVerifyRequest(headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(VERIFY_REQUEST, { method: "POST", headers });
}

/**
 * GET /api/auth/verify-email/confirm?token= (public). `redirect: "manual"` so we can
 * assert the 302 Location instead of following it (the redirect target is the FRONTEND
 * landing page, not a Worker route).
 */
function getConfirm(token: string): Promise<Response> {
  const url = `${VERIFY_CONFIRM}?token=${encodeURIComponent(token)}`;
  return SELF.fetch(url, { redirect: "manual" });
}

/** Read a user's email_verified bit (0/1) by email. */
async function verifiedBit(email: string): Promise<number> {
  const row = await testEnv.DB.prepare("SELECT email_verified AS v FROM users WHERE email = ?")
    .bind(email)
    .first<{ v: number }>();
  return row?.v ?? -1;
}

async function userIdForEmail(email: string): Promise<string> {
  const row = await testEnv.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  return row?.id ?? "";
}

describe("邮箱验证 (features/email-verification.feature, §23)", () => {
  let resend: ResendMock;

  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    await resetUsers();
    await resetAuthTokens();
    resend = installResendMock();
  });

  afterEach(() => {
    resend.restore();
  });

  // --- 注册即发（best-effort）-----------------------------------------------

  it("Scenario: 新用户注册成功并收到一封验证邮件", async () => {
    // Given 一个尚未注册的邮箱; When 该用户用此邮箱与合法密码注册
    const email = "fresh-verify@test.local";
    const res = await postRegister({ email, password: "correct-horse-battery-staple" });

    // Then 注册成功且立即登录 (201 + token)
    expect(res.status).toBe(201);
    expect(((await res.json()) as { token?: string }).token).toBeTypeOf("string");
    // And 该账号处于「邮箱未验证」状态
    expect(await verifiedBit(email)).toBe(0);

    // And 系统向该邮箱发出一封验证邮件 — to that address, carrying a verify-confirm link.
    await resend.waitForSends(1);
    expect(resend.count()).toBe(1);
    expect(resend.last().to).toBe(email);
    // Regression guard (deploy bug): the verify-confirm link MUST live on the WORKER's
    // own origin — the host the register request actually came through (AUTH_BASE here) —
    // never APP_BASE_URL (the frontend domain, which doesn't serve /api). A wrong base
    // ships a dead verification link that 404s / falls through to the SPA.
    expect(resend.last().html).toContain(`${AUTH_BASE}/api/auth/verify-email/confirm?token=`);
    expect(resend.last().html).not.toContain(`${APP_BASE_URL}/api/auth/verify-email/confirm`);
  });

  it("Scenario: 注册时发信失败仍不影响注册成功", async () => {
    // Given 一个尚未注册的邮箱 And 发信通道暂时不可用 (Resend 5xx)
    resend.restore();
    resend = installResendMock({ status: 500 });
    const email = "send-fails@test.local";

    // When 该用户用此邮箱与合法密码注册
    const res = await postRegister({ email, password: "correct-horse-battery-staple" });

    // Then 注册仍然成功且立即登录 And 不因发信失败而报错 (201, token issued; the verify
    // send threw EmailSendError in the background but register swallowed it, §22.2).
    expect(res.status).toBe(201);
    expect(((await res.json()) as { token?: string }).token).toBeTypeOf("string");
    expect(await verifiedBit(email)).toBe(0);
    // The Worker still ATTEMPTED the send (it just failed upstream).
    await resend.waitForSends(1);
    expect(resend.last().to).toBe(email);
  });

  // --- owner-only 重发（永远成功）------------------------------------------

  it("Scenario: 未验证 owner 重新发送验证邮件", async () => {
    // Given 一个邮箱未验证的 owner 已登录 (register → email_verified=0 + a token)
    const { email, token } = await registerOwner();
    await resend.waitForSends(1); // the register-time verify email
    resend.calls.length = 0;

    // When 该 owner 点击「重新发送」(owner-only request, Bearer)
    const res = await postVerifyRequest(authHeader(token));

    // Then 系统再次向其邮箱发出验证邮件 And 给出「已重新发送」的中性反馈 (200 { ok:true })
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok?: boolean }).toEqual({ ok: true });
    await resend.waitForSends(1);
    expect(resend.count()).toBe(1);
    expect(resend.last().to).toBe(email);
  });

  it("Scenario: 已验证 owner 请求重发是无副作用的成功", async () => {
    // Given 一个邮箱已验证的 owner 已登录
    const { email, token } = await registerOwner();
    await resend.waitForSends(1);
    await testEnv.DB.prepare("UPDATE users SET email_verified = 1 WHERE email = ?")
      .bind(email)
      .run();
    resend.calls.length = 0;

    // When 该 owner 请求重发验证邮件
    const res = await postVerifyRequest(authHeader(token));

    // Then 请求成功且不再额外发信 (already-verified → no-op 200, NO new email, §23.3).
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok?: boolean }).toEqual({ ok: true });
    await resend.expectNoSend();
  });

  it("Scenario: 会话失效时请求重发被引导先登录", async () => {
    // Given 一个 owner 的会话已失效 — drive it as no Authorization header at all.
    // When 该 owner 请求重发验证邮件
    const res = await postVerifyRequest();

    // Then 返回未授权 And 引导其先登录 (401, the guard rejects before the handler, §23.3).
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBeTypeOf("string");
    await resend.expectNoSend();
  });

  // --- 公开确认 --------------------------------------------------------------

  it("Scenario: 点击有效链接完成验证", async () => {
    // Given owner 收到验证邮件里的有效链接 — drive the REAL flow: register → 拦截邮件 →
    // 从 html 提取 ?token= 明文（用户会点的那个 token）。
    const { email } = await registerOwner();
    await resend.waitForSends(1);
    const token = resend.tokenFrom();
    expect(token.length).toBeGreaterThan(0);
    expect(await verifiedBit(email)).toBe(0);

    // When owner 打开该链接
    const res = await getConfirm(token);

    // Then 该账号的邮箱被标记为已验证
    expect(await verifiedBit(email)).toBe(1);
    // And 落地页显示「邮箱已验证」— 302 to the frontend landing with status=ok.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_BASE_URL}/verify-email?status=ok`);
  });

  it("Scenario: 同一验证链接不能用第二次", async () => {
    // Given owner 已用验证链接成功验证过一次
    const { email } = await registerOwner();
    await resend.waitForSends(1);
    const token = resend.tokenFrom();
    const first = await getConfirm(token);
    expect(first.headers.get("location")).toBe(`${APP_BASE_URL}/verify-email?status=ok`);
    expect(await verifiedBit(email)).toBe(1);

    // When owner 再次打开同一条链接
    const res = await getConfirm(token);

    // Then 落地页显示「链接已失效」(single-use token already consumed → status=invalid).
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_BASE_URL}/verify-email?status=invalid`);
    // And 账号状态保持已验证不变
    expect(await verifiedBit(email)).toBe(1);
  });

  it("Scenario: 过期的验证链接失效", async () => {
    // Given 一条验证链接已超过有效期 — issue a verify token with a NEGATIVE ttl so it is
    // born already expired.
    const { email } = await registerOwner();
    const ownerId = await userIdForEmail(email);
    const { plaintext } = await issueToken(testEnv.DB, ownerId, "verify", -60);
    expect(await verifiedBit(email)).toBe(0);

    // When owner 打开该链接
    const res = await getConfirm(plaintext);

    // Then 落地页显示「链接已失效」
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_BASE_URL}/verify-email?status=invalid`);
    // And 账号邮箱仍为未验证
    expect(await verifiedBit(email)).toBe(0);
  });

  it("Scenario: 伪造或无效的验证 token 失效", async () => {
    // Given 一条带无效 token 的验证链接 (never issued — pure garbage).
    const { email } = await registerOwner();
    expect(await verifiedBit(email)).toBe(0);

    // When 任何人打开该链接
    const res = await getConfirm("totally-forged-verify-token-never-issued");

    // Then 落地页显示「链接已失效」(unified invalid, no signal which kind, §22.4).
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_BASE_URL}/verify-email?status=invalid`);
    // And 不修改任何账号的验证状态 — the existing account stays unverified.
    expect(await verifiedBit(email)).toBe(0);
  });

  // --- GET /api/auth/me (§17.12) — 前端 banner 的真实验证位来源 --------------

  it("Scenario: GET /api/auth/me 回当前 owner 的 { email, emailVerified }（注册后 0、验证后 1）", async () => {
    // 注册后带 token → 200 { email, emailVerified:0 }.
    const { email, token } = await registerOwner();
    await resend.waitForSends(1);
    const verifyToken = resend.tokenFrom();

    const me1 = await SELF.fetch(`${AUTH_BASE}/api/auth/me`, { headers: authHeader(token) });
    expect(me1.status).toBe(200);
    const body1 = (await me1.json()) as { email?: string; emailVerified?: number };
    expect(body1.email).toBe(email);
    expect(body1.emailVerified).toBe(0);

    // 验证后 → emailVerified:1.
    expect((await getConfirm(verifyToken)).status).toBe(302);
    const me2 = await SELF.fetch(`${AUTH_BASE}/api/auth/me`, { headers: authHeader(token) });
    expect(me2.status).toBe(200);
    expect(((await me2.json()) as { emailVerified?: number }).emailVerified).toBe(1);
  });

  it("Scenario: GET /api/auth/me 只投影 email + 验证位，绝不含任何密码字段", async () => {
    const { email, token } = await registerOwner();
    const res = await SELF.fetch(`${AUTH_BASE}/api/auth/me`, { headers: authHeader(token) });
    expect(res.status).toBe(200);

    // The whole raw response must carry ONLY email + emailVerified — never any password
    // material (§17.12). Scan the raw text + assert the exact projected shape.
    const raw = await res.clone().text();
    expect(raw).not.toMatch(/password/i);
    expect(raw).not.toMatch(/hash/i);
    expect(raw).not.toMatch(/salt/i);
    expect(raw).not.toMatch(/iterations/i);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["email", "emailVerified"]);
    expect(body.email).toBe(email);
  });

  it("Scenario: GET /api/auth/me — 无 token / 坏 token → 401", async () => {
    const noToken = await SELF.fetch(`${AUTH_BASE}/api/auth/me`);
    expect(noToken.status).toBe(401);

    const badToken = await SELF.fetch(`${AUTH_BASE}/api/auth/me`, {
      headers: authHeader("not.a.valid-jwt"),
    });
    expect(badToken.status).toBe(401);
  });

  it("Scenario: GET /api/auth/me — token 指向已被覆盖重注册而失效的旧 user → 401", async () => {
    // Given 一个未验证 owner 注册并拿到 token (sub = old id)
    const { email, token: oldToken } = await registerOwner();
    const oldId = await userIdForEmail(email);

    // The SAME email is re-registered while still unverified → 覆盖重注册 mints a NEW id;
    // the old token's sub (oldId) no longer exists in users (§17.2).
    expect((await postRegister({ email, password: "another-strong-password-2" })).status).toBe(201);
    const newId = await userIdForEmail(email);
    expect(newId).not.toBe(oldId);

    // When the old token (whose sub points at the now-deleted old user) hits /me
    const res = await SELF.fetch(`${AUTH_BASE}/api/auth/me`, { headers: authHeader(oldToken) });

    // Then → 401: signature verifies but sub points to a vanished account (§17.12) — the
    // session is dead, the frontend must clear it and re-login (not see an empty account).
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBeTypeOf("string");
  });

  it("Scenario: GET /api/auth/me — 签名有效但 sub 从不存在 → 401", async () => {
    // A token signed with the REAL test AUTH_SECRET (so verification passes) but whose
    // sub is a random UUID that was never a real user → 401 (sub not found, §17.12).
    const ghostToken = await honoSign(
      // exp in the future so verifySession passes the signature+exp gate and actually
      // reaches the sub-lookup — proving the 401 comes from "sub not found", not a missing exp.
      { sub: "00000000-0000-0000-0000-000000000000", exp: Math.floor(Date.now() / 1000) + 3600 },
      testEnv.AUTH_SECRET,
      "HS256",
    );
    const res = await SELF.fetch(`${AUTH_BASE}/api/auth/me`, { headers: authHeader(ghostToken) });
    expect(res.status).toBe(401);
  });
});
