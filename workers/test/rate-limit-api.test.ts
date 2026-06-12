import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  applySchema,
  resetConfig,
  resetForms,
  resetUsers,
  resetAuthTokens,
  resetRateLimit,
  installResendMock,
  registerOwner,
  uniqueEmail,
  login,
  authHeader,
  testEnv,
  AUTH_BASE,
  TEST_PASSWORD,
  type ResendMock,
} from "./helpers";
import { FEISHU_BITABLE_RECORDS_URL, FEISHU_BITABLE_FIELDS_URL } from "../src/submit";
import { FEISHU_TENANT_TOKEN_URL } from "../src/feishu";
import {
  REGISTER_RATE_LIMIT,
  LOGIN_RATE_LIMIT,
  PASSWORD_RESET_RATE_LIMIT,
  SUBMIT_RATE_LIMITS,
} from "../src/ratelimit";

// Outer-loop acceptance specs for 公开端点限流 / 防刷 (SPEC.md §25), driven through the
// REAL Hono app in workerd via SELF.fetch. Realizes every scenario of
// workers/features/rate-limit.feature at the HTTP altitude: an actual request → the
// cors() → rateLimit(...) → handler pipeline → a real 429 + Retry-After header.
//
// IP MODEL (load-bearing, §25.3): the rate limiter counts per CF-Connecting-IP.
// SELF.fetch sends NO such header by default, so every bare request lands in the one
// constant UNKNOWN_IP_BUCKET — fine for the "no IP → fallback bucket" scenario, but to
// drive / isolate per-IP behavior we MUST set CF-Connecting-IP explicitly:
//   - same actor hammering one endpoint → SAME ip (so counts accumulate → 429);
//   - independent actors → DISTINCT ips (so counters never bleed across).
// The global beforeEach (test/setup-ratelimit.ts) wipes the `rl:` keys before each
// test, so every scenario starts from an empty window. A few probing scenarios also
// reset mid-test to isolate one endpoint's count from setup traffic.
//
// SIDE-EFFECT PROOF: a 429 must mean the handler body never ran. We prove that by the
// absence of the handler's side effect on the limited request —
//   - limited register / password-reset → NO Resend send (installResendMock count);
//   - limited submit → NO Feishu record write (default-deny Feishu mock call count).
//
// Contract: SPEC.md §25 + workers/features/rate-limit.feature.

const BASE = AUTH_BASE; // https://api.local

// CF-Connecting-IP minter. Every test (and every independent "actor" within a test)
// gets a FRESH, unique IP, so its rate-limit counters can never be contaminated by a
// leftover count from an earlier test — miniflare's KV `list()` (used by resetRateLimit)
// is eventually consistent, so a key written at the tail of a prior test may survive the
// wipe; a brand-new IP per actor sidesteps that entirely. Reuse the SAME minted IP within
// one actor to accumulate a count; mint a different one for an "independent visitor".
let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  // 198.18.0.0/15 is the benchmarking range — safe, non-routable test addresses.
  return `198.18.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

/** Build request headers carrying a JSON content-type + an explicit visitor IP. */
function ipHeaders(ip: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", "CF-Connecting-IP": ip, ...extra };
}

/**
 * Drive `send` from a fresh-windowed IP until it returns 429, proving the endpoint
 * enforces its limit. Asserts NO premature denial strictly below `limit` (every
 * request up to the limit must enter the handler, observed via `okStatus`), then keeps
 * sending — with a small margin past `limit` — until the first 429. Returns that denied
 * Response. The margin (not an exact `limit+1`) absorbs the KV's eventually-consistent
 * read-modify-write, which §25.6 explicitly allows to under-count by an op or two under
 * load — the BEHAVIOUR under test is "exceed the limit → 429", not "exactly the Nth".
 */
async function hammerUntil429(
  send: (body: unknown) => Promise<Response>,
  limit: number,
  bodyFor: () => unknown,
  okStatus: number,
): Promise<Response> {
  // Below the limit: never denied — each request reaches the handler.
  for (let i = 0; i < limit; i++) {
    const res = await send(bodyFor());
    expect(res.status).not.toBe(429); // no premature throttle inside the quota
    expect(res.status).toBe(okStatus); // the handler actually ran
  }
  // At/after the limit: a 429 must appear within a small margin (KV may under-count).
  const margin = limit + 5;
  for (let i = limit; i < margin; i++) {
    const res = await send(bodyFor());
    if (res.status === 429) return res;
  }
  throw new Error(`hammerUntil429: no 429 after ${margin} requests at limit ${limit}`);
}

// --- thin per-endpoint senders (each carries an explicit CF-Connecting-IP) -----

function postRegister(ip: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: ipHeaders(ip),
    body: JSON.stringify(body),
  });
}

function postLogin(ip: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: ipHeaders(ip),
    body: JSON.stringify(body),
  });
}

function postPasswordReset(ip: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/auth/password-reset/request`, {
    method: "POST",
    headers: ipHeaders(ip),
    body: JSON.stringify(body),
  });
}

