import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  applySchema,
  resetConfig,
  resetForms,
  resetUsers,
  resetAuthTokens,
  installResendMock,
  registerOwner,
  uniqueEmail,
  AUTH_BASE,
  TEST_PASSWORD,
  testEnv,
  type ResendMock,
} from "./helpers";
import { issueToken } from "../src/tokens";

// Outer-loop acceptance specs for 找回密码 (SPEC.md §24), driven through the real Hono
// app in workerd via SELF.fetch. Realizes every backend Scenario of
// features/password-reset.feature:
//   发起（防邮箱枚举，永远 200）
//     - 已注册邮箱发起 → 200 + ONE reset email sent
//     - 未注册邮箱发起 → SAME 200, but NO email (anti-enumeration)
//     - 发信失败（Resend 5xx）→ 仍 200（best-effort，不暴露内部失败）
//   确认（凭一次性 reset token 改密）
//     - 有效 token + 合法新密码 → 200；新密码可登录，旧密码 401
//     - 同一 token 第二次 → 400（单次使用）
//     - 过期 token → 400（账号密码不变）
//     - 伪造 / 无效 token → 400（不改任何账号密码）
//     - 弱密码（<8）→ 400 且 token 未被消费（仍可用强密码重试）
//
// 真发信走 Resend 的 HTTP API (src/email.ts)；外环 mock 掉它，既断言「发没发 / 发给谁」，
// 又从拦截到的邮件 html 里提取 ?token= 明文，再拿它去调 confirm 端点（最忠实于真实流程）。
//
// Contract: SPEC.md §24 (找回密码) + §22 (发信 / auth_tokens).

const REQUEST = `${AUTH_BASE}/api/auth/password-reset/request`;
const CONFIRM = `${AUTH_BASE}/api/auth/password-reset/confirm`;

