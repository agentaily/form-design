// auth.ts — type contracts for owner 鉴权（方案 A：owner 密码 → session JWT）.
// See SPEC.md §17 (后端 · owner 鉴权).
//
// 方案 A：owner 用预置密码（Worker secret OWNER_PASSWORD）登录 → 后端校验后签发一个
// 短期 session JWT（用 Worker secret AUTH_SECRET 以 HS256 签名）→ owner-only 端点凭
// `Authorization: Bearer <jwt>` 通行。MVP 单 owner：payload 的 `sub` 恒为 'default'
// （对齐 owner_config.owner_id / forms.owner_id）。
//
// 实现建议：复用 Hono 内置的 `hono/jwt`（`sign` / `verify`）。`requireAuth` 既可直接
// 用 `hono/jwt` 的 `jwt({ secret })` 中间件，也可在此基于 `verify` 写一个薄中间件（统一
// 401 文案 + 把 session 挂到 c.set('session', ...)）。两者皆可，只要满足 §17.4 的可观察
// 行为：缺/坏/过期 token → 401 { error }，不进入 handler；通过则放行并挂上 session。
//
// 安全（§17.7）：OWNER_PASSWORD / AUTH_SECRET 只在 Worker 内用于比对 / 签名验签，绝不进
// token payload、响应体、HTTP 头、日志；401 文案只表「未授权」，不泄漏可辅助爆破/伪造的细节。
//
// Layering: the pure / mockable seams below are the inner-loop unit-test targets:
//   - signSession:   纯签名（密码已校验过 → 签发带 sub+exp 的 JWT），
//   - verifySession: 纯验签（验签 + exp 未过 → Session | null）.
// The login route (`POST /api/auth/login`) 与 `requireAuth` 中间件 sit on top in
// index.ts / 此处，由 outer-loop 通过 SELF.fetch 驱动。

import type { Env, MiddlewareHandler } from "hono";
import { sign, verify } from "hono/jwt";

// ---------------------------------------------------------------------------
// 单 owner 约定 + 默认时长
// ---------------------------------------------------------------------------

/** MVP 单 owner：session 的 `sub` 恒为 'default'（对齐 owner_config / forms 的 owner_id）。 */
export const DEFAULT_OWNER_SUB = "default";

/** session JWT 的默认有效期（秒）。带 `exp` 是硬约定（§17.3）；具体时长可由实现在合约内调整。 */
export const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;

/** session JWT 的签名算法（§17.3）。`hono/jwt` 的 sign/verify 用同一 alg。 */
export const SESSION_JWT_ALG = "HS256";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 解码后的 session JWT payload（§17.3）。MVP 单 owner：`sub` 恒为
 * {@link DEFAULT_OWNER_SUB}。payload 是可被客户端解码的（JWT 仅签名、非加密），
 * 因此**只**承载非敏感物——绝不放 OWNER_PASSWORD / AUTH_SECRET / 任何 owner 凭据。
 */
export interface Session {
  /** 单 owner 恒为 'default'；将来多 owner 换成真实租户键。 */
  sub: string;
  /** 过期时间（Unix 秒）。验签时校验未过期。 */
  exp: number;
  /** 可选签发时间（Unix 秒）。 */
  iat?: number;
}

/** `POST /api/auth/login` 的请求体（§17.2）。 */
export interface LoginRequest {
  /** owner 登录密码（与 OWNER_PASSWORD 明文比对）。 */
  password: string;
}

/** `POST /api/auth/login` 成功响应（§17.2）：只回 token，绝不回 secret。 */
export interface LoginResult {
  /** 签发的 session JWT（HS256，payload 含 sub='default' + exp）。 */
  token: string;
}

/**
 * owner-only 端点 / 登录失败的统一错误体（§17.2、§17.4）。`error` 只表「未授权」语义，
 * 绝不包含 AUTH_SECRET、被拒 token 的内容、或任何可辅助伪造 / 爆破的细节（§17.7）。
 */
export interface AuthErrorBody {
  error: string;
}

/**
 * Hono context 上挂 session 的变量键（§17.4）：`requireAuth` 校验通过后
 * `c.set('session', session)`，下游 owner-only handler 可 `c.get('session')` 取用。
 */
export interface AuthVariables {
  session: Session;
}

// ---------------------------------------------------------------------------
// 纯逻辑：签 / 验 session（实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * 签发一个 session JWT（§17.3）。**前提**：调用方（login route）已校验过 owner 密码，
 * 此函数只负责签名——不接触 OWNER_PASSWORD，不比对密码。
 *
 * - payload 至少含 `sub`（默认 {@link DEFAULT_OWNER_SUB}）+ `exp`（默认 now +
 *   {@link DEFAULT_SESSION_TTL_SECONDS}）；可附 `iat`。
 * - 用 `secret`（AUTH_SECRET）以 {@link SESSION_JWT_ALG} 签名（建议复用 `hono/jwt`
 *   的 `sign`）。
 * - 返回的 token 与其 payload **绝不**包含 AUTH_SECRET / OWNER_PASSWORD（§17.7）。
 *
 * @param secret AUTH_SECRET（Worker secret）。
 * @param options 可选：覆盖 `sub` / TTL（MVP 用默认即可）。
 * @returns 签好的 JWT 字符串。
 */
