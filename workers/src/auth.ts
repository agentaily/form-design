// auth.ts — type contracts for owner 鉴权（多用户：邮箱 + 密码 → session JWT）.
// See SPEC.md §17 (后端 · owner 鉴权：多用户注册登录).
//
// 多用户：owner 用邮箱 + 密码**注册**（注册即登录，§17.2）或**登录**（§17.3）→ 后端
// 校验后签发一个短期 session JWT（用 Worker secret AUTH_SECRET 以 HS256 签名，
// payload 的 `sub` 是该用户的**真实 user id**，对齐 owner_config.owner_id / forms.owner_id）
// → owner-only 端点凭 `Authorization: Bearer <jwt>` 通行，且按 `sub` 隔离数据（§17.9）。
// 密码哈希在 password.ts / 用户数据层在 users.ts；本文件只管 session 的签 / 验 / 中间件。
//
// 实现建议：复用 Hono 内置的 `hono/jwt`（`sign` / `verify`）。`requireAuth` 既可直接
// 用 `hono/jwt` 的 `jwt({ secret })` 中间件，也可在此基于 `verify` 写一个薄中间件（统一
// 401 文案 + 把 session 挂到 c.set('session', ...)）。两者皆可，只要满足 §17.6 的可观察
// 行为：缺/坏/过期 token → 401 { error }，不进入 handler；通过则放行并挂上 session。
//
// 安全（§17.6 / §17.8）：AUTH_SECRET 只在 Worker 内用于签名 / 验签，绝不进 token payload、
// 响应体、HTTP 头、日志；401 文案只表「未授权」，不泄漏可辅助爆破/伪造的细节。
//
// Layering: the pure / mockable seams below are the inner-loop unit-test targets:
//   - signSession:   纯签名（凭据已校验过 → 签发带 sub(=真实 user id)+exp 的 JWT），
//   - verifySession: 纯验签（验签 + exp 未过 → Session | null）.
// register / login routes 与 `requireAuth` 中间件 sit on top in index.ts / 此处，
// 由 outer-loop 通过 SELF.fetch 驱动。

import type { Env, MiddlewareHandler } from "hono";
import { sign, verify } from "hono/jwt";

// ---------------------------------------------------------------------------
// 默认时长 + 算法 + 迁移期兜底 sub
// ---------------------------------------------------------------------------

/**
 * 迁移期的兜底 owner id（'default'）。多用户改造后 session 的 `sub` 是**真实 user id**
 * （§17.5），不再用此常量签发；保留它只为迁移脚本 `002-migrate-default-owner.sql` 的字面量
 * 参照（把现有 owner_id='default' 的行迁给首个注册账号，§17 引言）。新代码**不**用它做 sub。
 */
export const LEGACY_DEFAULT_OWNER_SUB = "default";

/** session JWT 的默认有效期（秒）。带 `exp` 是硬约定（§17.5）；具体时长可由实现在合约内调整。 */
export const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;

/** session JWT 的签名算法（§17.5）。`hono/jwt` 的 sign/verify 用同一 alg。 */
export const SESSION_JWT_ALG = "HS256";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 解码后的 session JWT payload（§17.5）。多用户：`sub` 是该 owner 的**真实 user id**
 * （`users.id`，crypto.randomUUID()）——既是 session 主体，也是数据隔离键（对齐
 * owner_config.owner_id / forms.owner_id；owner-only handler `const ownerId =
 * c.get('session').sub` 据此过滤数据，§17.9）。payload 是可被客户端解码的（JWT 仅签名、
 * 非加密），因此**只**承载非敏感物——绝不放 AUTH_SECRET / 密码 / password_hash / 任何 owner 凭据。
 */
export interface Session {
  /** 该 owner 的真实 user id（`users.id`）；既是 session 主体也是数据隔离键（§17.5 / §17.9）。 */
  sub: string;
  /** 过期时间（Unix 秒）。验签时校验未过期。 */
  exp: number;
  /** 可选签发时间（Unix 秒）。 */
  iat?: number;
}