function postSubmit(ip: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: ipHeaders(ip),
    body: JSON.stringify(body),
  });
}

// =============================================================================
// 限额常量（从 ratelimit.ts 取真实值，断言对齐契约表 §25.4）
// =============================================================================
const REGISTER_LIMIT = REGISTER_RATE_LIMIT.limit; // 5/hour
const LOGIN_LIMIT = LOGIN_RATE_LIMIT.limit; // 10/minute
const PWRESET_LIMIT = PASSWORD_RESET_RATE_LIMIT.limit; // 4/hour
const SUBMIT_MINUTE_LIMIT = SUBMIT_RATE_LIMITS[0].limit; // 10/minute
const SUBMIT_HOUR_LIMIT = SUBMIT_RATE_LIMITS[1].limit; // 100/hour

// =============================================================================
// 登录限流套件（最轻量的 driver：login 不发信、不打上游，只读 users 表）
// =============================================================================
describe("公开端点限流 / 防刷 — 登录 (workers/features/rate-limit.feature, §25)", () => {
  beforeAll(async () => {
    await applySchema();
  });
  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    await resetUsers();
    await resetAuthTokens();
  });

  /** Send a wrong-password login from `ip` (always reaches the handler → unified 401). */
  const loginFrom = (ip: string) => (body: unknown) => postLogin(ip, body);
  const badCreds = () => ({ email: uniqueEmail(), password: "whatever" });

  it("Scenario: 限额内的公开端点请求正常放行", async () => {
    const ip = freshIp();
    // Given 一个挂了限流的公开端点 (POST /api/auth/login, 10/分钟)
    // And 当前 IP 在该端点窗口内的请求数还在上限以内
    // 打 LIMIT-1 次 (都在限额内)：每次都是业务逻辑下的 401（错密码），从不是 429。
    for (let i = 0; i < LOGIN_LIMIT - 1; i++) {
      const res = await postLogin(ip, badCreds());
      expect(res.status).not.toBe(429);
      expect(res.status).toBe(401); // 进了 handler、走防枚举 401
    }

    // When 该 IP 再发一次请求 (第 LIMIT 次，仍在 ≤ 上限内)
    const res = await postLogin(ip, badCreds());

    // Then 请求被放行进入该端点的业务逻辑
    // And 响应状态码与响应体与未挂限流时一致 (login 的统一 401)
    expect(res.status).toBe(401);
    expect((await res.json()) as { error?: string }).toEqual({ error: "未授权" });
    // And 响应没有被改写成 429
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("Scenario: 同一 IP 在窗口内超过上限返回 429", async () => {
    // Given 一个挂了限流的公开端点
    // And 某 IP 已在当前窗口内达到该端点的请求上限
    // When 该 IP 在同一窗口内再发一次请求 → 超限。
    const ip = freshIp();
    const res = await hammerUntil429(loginFrom(ip), LOGIN_LIMIT, badCreds, 401);

    // Then 响应状态码为 429
    expect(res.status).toBe(429);
    // And 响应体是一个中性的 error 文案 (不回显限额 / 剩余次数, §25.8)
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");
    expect(body.error!.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(new RegExp(String(LOGIN_LIMIT))); // 不漏限额数字
    // And 该次请求没有进入该端点的业务逻辑：被限的 body 不是 login 的 200 { token }
    // （handler 从未运行）。
    expect(body).not.toHaveProperty("token");
  });

  it("Scenario: 超限响应带 Retry-After 头告知何时可重试", async () => {
    // Given 某 IP 已对某公开端点触发限流
    // When 该 IP 再发一次被拒的请求
    const res = await hammerUntil429(loginFrom(freshIp()), LOGIN_LIMIT, badCreds, 401);

    // Then 响应状态码为 429
    expect(res.status).toBe(429);
    // And 响应头带有 Retry-After
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    // And Retry-After 是一个表示到窗口重置剩余秒数的非负整数
    expect(retryAfter).toMatch(/^\d+$/); // 纯数字、无负号、无小数
    const seconds = Number(retryAfter);
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(0);
    // login 是 60s 窗口 → 到重置的剩余秒数必 ≤ 窗口长度。
    expect(seconds).toBeLessThanOrEqual(LOGIN_RATE_LIMIT.windowSeconds);
  });

  it("Scenario: 超限用 429 而非 503", async () => {
    // Given 某 IP 已对某公开端点触发限流
    // When 该 IP 再发一次被拒的请求
    const res = await hammerUntil429(loginFrom(freshIp()), LOGIN_LIMIT, badCreds, 401);

    // Then 响应状态码为 429
    expect(res.status).toBe(429);
    // And 响应状态码不是 503
    expect(res.status).not.toBe(503);
  });

  it("Scenario: 不同 IP 各自独立计数互不影响", async () => {
    // Given 一个挂了限流的公开端点
    // And 一个 IP 已把该端点窗口内的配额刷满 (并已触发 429)
    const ipA = freshIp();
    const aDenied = await hammerUntil429(loginFrom(ipA), LOGIN_LIMIT, badCreds, 401);
    expect(aDenied.status).toBe(429); // ipA 确已被限

    // When 另一个不同 IP 对同一端点发请求
    const bRes = await postLogin(freshIp(), badCreds());

    // Then 该请求被放行
    // And 它不受第一个 IP 已超限的影响 (新 IP 走业务 401, 不是 429)
    expect(bRes.status).toBe(401);
    expect(bRes.status).not.toBe(429);
  });

  it("Scenario: 缺少 CF-Connecting-IP 时归入兜底桶且仍限流", async () => {
    // Given 一个不带 CF-Connecting-IP 头的请求
    // 直接 SELF.fetch 不带 CF-Connecting-IP → 落 UNKNOWN_IP_BUCKET（§25.3）。
    // 注意：全局 beforeEach 已清 rl: 键，本 test 起始兜底桶为空。
    const noIp = (): Promise<Response> =>
      SELF.fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" }, // 故意不带 CF-Connecting-IP
        body: JSON.stringify(badCreds()),
      });

    // When 该来源对某限流端点高频发请求并超过上限
    // Then 这些无 IP 请求共享同一个常量兜底桶（同桶累加），到上限内不被拒…
    for (let i = 0; i < LOGIN_LIMIT; i++) {
      const res = await noIp();
      expect(res.status).not.toBe(429);
      expect(res.status).toBe(401);
    }
    // …And 超过兜底桶上限后同样被限为 429（带小幅 margin 容忍 KV 少计）。
    let denied: Response | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await noIp();
      if (res.status === 429) {
        denied = res;
        break;
      }
    }
    expect(denied?.status).toBe(429);
  });
});