function postRequest(body: unknown): Promise<Response> {
  return SELF.fetch(REQUEST, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postConfirm(body: unknown): Promise<Response> {
  return SELF.fetch(CONFIRM, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postLogin(body: unknown): Promise<Response> {
  return SELF.fetch(`${AUTH_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Read a user's stored password_hash, to prove confirm did / didn't change it. */
async function passwordHashFor(email: string): Promise<string> {
  const row = await testEnv.DB.prepare("SELECT password_hash AS h FROM users WHERE email = ?")
    .bind(email)
    .first<{ h: string }>();
  return row?.h ?? "";
}

describe("找回密码 (features/password-reset.feature, §24)", () => {
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

  // --- 发起：防邮箱枚举（永远成功）-------------------------------------------

  it("Scenario: 已注册邮箱发起找回会收到重置邮件", async () => {
    // Given 一个已注册的邮箱
    const { email } = await registerOwner();
    // The register-time verify email already drained — start the assertion from a clean
    // slate so this reset send is the only one we count.
    await resend.waitForSends(1); // the verify email from register
    resend.calls.length = 0;

    // When 该用户用此邮箱发起找回密码
    const res = await postRequest({ email });

    // Then 收到中性的成功提示 (200 { ok:true })
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok?: boolean }).toEqual({ ok: true });

    // And 系统向该邮箱发出一封重置密码邮件 — exactly one, to that address, with a reset link.
    await resend.waitForSends(1);
    expect(resend.count()).toBe(1);
    expect(resend.last().to).toBe(email);
    expect(resend.last().html).toMatch(/\/reset-password\?token=/);
    // The one-shot token is extractable from the link (used by the confirm scenarios).
    expect(resend.tokenFrom().length).toBeGreaterThan(0);
  });

  it("Scenario: 未注册邮箱发起找回得到相同的中性回应", async () => {
    // Given 一个从未注册过的邮箱 (no register → no row)
    const ghost = uniqueEmail("ghost");

    // When 该用户用此邮箱发起找回密码
    const res = await postRequest({ email: ghost });

    // Then 收到与已注册邮箱完全一致的中性成功提示 (same 200 { ok:true })
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok?: boolean }).toEqual({ ok: true });

    // And 系统不发送任何邮件 (anti-enumeration — no signal that this email is unknown).
    await resend.expectNoSend();
  });

  it("Scenario: 发起时发信失败仍回中性成功", async () => {
    // Given 一个已注册的邮箱 And 发信通道暂时不可用 (Resend returns 5xx).
    const { email } = await registerOwner();
    resend.restore();
    resend = installResendMock({ status: 503 });

    // When 该用户用此邮箱发起找回密码
    const res = await postRequest({ email });

    // Then 仍然收到中性的成功提示且不暴露内部失败 (sendEmail throws EmailSendError, but
    // the request endpoint swallows it — the outward 200 is unchanged, §22.2 / §24.1).
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok?: boolean }).toEqual({ ok: true });
    // The Worker still ATTEMPTED the send (it just failed upstream); the body never
    // carried the failure. A neutral 200 with the failure hidden is the whole point.
    await resend.waitForSends(1);
    expect(resend.last().to).toBe(email);
  });

  // --- 确认：成功改密 --------------------------------------------------------

  it("Scenario: 凭有效链接设置新密码（新密码可登录，旧密码 401）", async () => {
    // Given 用户收到重置邮件并打开其中的有效链接 — drive the REAL flow: 发起 → 拦截邮件 →
    // 从 html 里提取 ?token= 明文（正是用户会点的那个 token）。
    const { email } = await registerOwner();
    await resend.waitForSends(1); // verify email
    resend.calls.length = 0;
    expect((await postRequest({ email })).status).toBe(200);
    await resend.waitForSends(1);
    const token = resend.tokenFrom();
    expect(token.length).toBeGreaterThan(0);

    // When 用户输入一个合法的新密码并提交
    const newPassword = "brand-new-strong-password-1";
    const res = await postConfirm({ token, password: newPassword });

    // Then 密码被重置成功
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok?: boolean }).toEqual({ ok: true });

    // And 用户可用新密码登录
    expect((await postLogin({ email, password: newPassword })).status).toBe(200);
    // And 旧密码不再可用
    expect((await postLogin({ email, password: TEST_PASSWORD })).status).toBe(401);
  });

  it("Scenario: 改密成功后同一重置链接失效", async () => {
    // Given 用户已用某条重置链接成功改过一次密码
    const { email } = await registerOwner();
    await resend.waitForSends(1);
    resend.calls.length = 0;
    expect((await postRequest({ email })).status).toBe(200);
    await resend.waitForSends(1);
    const token = resend.tokenFrom();
    const firstPw = "first-rotation-password-1";
    expect((await postConfirm({ token, password: firstPw })).status).toBe(200);

    // When 用户再次用同一条链接尝试改密 (a different new password)
    const res = await postConfirm({ token, password: "second-attempt-password-2" });

    // Then 改密被拒绝并提示链接失效 (single-use token already consumed → 400).
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBeTypeOf("string");
    // The password remains whatever the FIRST (successful) confirm set — the replay
    // never re-rotated it.
    expect((await postLogin({ email, password: firstPw })).status).toBe(200);
    expect((await postLogin({ email, password: "second-attempt-password-2" })).status).toBe(401);
  });

  // --- 确认：token 边界 ------------------------------------------------------

  it("Scenario: 过期的重置链接不能改密", async () => {
    // Given 一条重置链接已超过有效期 — issue a reset token with a NEGATIVE ttl so it is
    // born already expired (issueToken returns the plaintext to use as the link token).
    const { email } = await registerOwner();
    const hashBefore = await passwordHashFor(email);
    const ownerId = (
      await testEnv.DB.prepare("SELECT id FROM users WHERE email = ?")
        .bind(email)
        .first<{ id: string }>()
    )?.id;
    const { plaintext } = await issueToken(testEnv.DB, ownerId!, "reset", -60);

    // When 用户用该链接提交新密码
    const res = await postConfirm({ token: plaintext, password: "would-be-new-password-1" });

    // Then 改密被拒绝并提示链接失效
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBeTypeOf("string");
    // And 账号密码保持不变 — the stored hash is untouched, and the original password still works.
    expect(await passwordHashFor(email)).toBe(hashBefore);
    expect((await postLogin({ email, password: TEST_PASSWORD })).status).toBe(200);
  });

  it("Scenario: 伪造或无效的重置 token 不能改密", async () => {
    // Given 一条带无效 token 的重置链接 (never issued — pure garbage).
    const { email } = await registerOwner();
    const hashBefore = await passwordHashFor(email);

    // When 任何人用该 token 提交新密码
    const res = await postConfirm({
      token: "totally-forged-token-that-was-never-issued",
      password: "would-be-new-password-1",
    });

    // Then 改密被拒绝并提示链接失效 (unified 400, no signal which kind of failure, §22.4).
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBeTypeOf("string");
    // And 不修改任何账号的密码
    expect(await passwordHashFor(email)).toBe(hashBefore);
    expect((await postLogin({ email, password: TEST_PASSWORD })).status).toBe(200);
  });

  // --- 确认：新密码强度 ------------------------------------------------------

  it("Scenario: 新密码过弱时拒绝改密（且 token 未被消费，仍可重试）", async () => {
    // Given 用户打开有效的重置链接
    const { email } = await registerOwner();
    await resend.waitForSends(1);
    resend.calls.length = 0;
    expect((await postRequest({ email })).status).toBe(200);
    await resend.waitForSends(1);
    const token = resend.tokenFrom();
    const hashBefore = await passwordHashFor(email);

    // When 用户输入一个少于 8 位的新密码并提交
    const weak = await postConfirm({ token, password: "short" }); // 5 chars < 8

    // Then 改密被拒绝并提示密码过弱
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as { error?: string }).error).toBeTypeOf("string");
    // And 账号密码保持不变
    expect(await passwordHashFor(email)).toBe(hashBefore);

    // The weak-password rejection must NOT have consumed the token (§24.3): the SAME
    // token + a STRONG password still succeeds — proof the rejection short-circuited
    // before token consumption.
    const strongPw = "now-a-proper-strong-password-1";
    expect((await postConfirm({ token, password: strongPw })).status).toBe(200);
    expect((await postLogin({ email, password: strongPw })).status).toBe(200);
  });
});