/** `POST /api/auth/register` 的请求体（§17.2，注册即登录）。 */
export interface RegisterRequest {
  /** 注册邮箱（登录名 + 唯一标识；形状校验在 users.ts，§17.2）。 */
  email: string;
  /** 注册明文密码（强度 ≥ 8 位，校验在 users.ts；派生哈希在 password.ts，明文绝不入库）。 */
  password: string;
}

/** `POST /api/auth/login` 的请求体（§17.3）。 */
export interface LoginRequest {
  /** 登录邮箱（用于 findUserByEmail，§17.3）。 */
  email: string;
  /** 登录明文密码（与存的 PBKDF2 派生 hash 经 verifyPassword 常量时间比对，§17.4）。 */
  password: string;
}

/**
 * `POST /api/auth/register`（201）/ `POST /api/auth/login`（200）成功响应（§17.2 / §17.3）：
 * 只回 token（其 `sub` 是该 user 的真实 id），绝不回 secret / 密码 / password_hash。
 */
export interface LoginResult {
  /** 签发的 session JWT（HS256，payload 含 sub=真实 user id + exp）。 */
  token: string;
}

/**
 * owner-only 端点 / 登录失败的统一错误体（§17.3、§17.6）。`error` 只表「未授权」语义，
 * 绝不包含 AUTH_SECRET、被拒 token 的内容、或任何可辅助伪造 / 爆破的细节（§17.6）。
 */
export interface AuthErrorBody {
  error: string;
}

/**
 * Hono context 上挂 session 的变量键（§17.6）：`requireAuth` 校验通过后
 * `c.set('session', session)`，下游 owner-only handler 可 `c.get('session')` 取用
 * （`c.get('session').sub` 即当前 owner 的真实 user id，用于按 owner 隔离数据，§17.9）。
 */
export interface AuthVariables {
  session: Session;
}

// ---------------------------------------------------------------------------
// 常量时间字符串比较（§17.10，安全 nit）（实现已就绪，纯函数）
// ---------------------------------------------------------------------------

/**
 * 常量时间字符串比较（§17.10）。供 `verifyPassword`（password.ts，§17.4）比对 PBKDF2
 * 重算出的派生 hash 与存储 hash，替代朴素的 `===`/`!==`（短路比较会泄漏「第几位开始不同」
 * 的时序信号，给计时攻击逐位猜的可乘之机）。
 *
 * 契约（实现在合约内）：
 * - 比对耗时只与输入长度有关、与首个不同位的位置无关——**全程不短路**（不在第一个不同字节
 *   就提前 return）。
 * - 实现思路：`TextEncoder` 把两侧编码成字节，逐字节异或累积（`acc |= ai ^ bi`），最后用
 *   `acc === 0` 且长度相等判等。长度不同 → 返回 `false`，但仍跑完固定步数、不提前 return。
 * - 入参与返回都不含也不回显任何 secret；只返回布尔，绝不把密码 / hash 写进日志或响应（§17.6）。
 *
 * `AUTH_SECRET` 的验签由 `hono/jwt` 的 HMAC 负责（已抗时序），不走本 helper。
 *
 * @param a 一侧字符串（如重算出的派生 hash）。
 * @param b 另一侧字符串（如存储的 password_hash）。
 * @returns 两串内容是否相等（常量时间）。
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  // Encode both sides to bytes; comparison cost tracks input length, not the
  // position of the first differing byte (§17.8). We never early-return on a
  // mismatch — the loop always runs the full width of the longer operand.
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);

  // A length mismatch is a definite non-match, but we still walk a fixed number
  // of steps (the longer length) and fold the length delta into the accumulator
  // so we don't short-circuit on the cheap `length` signal.
  const len = Math.max(aBytes.length, bBytes.length);
  let acc = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    // Out-of-range indices read as 0 from a typed array; XOR them in regardless
    // so a shorter operand can never short-circuit the walk.
    const ai = i < aBytes.length ? aBytes[i] : 0;
    const bi = i < bBytes.length ? bBytes[i] : 0;
    acc |= ai ^ bi;
  }
  return acc === 0;
}

// ---------------------------------------------------------------------------
// 纯逻辑：签 / 验 session（实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * 签发一个 session JWT（§17.5）。**前提**：调用方（register / login route）已经校验过
 * 凭据（注册创建了 user、登录核对了密码哈希），此函数只负责签名——不接触明文密码 / hash。
 *
 * - payload 至少含 `sub`（**必填**，该 owner 的真实 user id，`users.id`，§17.5）+ `exp`
 *   （默认 now + {@link DEFAULT_SESSION_TTL_SECONDS}）；可附 `iat`。多用户下 `sub` 不再有
 *   兜底默认——调用方**必须**传入真实 user id（注册时来自 createUser、登录时来自 authenticateUser）。
 * - 用 `secret`（AUTH_SECRET）以 {@link SESSION_JWT_ALG} 签名（建议复用 `hono/jwt` 的 `sign`）。
 * - 返回的 token 与其 payload **绝不**包含 AUTH_SECRET / 密码 / password_hash（§17.6）。
 *
 * @param secret AUTH_SECRET（Worker secret）。
 * @param options `sub`（必填，真实 user id）+ 可选 `ttlSeconds` 覆盖默认 TTL。
 * @returns 签好的 JWT 字符串。
 */