// =============================================================================
// 跨桶独立 + 注册限流 + 副作用未发生（register 用 installResendMock 断言 0 发信）
// =============================================================================
describe("公开端点限流 / 防刷 — 注册 + 跨桶独立 (workers/features/rate-limit.feature, §25)", () => {
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

  it("Scenario: 各公开端点按各自默认限额限流 — POST /api/auth/register (5/小时)", async () => {
    // Given 端点 "POST /api/auth/register" 挂了限额为 "5/小时" 的限流
    expect(REGISTER_LIMIT).toBe(5); // 对齐契约表 §25.4

    // When 某 IP 在对应窗口内的请求数超过该限额
    // 头 LIMIT 次：每次都真注册一个新账号（201），并后台发一封验证邮件——限额内从不被拒。
    const ip = freshIp();
    let registered = 0; // 实际成功建号数（== 实际进了 handler 的次数）
    for (let i = 0; i < REGISTER_LIMIT; i++) {
      const res = await postRegister(ip, { email: uniqueEmail(), password: TEST_PASSWORD });
      expect(res.status).not.toBe(429); // 限额内绝不被限
      expect(res.status).toBe(201); // 进了 handler、建号成功
      registered++;
    }

    // 超出上限后再打几次（带 margin 容忍 KV 少计）→ 必出现 429。被限的请求绝不进 handler，
    // 故既不建号、也不发验证邮件——这正是「副作用未发生」的可观测证据。
    let denied: Response | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await postRegister(ip, { email: uniqueEmail(), password: TEST_PASSWORD });
      if (res.status === 429) {
        denied = res;
        break;
      }
      // 万一某次因 KV 少计仍 201，把它计入基线（仍是合法建号），继续打到被限。
      expect(res.status).toBe(201);
      registered++;
    }

    // Then 超出的请求返回 429 并带 Retry-After
    expect(denied?.status).toBe(429);
    const retryAfter = denied!.headers.get("Retry-After");
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(0);
    // register 是小时窗 → Retry-After ≤ 3600。
    expect(Number(retryAfter)).toBeLessThanOrEqual(REGISTER_RATE_LIMIT.windowSeconds);

    // 副作用未发生：被限的 register 不进 createUser、不发验证邮件（§25 限流排在 handler 前）。
    // 等 `registered` 封验证邮件全部落地（waitUntil 后台发，§23.2），再等一拍让任何潜逃的
    // 后台发信也落地，然后断言发信总数 == 成功建号数（被限的那些请求一封都没发）。
    await resend.waitForSends(registered);
    await new Promise((r) => setTimeout(r, 60));
    expect(resend.count()).toBe(registered); // 被限请求零发信
    // 用户表行数也恰好 == 成功建号数（被限请求零建号）。
    const userCount = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{
      n: number;
    }>();
    expect(userCount?.n).toBe(registered);
  });

  it("Scenario: 不同端点各自独立计数互不串桶", async () => {
    // Given 同一个 IP 已把 POST /api/auth/login 的窗口配额刷满 (并触发 429)
    const ip = freshIp();
    const loginDenied = await hammerUntil429(
      (b) => postLogin(ip, b),
      LOGIN_LIMIT,
      () => ({ email: uniqueEmail(), password: "whatever" }),
      401,
    );
    expect(loginDenied.status).toBe(429); // login 桶确已打爆

    // When 该 IP 对 POST /api/auth/register 发一次请求 (同 IP, 不同 bucket)
    const regRes = await postRegister(ip, { email: uniqueEmail(), password: TEST_PASSWORD });

    // Then 该 register 请求不因 login 已超限而被拒
    expect(regRes.status).not.toBe(429);
    // And 它按 register 自己的配额判定 (register 桶仍空 → 正常 201 建号)
    expect(regRes.status).toBe(201);
  });
});

