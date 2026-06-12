// Shared test helpers for the owner-config outer-loop specs.
//
// Test environment notes (see vitest.config.ts / wrangler.toml):
//   - `DB`        : local miniflare D1, bound from wrangler.toml [[d1_databases]].
//                   vitest-pool-workers gives each test a fresh, isolated copy of
//                   storage, so we (re)apply the schema in a per-suite setup.
//   - `CONFIG_KEY`: throwaway base64 256-bit AES key, injected as a miniflare
//                   binding in vitest.config.ts.
//
// The schema lives in wrangler D1 migrations (migrations/*.sql), applied to prod
// via `wrangler d1 migrations apply`. Tests apply the same schema migration(s) to
// the miniflare D1 here. One-time DATA backfills live in runbooks/ (out of the
// migrations dir) and are NOT applied in tests.

import { env, SELF } from "cloudflare:test";
import { vi } from "vitest";
import initialSchema from "../migrations/0001_initial_schema.sql?raw";
import authTokensSchema from "../migrations/0002_auth_tokens.sql?raw";

// Schema migrations applied to the test D1, in order — mirrors what prod gets via
// `wrangler d1 migrations apply`. Append future schema migrations to this list.
//   0001 — users / owner_config / forms.
//   0002 — auth_tokens (邮箱验证 + 找回密码的一次性 token，§22.4 / §23 / §24).
const SCHEMA_MIGRATIONS = [initialSchema, authTokensSchema];

/** The bindings the owner-config + owner-auth features rely on, surfaced for the tests. */
export interface TestEnv {
  DB: D1Database;
  CONFIG_KEY: string;
  /** session JWT 的 HMAC 签名密钥 — fixed throwaway value injected in vitest.config.ts (§17.6). */
  AUTH_SECRET: string;
}

export const testEnv = env as unknown as TestEnv;

/**
 * Strip SQL line comments and split into individual statements.
 *
 * `D1Database.exec` is line-oriented: it splits on newlines and chokes on both
 * the `--` comment block and the multi-line `CREATE TABLE` in schema.sql. We
 * strip comments, then collapse each statement onto a single line so `exec`
 * sees one complete statement per call.
 */
function toStatements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return (i === -1 ? line : line.slice(0, i)).trim();
    })
    .filter((line) => line.length > 0)
    .join(" ")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Apply the schema migrations to the test D1 (idempotent — each migration uses
 * `CREATE TABLE IF NOT EXISTS`). Call in `beforeAll`.
 */
export async function applySchema(): Promise<void> {
  for (const migration of SCHEMA_MIGRATIONS) {
    for (const stmt of toStatements(migration)) {
      await testEnv.DB.exec(stmt);
    }
  }
}

/** Empty the single-row config table between scenarios. */
export async function resetConfig(): Promise<void> {
  await testEnv.DB.exec("DELETE FROM owner_config");
}

/**
 * Empty the `forms` table between scenarios (symmetric to {@link resetConfig}).
 * The form-publish outer-loop counts rows / re-publishes per scenario, so each
 * one must start from a clean `forms` table.
 *
 * `applySchema` already builds this table: it runs every statement in the schema
 * migration(s), which include the `CREATE TABLE IF NOT EXISTS forms` block — so no
 * change to `applySchema` is needed, only this reset.
 */
export async function resetForms(): Promise<void> {
  await testEnv.DB.exec("DELETE FROM forms");
}

/**
 * Empty the `users` table between scenarios. The owner-auth + tenant-isolation
 * outer-loops register accounts per scenario (and assert on uniqueness / counts),
 * so each one must start from a clean `users` table.
 */
export async function resetUsers(): Promise<void> {
  await testEnv.DB.exec("DELETE FROM users");
}

/**
 * Empty the `auth_tokens` table between scenarios (§22.4). The email-verification /
 * password-reset outer-loops issue + consume one-shot tokens per scenario, so each
 * must start from a clean table. `applySchema` already builds it (0002 migration).
 */
export async function resetAuthTokens(): Promise<void> {
  await testEnv.DB.exec("DELETE FROM auth_tokens");
}