export async function signSession(
  secret: string,
  options: { sub: string; ttlSeconds?: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  // payload carries ONLY non-sensitive claims — never AUTH_SECRET / password /
  // password_hash / any owner credential (§17.5 / §17.6). JWT is signed, not encrypted.
  // `sub` is the owner's real user id (the data-isolation key, §17.9) — required,
  // no fallback default in the multi-user world.
  const payload = {
    sub: options.sub,
    iat: now,
    exp: now + ttl,
  };
  return sign(payload, secret, SESSION_JWT_ALG);
}

/**
 * 验签 + 校验未过期，解出 {@link Session}（§17.6）。
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
    // reason) ever surfaces upward (§17.6).
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
// auth 中间件（横切，挂在 owner-only 端点上，§17.6 / §17.7）
// ---------------------------------------------------------------------------

/**
 * owner-only 端点的 auth 中间件工厂（§17.6）。返回一个 Hono 中间件：
 *
 * - 从 `Authorization` 头解析 `Bearer <jwt>`；缺头 / 非 `Bearer ` 前缀 → `401 { error }`，
 *   **不**调用 `next()`（不进入 handler）。
 * - 用 `secret`（AUTH_SECRET）经 {@link verifySession} 验签 + 校验未过期；失败 / 过期 /
 *   payload 非法 → `401 { error }`。
 * - 通过 → `c.set('session', session)` 后 `await next()`，把控制权交给 owner-only handler。
 *   下游 handler 据 `c.get('session').sub`（真实 user id）按 owner 隔离数据（§17.9）。
 * - 401 的 `{ error }` 只表「未授权」，绝不含 AUTH_SECRET / 被拒 token 内容 / 验签原因（§17.6）。
 *
 * 实现选型（§17.6）：可在此基于 {@link verifySession} 自写薄中间件，或直接返回
 * `hono/jwt` 的 `jwt({ secret })`——两者皆可，只要满足上面的可观察行为。
 *
 * 挂载方式见 §17.7 / index.ts：公开端点（GET /api/forms/:slug、POST /api/submit、
 * GET /health、POST /api/auth/register、POST /api/auth/login）**不**挂；owner-only 端点
 * （GET/POST /api/config、POST /api/config/test、POST /api/chat、GET/POST /api/forms、
 * PATCH/DELETE /api/forms/:slug、GET /api/forms/:slug/submissions）挂。**注意**：不能用一句
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
    // 401, never entering the handler (§17.6). The 401 body only says "未授权",
    // never echoing AUTH_SECRET / the rejected token / a verify reason (§17.6).
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