// =============================================================================
// 找回密码限流 + 副作用未发生（被限的 pwreset 不发 reset 邮件）
// =============================================================================
describe("公开端点限流 / 防刷 — 找回密码 (workers/features/rate-limit.feature, §25)", () => {
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

  it("Scenario: 各公开端点按各自默认限额限流 — POST /api/auth/password-reset/request (4/小时)", async () => {
    // Given 端点 "POST /api/auth/password-reset/request" 挂了限额为 "4/小时" 的限流
    expect(PWRESET_LIMIT).toBe(4); // 对齐契约表 §25.4

    // 先注册一个真实账号，使「命中邮箱即发 reset 信」的路径在限额内会真发信（隔离掉限流前
    // 的发信变量后，才好证明被限那次没发）。注册自身的验证邮件先 drain + 清掉。
    const { email } = await registerOwner({ email: uniqueEmail(), password: TEST_PASSWORD });
    await resend.waitForSends(1); // 注册时的验证邮件
    resend.calls.length = 0;
    // register 也占了 register 桶，但与 pwreset 桶无关；为求 pwreset 计数干净，清 rl: 键。
    await resetRateLimit();

    // When 某 IP 在对应窗口内的请求数超过该限额
    // 头 LIMIT 次：命中已注册邮箱 → 每次真发一封 reset 邮件，且对外永远中性 200（防枚举 §24.1）。
    const ip = freshIp();
    let sent = 0; // 实际发出的 reset 邮件数（== 实际进了 handler 且命中邮箱的次数）
    for (let i = 0; i < PWRESET_LIMIT; i++) {
      const res = await postPasswordReset(ip, { email });
      expect(res.status).not.toBe(429); // 限额内绝不被限
      expect(res.status).toBe(200);
      sent++;
    }

    // 超出上限后再打几次（带 margin 容忍 KV 少计）→ 必出现 429。被限的请求不进 handler、不发信。
    let denied: Response | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await postPasswordReset(ip, { email });
      if (res.status === 429) {
        denied = res;
        break;
      }
      expect(res.status).toBe(200); // 偶发 KV 少计仍 200 → 仍发一封，计入基线
      sent++;
    }

    // Then 超出的请求返回 429 并带 Retry-After
    expect(denied?.status).toBe(429);
    const retryAfter = denied!.headers.get("Retry-After");
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(PASSWORD_RESET_RATE_LIMIT.windowSeconds);

    // 副作用未发生：被限的 reset request 不进 handler、不发 reset 邮件（护共享 Resend，§25.4）。
    // 等 `sent` 封 reset 邮件全部落地，再等一拍让任何潜逃的后台发信落地，断言发信总数 == 命中次数。
    await resend.waitForSends(sent);
    await new Promise((r) => setTimeout(r, 60));
    expect(resend.count()).toBe(sent); // 被限请求零发信
  });
});