// --- Upstream (DeepSeek) fetch mock ----------------------------------------
//
// vitest-pool-workers 0.16.14 no longer exports `fetchMock` from `cloudflare:test`
// (the old undici MockAgent surface is gone). The supported, fully test-local
// mechanism is a global `fetch` stub: the cloudflare:test docs guarantee the
// `main` Worker reached via `SELF.fetch` runs in the SAME isolate as the test, so
// "any global mocks will apply to it too". We exploit that to intercept the
// Worker's outbound call to https://api.deepseek.com without ever touching the
// network.
//
// `installUpstreamMock` is default-deny: it throws on any origin other than the
// configured upstream, so a missing/broken proxy implementation can never silently
// reach the real api.deepseek.com — it fails loudly instead.

/** The OpenAI-compatible upstream the proxy must call (SPEC.md §13.1). */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** One captured outbound request to the upstream. */
export interface UpstreamCall {
  url: string;
  method: string;
  /** Lower-cased header lookups via the captured Headers. */
  headers: Headers;
  /** Raw request body text (the JSON the proxy sent upstream). */
  bodyText: string;
  /** Parsed body, or `undefined` when the body was not valid JSON. */
  body: unknown;
}

/** What the mocked upstream should reply with for the next call(s). */
export interface UpstreamReply {
  status?: number;
  /** Response body bytes (e.g. an SSE transcript, or a JSON error string). */
  body?: string;
  /** Response headers (defaults to text/event-stream for the success path). */
  headers?: Record<string, string>;
}

/** Handle returned by {@link installUpstreamMock} for per-test assertions. */
export interface UpstreamMock {
  /** Every outbound request the Worker made to the upstream, in order. */
  readonly calls: UpstreamCall[];
  /** Convenience: was the upstream contacted at all? */
  called(): boolean;
  /** Restore the real global fetch (call in afterEach). */
  restore(): void;
}

/**
 * Stub the global `fetch` so the Worker's outbound call to the DeepSeek upstream
 * is captured and answered locally.
 *
 * - Requests whose origin is {@link DEEPSEEK_BASE_URL} are recorded and answered
 *   with `reply` (defaults to a 200 `text/event-stream`).
 * - Requests to ANY other origin throw — guaranteeing tests never hit the real
 *   network, and surfacing an unexpected fan-out as a hard failure.
 *
 * The reply body is returned verbatim so the success-path test can assert the
 * proxy透传ed the upstream SSE bytes unchanged.
 */
export function installUpstreamMock(reply: UpstreamReply = {}): UpstreamMock {
  const calls: UpstreamCall[] = [];
  const status = reply.status ?? 200;
  const body = reply.body ?? "";
  const headers = reply.headers ?? { "content-type": "text/event-stream" };

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    if (!req.url.startsWith(DEEPSEEK_BASE_URL)) {
      // Default-deny: the proxy must only ever talk to the configured upstream.
      throw new Error(
        `unexpected outbound fetch to ${req.url} (only ${DEEPSEEK_BASE_URL} is mocked)`,
      );
    }
    const bodyText = await req.clone().text();
    let parsed: unknown;
    try {
      parsed = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
    } catch {
      parsed = undefined;
    }
    calls.push({
      url: req.url,
      method: req.method,
      headers: new Headers(req.headers),
      bodyText,
      body: parsed,
    });
    return new Response(body, { status, headers });
  });

  return {
    calls,
    called: () => calls.length > 0,
    restore: () => vi.unstubAllGlobals(),
  };
}

// --- Resend (transactional email) fetch mock --------------------------------
//
// 邮箱验证 / 找回密码 真发信走 Resend 的纯 HTTP API（src/email.ts → POST
// https://api.resend.com/emails）。外环要 mock 掉这次出网：既断言「发没发 / 发给谁」，
// 又能从拦截到的请求 body（邮件 html）里提取 `?token=` 明文，再拿它去调 confirm 端点
// （最忠实于真实流程，§22.1 / §23.4 / §24.3）。
//
// 与 installUpstreamMock 同样是 default-deny 的全局 fetch stub：只放行 Resend 端点，
// 其它 origin 一律抛错——register / login / verify / reset 这些流程本不该 fan-out 到任何
// 别的上游，所以意外出网就硬失败暴露出来（而非静默打到真实网络）。

/** The Resend send-email endpoint the email layer POSTs to (SPEC.md §22.1). */
export const RESEND_API_URL = "https://api.resend.com/emails";