export async function signSession(
  secret: string,
  options?: { sub?: string; ttlSeconds?: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = options?.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  // payload carries ONLY non-sensitive claims — never AUTH_SECRET / OWNER_PASSWORD
  // / any owner credential (§17.3 / §17.7). JWT is signed, not encrypted.
  const payload = {
    sub: options?.sub ?? DEFAULT_OWNER_SUB,
    iat: now,
    exp: now + ttl,
  };
  return sign(payload, secret, SESSION_JWT_ALG);
}

/**
 * 验签 + 校验未过期，解出 {@link Session}（§17.4）。
 *
 * - 用 `secret`（AUTH_SECRET）验签（建议复用 `hono/jwt` 的 `verify`，它同时校验 `exp`）。
 * - 验签失败 / 已过期 / payload 形状非法（缺 `sub` / `exp`）→ 返回 `null`（中间件据此回 401）。
 * - 成功 → 返回解出的 `Session`（至少 `sub` + `exp`）。
 * - **绝不抛敏感细节**：失败一律收敛成 `null`，不把被拒 token 内容 / 验签原因泄漏给上层。
 *
 * @param token 从 `Authorization: Bearer <jwt>` 取出的 JWT 字符串。
 * @param secret AUTH_SECRET（Worker secret）。
 * @returns 校验通过的 `Session`，否则 `null`。
 */
export async function verifySession(token: string, secret: string): Promise<Session | null> {
  try {
    // `hono/jwt`'s verify both checks the HS256 signature and enforces `exp`;
    // any failure (bad signature / expired / malformed) throws — we converge ALL
    // of them to null so nothing sensitive (secret / token internals / verify
    // reason) ever surfaces upward (§17.4 / §17.7).
    const payload = await verify(token, secret, SESSION_JWT_ALG);
    // payload shape must carry at least sub + exp; anything else → reject as null.
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") {
      return null;
    }
    return {
      sub: payload.sub,
      exp: payload.exp,
      ...(typeof payload.iat === "number" ? { iat: payload.iat } : {}),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// auth 中间件（横切，挂在 owner-only 端点上，§17.4 / §17.5）
// ---------------------------------------------------------------------------

/**
 * owner-only 端点的 auth 中间件工厂（§17.4）。返回一个 Hono 中间件：
 *
 * - 从 `Authorization` 头解析 `Bearer <jwt>`；缺头 / 非 `Bearer ` 前缀 → `401 { error }`，
 *   **不**调用 `next()`（不进入 handler）。
 * - 用 `secret`（AUTH_SECRET）经 {@link verifySession} 验签 + 校验未过期；失败 / 过期 /
 *   payload 非法 → `401 { error }`。
 * - 通过 → `c.set('session', session)` 后 `await next()`，把控制权交给 owner-only handler。
 * - 401 的 `{ error }` 只表「未授权」，绝不含 AUTH_SECRET / 被拒 token 内容 / 验签原因（§17.7）。
 *
 * 实现选型（§17.4）：可在此基于 {@link verifySession} 自写薄中间件，或直接返回
 * `hono/jwt` 的 `jwt({ secret })`——两者皆可，只要满足上面的可观察行为。
 *
 * 挂载方式见 §17.5 / index.ts：公开端点（GET /api/forms/:slug、POST /api/submit、
 * GET /health、POST /api/auth/login）**不**挂；owner-only 端点（GET/POST /api/config、
 * POST /api/config/test、POST /api/chat、POST /api/forms、
 * GET /api/forms/:slug/submissions）挂。**注意**：不能用一句
 * `app.use('/api/forms/*', requireAuth(...))` 把公开的 `GET /api/forms/:slug` 也罩进去——
 * 用 method 级中间件 / 精确路径只保护 owner-only 的那几条。
 *
 * @param secret AUTH_SECRET（取自 c.env.AUTH_SECRET）。
 * @returns 一个校验 `Authorization: Bearer <jwt>` 的 Hono 中间件。
 */
export function requireAuth<E extends Env = { Variables: AuthVariables }>(
  secret: string,
): MiddlewareHandler<E & { Variables: AuthVariables }> {
  return async (c, next) => {
    // Parse `Authorization: Bearer <jwt>`; missing header / non-Bearer prefix →
    // 401, never entering the handler (§17.4). The 401 body only says "未授权",
    // never echoing AUTH_SECRET / the rejected token / a verify reason (§17.7).
    const header = c.req.header("Authorization");
    const token =
      header && header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
    if (token === null || token.length === 0) {
      return c.json({ error: "未授权" } satisfies AuthErrorBody, 401);
    }
    const session = await verifySession(token, secret);
    if (session === null) {
      return c.json({ error: "未授权" } satisfies AuthErrorBody, 401);
    }
    c.set("session", session);
    await next();
  };
}