// =============================================================================
// owner-only / health / OPTIONS 预检 — 不受公开端点限流影响
// =============================================================================
describe("公开端点限流 / 防刷 — 不受限的面 (workers/features/rate-limit.feature, §25)", () => {
  beforeAll(async () => {
    await applySchema();
  });
  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    await resetUsers();
    await resetAuthTokens();
  });

  it("Scenario: owner-only 端点不受公开端点限流影响", async () => {
    // Given 一个已登录的 owner 持有效 token
    const token = await login();

    // When 该 owner 高频地访问某 owner-only 端点 (GET /api/config) 超过公开端点的限额次数
    // 用最严的公开端点限额（login 10/分钟）做对照基准：打到它的 2 倍多。owner-only 同 IP。
    const ip = freshIp();
    const reps = LOGIN_LIMIT * 2 + 5;
    let any429 = false;
    let last = 0;
    for (let i = 0; i < reps; i++) {
      const res = await SELF.fetch(`${BASE}/api/config`, {
        headers: ipHeaders(ip, authHeader(token)),
      });
      last = res.status;
      if (res.status === 429) any429 = true;
    }

    // Then 这些请求不会因公开端点的限流被拒
    expect(any429).toBe(false);
    // And 它们只受 owner 鉴权门约束 (合法 token → 200, 进了业务逻辑)
    expect(last).toBe(200);
  });

  it("Scenario: 探活端点不被限流", async () => {
    // When 对 GET /health 高频探活超过任何公开端点限额次数 (同 IP, 远超 login 10/分钟)
    const ip = freshIp();
    const reps = SUBMIT_MINUTE_LIMIT * 3 + 5;
    let any429 = false;
    for (let i = 0; i < reps; i++) {
      const res = await SELF.fetch(`${BASE.replace("/api", "")}/health`, {
        headers: { "CF-Connecting-IP": ip },
      });
      // Then 每次都正常返回探活结果
      expect(res.status).toBe(200);
      expect((await res.json()) as { ok?: boolean }).toMatchObject({ ok: true });
      if (res.status === 429) any429 = true;
    }
    // And 没有任何一次被限为 429
    expect(any429).toBe(false);
  });

  it("Scenario: OPTIONS 预检不被限流触发", async () => {
    // Given 一个跨源前端对某限流公开端点 (POST /api/auth/login) 反复发 OPTIONS 预检
    // CORS 中间件挂在 rateLimit 之前，会先短路应答 OPTIONS（带 CORS 头的 2xx）。
    const ip = freshIp();
    const reps = LOGIN_LIMIT * 3 + 5; // 远超 login 上限
    let any429 = false;
    for (let i = 0; i < reps; i++) {
      const res = await SELF.fetch(`${BASE}/api/auth/login`, {
        method: "OPTIONS",
        headers: {
          "CF-Connecting-IP": ip,
          Origin: "https://form-design.agentaily.com", // 允许的源 → CORS 放行
          "Access-Control-Request-Method": "POST",
        },
      });
      // Then 每次预检都由 CORS 中间件以带 CORS 头的 2xx 短路应答
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://form-design.agentaily.com",
      );
      // And 没有任何一次预检被限为 429
      if (res.status === 429) any429 = true;
    }
    expect(any429).toBe(false);

    // 关键铁律：预检不被计数 —— 跑了 reps(> 上限) 次预检后，真实 POST /api/login 计数仍从 0 起，
    // 故紧接着的 LIMIT 次真实 POST 仍全部放行（若预检被计数，这里早该 429 了）。
    for (let i = 0; i < LOGIN_LIMIT; i++) {
      const res = await postLogin(ip, { email: uniqueEmail(), password: "whatever" });
      expect(res.status).not.toBe(429); // 全部进了 handler、未被预检的计数挤掉
      expect(res.status).toBe(401);
    }
  });
});

// =============================================================================
// 隐私：计数键不写原始 IP 明文（从 KV 直接观测写入的键）
// =============================================================================
describe("公开端点限流 / 防刷 — 隐私 (workers/features/rate-limit.feature, §25)", () => {
  beforeAll(async () => {
    await applySchema();
  });
  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    await resetUsers();
    await resetAuthTokens();
  });

  it("Scenario: 限流计数键不写入原始 IP 明文", async () => {
    // Given 一个带 CF-Connecting-IP 的请求命中某限流端点
    const RAW_IP = freshIp(); // 一个独特、可在 KV 键里子串扫描的 IP（每次运行唯一）
    // When 限流器为该请求计数 (一次真实命中 login → 写一条计数)
    const res = await postLogin(RAW_IP, { email: uniqueEmail(), password: "whatever" });
    expect(res.status).toBe(401); // 进了 handler、计数已写

    // 直接观测 KV 里写下的所有键。
    const listed = await testEnv.RATE_LIMIT.list();
    const keys = listed.keys.map((k) => k.name);
    expect(keys.length).toBeGreaterThan(0); // 确有计数键被写

    // Then 写入 KV 的键由 IP 的单向哈希加端点类别加窗口起点组成 (rl:<bucket>:<hash>:<windowStart>)
    const loginKey = keys.find((k) => k.startsWith("rl:login:"));
    expect(loginKey).toBeDefined();
    const parts = loginKey!.split(":");
    expect(parts[0]).toBe("rl");
    expect(parts[1]).toBe("login");
    expect(parts[2]).toMatch(/^[0-9a-f]+$/); // 单向哈希段 (hex)
    expect(parts[3]).toMatch(/^\d+$/); // 窗口起点

    // And 写入 KV 的键与值都不包含原始 IP 明文
    for (const k of keys) {
      expect(k).not.toContain(RAW_IP);
      const value = await testEnv.RATE_LIMIT.get(k);
      expect(value ?? "").not.toContain(RAW_IP);
    }
  });
});

// =============================================================================
// 提交限流：双窗口 + 副作用未发生（被限的 submit 不写飞书）+ 5/小时/分钟限额表
// =============================================================================
const OWNER_DEEPSEEK_KEY = "sk-owner-DEEPSEEK-secret-0123456789abcdef";
const OWNER_FEISHU_APP_ID = "cli_fixtureAppId9999";
const OWNER_FEISHU_APP_SECRET = "feishu-APP-SECRET-qrstuvwxyz-7777";
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
const FIELDS_LIST_BODY = JSON.stringify({
  code: 0,
  msg: "success",
  data: { items: [{ field_name: "姓名", type: 1 }] },
});
const FIELD_CREATE_OK_BODY = JSON.stringify({ code: 0, msg: "success" });