/** One captured outbound request to Resend (a transactional send). */
export interface ResendCall {
  /** Recipient (the `to` field of the Resend body). */
  to: string;
  /** Email subject. */
  subject: string;
  /** Email body HTML (carries the one-shot landing link with ?token=). */
  html: string;
  /** The `Authorization` header value the Worker sent (to assert key wiring / non-leak). */
  authorization: string | null;
  /** The raw parsed Resend request body. */
  body: { from?: string; to?: string; subject?: string; html?: string };
}

/** Handle returned by {@link installResendMock} for per-test assertions. */
export interface ResendMock {
  /** Every send the Worker made, in order. */
  readonly calls: ResendCall[];
  /** Convenience: how many sends happened. */
  count(): number;
  /** The most recent send (throws if none — call after asserting count ≥ 1). */
  last(): ResendCall;
  /**
   * Wait until at least `n` sends have been captured (default 1), polling the mock.
   * Register / verify / reset发信 happen in `c.executionCtx.waitUntil(...)` (background,
   * §22.2 / §23.2), so under SELF.fetch the send may land AFTER the HTTP response
   * resolves. Tests await this before asserting on the captured email. Times out
   * (rejects) after ~1s so a never-sent expectation still fails loudly.
   */
  waitForSends(n?: number): Promise<void>;
  /**
   * Assert (after letting any background sends drain) that NO send happened — for the
   * 未注册邮箱 / 已验证 no-op paths (§24.1 / §23.3). Waits a short beat first so a
   * stray background send can't sneak in after the assertion.
   */
  expectNoSend(): Promise<void>;
  /**
   * Extract the one-shot token from a captured email's link (the `?token=` plaintext
   * the user would click). Defaults to the most recent send. URL-decoded, mirroring
   * how the backend encodeURIComponent-wraps it into the link (§23.3 / §24.2).
   */
  tokenFrom(call?: ResendCall): string;
  /** Restore the real global fetch (call in afterEach). */
  restore(): void;
}

/**
 * Stub the global `fetch` so the Worker's outbound Resend send is captured + answered
 * locally — never hitting the real api.resend.com.
 *
 * @param opts.status upstream status to return (default 200 = delivered). Pass a 5xx
 *   to exercise the best-effort / 防枚举 paths where a send FAILURE must not change the
 *   endpoint's outward behavior (注册仍 201、request 仍 200，§22.2 / §23.2 / §24.1).
 */