interface CapturedCall {
  url: string;
  method: string;
}
interface FeishuMock {
  readonly tokenCalls: CapturedCall[];
  readonly recordCalls: CapturedCall[];
  readonly fieldsListCalls: CapturedCall[];
  resetCalls(): void;
  restore(): void;
}

/**
 * A happy-path Feishu mock: token-exchange + list-fields + add-record all OK, so a
 * fully-formed submit returns 200 { ok, recordId }. We count `recordCalls` to prove
 * "a limited submit did NOT write Feishu" — the 11th (429'd) request must add zero.
 */
function installFeishuHappyMock(): FeishuMock {
  const tokenCalls: CapturedCall[] = [];
  const recordCalls: CapturedCall[] = [];
  const fieldsListCalls: CapturedCall[] = [];
  const realFetch = globalThis.fetch;
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as RequestInfo, init);
    if (req.url === FEISHU_TENANT_TOKEN_URL) {
      tokenCalls.push({ url: req.url, method: req.method });
      return new Response(FEISHU_TOKEN_OK_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (req.url === BITABLE_URL) {
      recordCalls.push({ url: req.url, method: req.method });
      return new Response(BITABLE_OK_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (pathKey(req.url) === BITABLE_FIELDS_PATH) {
      if (req.method === "GET") {
        fieldsListCalls.push({ url: req.url, method: req.method });
        return new Response(FIELDS_LIST_BODY, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(FIELD_CREATE_OK_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected outbound fetch to ${req.url} (only Feishu upstreams mocked)`);
  };
  globalThis.fetch = stub as typeof fetch;
  return {
    tokenCalls,
    recordCalls,
    fieldsListCalls,
    resetCalls: () => {
      tokenCalls.length = 0;
      recordCalls.length = 0;
      fieldsListCalls.length = 0;
    },
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

describe("公开端点限流 / 防刷 — 提交 (workers/features/rate-limit.feature, §25)", () => {
  let mock: FeishuMock;
  let slug: string;

  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    await resetUsers();
    await resetAuthTokens();
    mock = installFeishuHappyMock();

    // Seed a configured owner + a published form so an allowed submit reaches the
    // Feishu write (200). Setup uses owner-only endpoints with a Bearer token.
    const token = await login();
    const cfg = await SELF.fetch(`${BASE}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader(token) },
      body: JSON.stringify({
        deepseek: { apiKey: OWNER_DEEPSEEK_KEY, model: "deepseek-chat" },
        feishu: {
          appId: OWNER_FEISHU_APP_ID,
          appSecret: OWNER_FEISHU_APP_SECRET,
          appToken: OWNER_FEISHU_APP_TOKEN,
          tableId: OWNER_FEISHU_TABLE_ID,
        },
      }),
    });
    if (cfg.status !== 200) throw new Error(`setup config failed: ${cfg.status}`);

    const pub = await SELF.fetch(`${BASE}/api/forms`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader(token) },
      body: JSON.stringify({
        meta: { title: "限流提交测试表单" },
        fields: [{ id: "f_name", type: "text", label: "姓名" }],
      }),
    });
    if (pub.status !== 201) throw new Error(`setup publish failed: ${pub.status}`);
    slug = ((await pub.json()) as { slug: string }).slug;

    // The publish kicks off a background pre-create fan-out (§16.8) onto the mock;
    // let it settle, then reset captured calls + the rl: counters so the submit
    // counting below starts from a clean window. (login/config/publish setup also
    // bumped some rate buckets, but submit's bucket is independent — still, wipe to
    // be safe and to drop the publish fan-out's record-call noise.)
    await new Promise((r) => setTimeout(r, 40));
    mock.resetCalls();
    await resetRateLimit();
  });

  afterEach(() => {
    mock.restore();
  });

  /** A valid submission for the seeded form (one required text answer). */
  const submission = () => ({ formSlug: slug, answers: [{ label: "姓名", value: "张三" }] });

  it("Scenario: 各公开端点按各自默认限额限流 — POST /api/submit (10/分钟 且 100/小时)", async () => {
    // Given 端点 "POST /api/submit" 挂了限额为 "10/分钟 且 100/小时" 的限流
    expect(SUBMIT_MINUTE_LIMIT).toBe(10); // 对齐契约表 §25.4
    expect(SUBMIT_HOUR_LIMIT).toBe(100);

    // When 某 IP 在对应窗口内的请求数超过该限额 (分钟窗先触发)
    // 头 LIMIT 次：每次都真写一条飞书记录（200），限额内绝不被限。
    const ip = freshIp();
    let written = 0; // 实际写入飞书的记录数（== 实际进了 handler 的提交数）
    for (let i = 0; i < SUBMIT_MINUTE_LIMIT; i++) {
      const res = await postSubmit(ip, submission());
      expect(res.status).not.toBe(429);
      expect(res.status).toBe(200); // 真写飞书
      written++;
    }
    // 超出上限后再打几次（margin 容忍 KV 少计）→ 必出现 429；被限的 submit 不写飞书。
    let denied: Response | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await postSubmit(ip, submission());
      if (res.status === 429) {
        denied = res;
        break;
      }
      expect(res.status).toBe(200);
      written++;
    }

    // Then 超出的请求返回 429 并带 Retry-After
    expect(denied?.status).toBe(429);
    const retryAfter = denied!.headers.get("Retry-After");
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(0);

    // 副作用未发生：被限的 submit 不进 handler、不换 token、不写飞书记录 →
    // 飞书记录写入数恰好 == 成功提交数（被限的请求一条都没写）。
    expect(mock.recordCalls.length).toBe(written);
  });

  it("Scenario: submit 端点的分钟与小时双窗口任一命中即拒", async () => {
    // Given POST /api/submit 同时挂了每分钟与每小时两个窗口 (10/分钟 + 100/小时)
    // And 某 IP 在一分钟内的提交数已达到分钟上限但未达小时上限
    // 一分钟内打满 10 次（仍远在 100/小时内）：限额内全 200。
    const ip = freshIp();
    let written = 0;
    for (let i = 0; i < SUBMIT_MINUTE_LIMIT; i++) {
      const res = await postSubmit(ip, submission());
      expect(res.status).not.toBe(429);
      expect(res.status).toBe(200);
      written++;
    }

    // When 该 IP 在同一分钟内再提交 (> 10/分钟, 仍 ≪ 100/小时) → 分钟窗先命中。
    let denied: Response | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await postSubmit(ip, submission());
      if (res.status === 429) {
        denied = res;
        break;
      }
      expect(res.status).toBe(200);
      written++;
    }

    // Then 响应状态码为 429 (分钟窗先命中，远未触及 100/小时)
    expect(denied?.status).toBe(429);
    // And Retry-After 反映命中的那个窗口到重置的剩余秒数 (分钟窗 → ≤ 60s, 不是小时窗的几千秒)
    const retryAfter = Number(denied!.headers.get("Retry-After"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(0);
    expect(retryAfter).toBeLessThanOrEqual(SUBMIT_RATE_LIMITS[0].windowSeconds); // 60s
    // 命中的是分钟窗、未达小时窗 → 被限请求没写记录。
    expect(mock.recordCalls.length).toBe(written);
    // 远未触及小时上限（写入数 ≪ 100），证明触发的是分钟窗而非小时窗。
    expect(written).toBeLessThan(SUBMIT_HOUR_LIMIT);
  });

  it("Scenario: 不同 IP 各自独立计数互不影响 (submit 写飞书面)", async () => {
    // Given 一个 IP 已把该端点窗口内的配额刷满 (打满分钟窗并触发 429)
    const ipA = freshIp();
    const aDenied = await hammerUntil429(
      (b) => postSubmit(ipA, b),
      SUBMIT_MINUTE_LIMIT,
      submission,
      200,
    );
    expect(aDenied.status).toBe(429); // ipA 已被限

    // When 另一个不同 IP 对同一端点发请求
    const bRes = await postSubmit(freshIp(), submission());

    // Then 该请求被放行
    // And 它不受第一个 IP 已超限的影响 (新 IP 正常 200 写飞书)
    expect(bRes.status).toBe(200);
    expect((await bRes.json()) as { ok?: boolean }).toMatchObject({ ok: true });
  });
});

// =============================================================================
// 窗口重置：时间推进到下一个固定窗口后计数清零、请求恢复放行
// =============================================================================
describe("公开端点限流 / 防刷 — 窗口重置 (workers/features/rate-limit.feature, §25)", () => {
  beforeAll(async () => {
    await applySchema();
  });
  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    await resetUsers();
    await resetAuthTokens();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Scenario: 窗口过期后计数清零请求恢复放行", async () => {
    // Given 某 IP 已在当前窗口内对某公开端点 (login, 60s 窗) 触发限流
    // 固定窗口键含 windowStart=floor(now/60)*60。用 fake timers 把 system clock 钉在一个窗口里，
    // 打满 + 触发 429，再把时钟推进一整个窗口 → 新 windowStart → 新键 → 计数清零。
    const ip = freshIp();
    const t0 = 1_700_000_400_000; // 落在某 60s 窗口起点（毫秒；1_700_000_400 % 60 === 0）
    vi.useFakeTimers({ toFake: ["Date"] }); // 只伪造 Date（驱动窗口数学），不动真正的 I/O 定时器
    vi.setSystemTime(t0);

    // 在当前窗口内打到触发 429（margin 容忍 KV 少计）。
    const denied = await hammerUntil429(
      (b) => postLogin(ip, b),
      LOGIN_LIMIT,
      () => ({ email: uniqueEmail(), password: "whatever" }),
      401,
    );
    expect(denied.status).toBe(429); // 确已在当前窗口触发限流

    // When 时间推进到下一个固定窗口 (+61s，跨过 60s 窗口边界 → windowStart 改变 → 新键 → 计数清零)
    vi.setSystemTime(t0 + 61_000);

    // And 该 IP 再发一次请求
    const recovered = await postLogin(ip, { email: uniqueEmail(), password: "whatever" });

    // Then 该请求被放行
    expect(recovered.status).not.toBe(429);
    // And 它进入该端点的业务逻辑 (login 的业务 401)
    expect(recovered.status).toBe(401);
  });
});