export function installResendMock(opts: { status?: number } = {}): ResendMock {
  const calls: ResendCall[] = [];
  const status = opts.status ?? 200;

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    if (!req.url.startsWith(RESEND_API_URL)) {
      // Default-deny: these auth flows must only ever talk to Resend (no DeepSeek / 飞书).
      throw new Error(`unexpected outbound fetch to ${req.url} (only ${RESEND_API_URL} is mocked)`);
    }
    const bodyText = await req.clone().text();
    let body: ResendCall["body"] = {};
    try {
      body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
    } catch {
      body = {};
    }
    calls.push({
      to: typeof body.to === "string" ? body.to : "",
      subject: typeof body.subject === "string" ? body.subject : "",
      html: typeof body.html === "string" ? body.html : "",
      authorization: req.headers.get("authorization"),
      body,
    });
    // 2xx → delivered; a forced 5xx makes sendEmail throw EmailSendError (best-effort
    // callers swallow it — the endpoint's status code must not change, §22.2).
    return new Response(status >= 200 && status < 300 ? "{}" : "upstream error", { status });
  });

  const tokenFrom = (call?: ResendCall): string => {
    const c = call ?? calls[calls.length - 1];
    if (!c) return "";
    // The token rides the landing link as ?token=<plaintext> (encodeURIComponent'd by
    // the backend). Pull it out + URL-decode it, exactly as the user's click would.
    const m = c.html.match(/[?&]token=([^"&\s]+)/);
    if (!m) return "";
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const waitForSends = async (n = 1): Promise<void> => {
    const deadline = Date.now() + 1000;
    while (calls.length < n) {
      if (Date.now() > deadline) {
        throw new Error(`installResendMock: expected ≥ ${n} send(s), saw ${calls.length}`);
      }
      await sleep(5);
    }
  };

  const expectNoSend = async (): Promise<void> => {
    // Let any background waitUntil send drain, then assert none landed.
    await sleep(50);
    if (calls.length !== 0) {
      throw new Error(`installResendMock: expected NO send, saw ${calls.length}`);
    }
  };

  return {
    calls,
    count: () => calls.length,
    last: () => {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("installResendMock: no Resend send captured");
      return c;
    },
    waitForSends,
    expectNoSend,
    tokenFrom,
    restore: () => vi.unstubAllGlobals(),
  };
}

// --- owner auth helpers (SPEC.md §17, open-registration multi-user) ----------
//
// owner-only endpoints sit behind requireAuth. After the multi-user rework, there
// is no fixed OWNER_PASSWORD — every owner is a real `users` row keyed by a random
// email + password. Outer-loop suites that drive owner-only endpoints first
// REGISTER a real account (注册即登录, §17.2) to obtain a session JWT, then send it
// as `Authorization: Bearer <token>`. The token's `sub` is that user's real id —
// the same data-isolation key prod would issue (signed with the test AUTH_SECRET).
//
// `login()` registers a FRESH, unique account each call (random email) so it never
// collides with a leftover row across scenarios, regardless of storage isolation —
// the suites that relied on the old single-owner login keep working unchanged.
// `registerOwner()` / `registerAndLogin()` are the multi-owner seam for the
// tenant-isolation suite: each produces a distinct owner with its own token.

/** Base origin for SELF.fetch requests in the worker tests. */
export const AUTH_BASE = "https://api.local";

/** A throwaway password (≥ MIN_PASSWORD_LENGTH=8) used by the auth setup helpers. */
export const TEST_PASSWORD = "correct-horse-battery-staple";

/** Monotonic counter so each registered email in a run is unique. */
let emailCounter = 0;

/** Mint a unique, shape-valid throwaway email for a fresh test account. */
export function uniqueEmail(prefix = "owner"): string {
  emailCounter += 1;
  return `${prefix}-${Date.now()}-${emailCounter}@test.local`;
}

/**
 * The result of registering / logging in a test owner: the session token plus the
 * real credentials, so the tenant-isolation suite can re-login the SAME owner.
 */
export interface TestOwner {
  /** The session JWT (Bearer) — its `sub` is this owner's real user id (§17.5). */
  token: string;
  /** The email this owner registered with (unique per call). */
  email: string;
  /** The plaintext password this owner registered with. */
  password: string;
}

/**
 * Register a fresh owner via the real public `POST /api/auth/register` and return
 * its token + credentials. 注册即登录 (§17.2): the 201 response carries a session
 * JWT whose sub is the NEW user's real id — the data-isolation key for every
 * owner-only endpoint. Throws if register does not return a 201 `{ token }`.
 */
export async function registerOwner(
  opts: { email?: string; password?: string } = {},
): Promise<TestOwner> {
  const email = opts.email ?? uniqueEmail();
  const password = opts.password ?? TEST_PASSWORD;
  const res = await SELF.fetch(`${AUTH_BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 201) {
    throw new Error(`setup register failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { token?: string };
  if (typeof json.token !== "string" || json.token.length === 0) {
    throw new Error(`setup register returned no token: ${JSON.stringify(json)}`);
  }
  return { token: json.token, email, password };
}

/**
 * Log in an already-registered owner via the real public `POST /api/auth/login`
 * and return a fresh session JWT. Throws if login does not return a 200 `{ token }`.
 */
export async function loginOwner(email: string, password: string): Promise<string> {
  const res = await SELF.fetch(`${AUTH_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`setup login failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { token?: string };
  if (typeof json.token !== "string" || json.token.length === 0) {
    throw new Error(`setup login returned no token: ${JSON.stringify(json)}`);
  }
  return json.token;
}

/**
 * Register a fresh owner and return only its session JWT — the drop-in replacement
 * for the old single-owner `login()`. Used by every owner-only outer-loop suite
 * (config / conntest / chat / forms / submissions) that just needs "a logged-in
 * owner's token", without caring about the specific account.
 */
export async function login(): Promise<string> {
  const { token } = await registerOwner();
  return token;
}

/** Build an `Authorization: Bearer <token>` header object for owner-only requests. */
export function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