// =============================================================================
// fail-open：KV 读 / 写抛错时仍放行正常请求，且不向日志 / 响应泄漏 IP 与键
// =============================================================================
describe("公开端点限流 / 防刷 — fail-open (workers/features/rate-limit.feature, §25)", () => {
  // 在 HTTP 层注入 KV 故障：测试与 Worker 跑在同一 isolate，c.env.RATE_LIMIT 与 testEnv.RATE_LIMIT
  // 是同一个 binding 对象。把它的 get / put 改成 throw → checkRateLimit 内部 try/catch 命中 →
  // fail-open 放行（§25.7）。afterEach 还原原方法。
  let originalGet: typeof testEnv.RATE_LIMIT.get;
  let originalPut: typeof testEnv.RATE_LIMIT.put;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    await applySchema();
  });
  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    await resetUsers();
    await resetAuthTokens();
    originalGet = testEnv.RATE_LIMIT.get.bind(testEnv.RATE_LIMIT);
    originalPut = testEnv.RATE_LIMIT.put.bind(testEnv.RATE_LIMIT);
    // 捕获 console.error 以断言 fail-open 日志里不泄漏 IP / 键（§25.7）。
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    // 还原 KV 方法 + console.error。
    (testEnv.RATE_LIMIT as { get: unknown }).get = originalGet;
    (testEnv.RATE_LIMIT as { put: unknown }).put = originalPut;
    errSpy.mockRestore();
  });

  /** Force the rate-limit KV's get + put to throw, exercising the §25.7 fail-open path. */
  function breakRateLimitKV(): void {
    (testEnv.RATE_LIMIT as { get: unknown }).get = () => {
      throw new TypeError("KV get boom");
    };
    (testEnv.RATE_LIMIT as { put: unknown }).put = () => {
      throw new TypeError("KV put boom");
    };
  }

  it("Scenario: KV 读写故障时 fail-open 仍放行正常请求", async () => {
    // Given 一个挂了限流的公开端点 (POST /api/auth/register)
    // And 限流计数所依赖的 KV 读或写抛错
    breakRateLimitKV();
    const resend = installResendMock();
    try {
      // When 一个正常请求到达该端点
      const res = await postRegister(freshIp(), { email: uniqueEmail(), password: TEST_PASSWORD });

      // Then 该请求被放行
      // And 响应状态码与未限流时一致而不是 429 或 5xx (register 正常 201)
      expect(res.status).toBe(201);
      expect(res.status).not.toBe(429);
      expect(res.status).toBeLessThan(500); // 不是 5xx
      // 限流器自身故障没把正常请求打挂：handler 照常运行（创建用户、签 token）。
      const body = (await res.json()) as { token?: string };
      expect(body.token).toBeTypeOf("string");
    } finally {
      resend.restore();
    }
  });

  it("Scenario: fail-open 时不向日志或响应泄漏 IP 与键", async () => {
    // Given 限流计数所依赖的 KV 抛错触发 fail-open
    const RAW_IP = freshIp(); // 独特、可子串扫描的 IP（每次运行唯一）
    breakRateLimitKV();
    const resend = installResendMock();
    try {
      // When 该请求被放行
      const res = await postRegister(RAW_IP, { email: uniqueEmail(), password: TEST_PASSWORD });
      expect(res.status).toBe(201); // 已 fail-open 放行

      // Then 整个响应里不包含访客原始 IP
      const raw = await res.clone().text();
      expect(raw).not.toContain(RAW_IP);
      for (const [, value] of res.headers) {
        expect(value).not.toContain(RAW_IP);
      }

      // And 整个响应里不包含限流计数键的内容 (rl: 前缀 / hash 段)
      expect(raw).not.toContain("rl:");

      // 日志同样不泄漏 (fail-open 只记 err.name)：扫所有 console.error 参数。
      const logged = errSpy.mock.calls.flat().map(String).join(" | ");
      expect(logged).not.toContain(RAW_IP);
      expect(logged).not.toContain("rl:");
    } finally {
      resend.restore();
    }
  });
});
