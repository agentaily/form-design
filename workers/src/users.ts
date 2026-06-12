// users.ts — type contracts for the users (owner accounts) data layer.
// See SPEC.md §17.2 (注册), §17.3 (登录), §17.4 (密码哈希), §17.11 (users 表).
//
// 多用户改造的用户数据层：开放注册（任意邮箱 + 密码自助注册即成 owner），email 唯一
// （登录名 + 注册去重）。users.id（crypto.randomUUID()）是隔离键——即 session JWT 的
// sub，也即 owner_config.owner_id / forms.owner_id 写入的真实 user id（§17.5 / §17.9）。
//
// 明文密码绝不入库：createUser 经 password.ts 派生 hash + salt + iterations 落库
// （§17.4）。authenticateUser 封装「用户不存在也跑一次假 hash」的防时序枚举约束
// （§17.3）。
//
// Layering: 下面的 D1 读写函数是 outer-loop 的 seam（SELF.fetch 驱动 register / login
// 端点），纯校验（email 形状 / 密码强度）是 inner-loop 单测目标。

import { hashPassword, verifyPassword, DEFAULT_PBKDF2_ITERATIONS } from "./password";

// ---------------------------------------------------------------------------
// 约定常量
// ---------------------------------------------------------------------------

/** 密码强度下限（§17.2）：长度 < 此值即「弱密码」→ register 返回 400。 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * email 形状校验的最简正则（§17.2）。本期只验**形状**（`x@y.z` 这类），**不**验邮箱
 * 真实可达（`email_verified` 预留恒 0、不发信，§17.11）。具体正则由实现在合约内定，
 * 但**必须**拒绝明显非法（无 `@` / 无域名）的串。
 */
export const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * `users` 表的一行（§17.11）——内部数据层视图。**绝不**整体回给客户端：登录 / 注册
 * 只回 `{ token }`（§17.2 / §17.3），password_* 永不出网。
 */
export interface UserRow {
  /** crypto.randomUUID()；session sub + owner_config/forms 的 owner_id。 */
  id: string;
  /** 登录名 + 唯一约束（注册去重）。 */
  email: string;
  /** PBKDF2 派生值 (base64)。 */
  passwordHash: string;
  /** per-user 随机 salt (base64)。 */
  passwordSalt: string;
  /** 派生用迭代数（校验时按此重算，§17.4）。 */
  iterations: number;
  /** 预留，先恒 0（邮箱验证留后续 feature，§17.11）。 */
  emailVerified: number;
  /** ISO-8601 注册时刻。 */
  createdAt: string;
}

/**
 * Thrown by {@link createUser} when the email is already taken（`users.email`
 * UNIQUE 冲突）。register route 据此回 `409 { error }`，**不**新建 user、不签 token
 * （§17.2）。唯一性的**最终裁决**是 INSERT 的 UNIQUE 冲突（兜住并发注册的 TOCTOU），
 * 不能只靠 {@link findUserByEmail} 预检。
 */
export class EmailTakenError extends Error {
  constructor(message = "email already registered") {
    super(message);
    this.name = "EmailTakenError";
  }
}

/**
 * Thrown by {@link createUser} when the input fails validation（非法 email 形状 /
 * 弱密码 < {@link MIN_PASSWORD_LENGTH} 位 / 缺字段）。register route 据此回
 * `400 { error }`，**不**落库（§17.2）。
 */
export class UserValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserValidationError";
  }
}

// ---------------------------------------------------------------------------
// D1 读写 + 鉴权（实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * 注册一个新 owner（§17.2 / §17.4）。
 *
 * 契约（实现在合约内）：
 * - 校验 `email` 形状（{@link EMAIL_SHAPE_RE}）+ `password` 强度（≥ {@link MIN_PASSWORD_LENGTH}）；
 *   任一不合或缺字段 → 抛 {@link UserValidationError}（route → 400，不落库）。
 * - {@link hashPassword}(password) → `{ hash, salt, iterations }`；明文**绝不**入库。
 * - `INSERT` 一行 `users`：`id = crypto.randomUUID()`、`email_verified = 0`、
 *   `iterations`（来自 hashPassword，起步 {@link DEFAULT_PBKDF2_ITERATIONS}）、
 *   `created_at` 为当前 ISO-8601。
 * - 邮箱已占用（INSERT 撞 UNIQUE）→ 抛 {@link EmailTakenError}（route → 409）。**必须**靠
 *   INSERT 的 UNIQUE 冲突兜底并发注册（可先 findUserByEmail 预检，但不能只靠预检，§17.2）。
 * - 返回新建 user 的 `{ id }`，供 register route `signSession(AUTH_SECRET, { sub: id })`
 *   实现「注册即登录」。
 *
 * @param db D1 binding（同 owner_config / forms 所用的 `DB`）。
 * @param email 注册邮箱。
 * @param password 注册明文密码。
 * @returns `{ id }`（新建 user 的真实 id）。
 * @throws {@link UserValidationError} 形状 / 强度非法（route → 400）。
 * @throws {@link EmailTakenError} 邮箱已占用（route → 409）。
 */
export async function createUser(
  db: D1Database,
  email: string,
  password: string,
): Promise<{ id: string }> {
  // 1) Shape + strength validation BEFORE any hashing / D1 write (§17.2). A bad
  //    email shape or a < MIN_PASSWORD_LENGTH password → UserValidationError → 400,
  //    nothing persisted.
  if (typeof email !== "string" || !EMAIL_SHAPE_RE.test(email)) {
    throw new UserValidationError("email is invalid");
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new UserValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  // 2) Derive the password hash (plaintext never touches D1, §17.4).
  const { hash, salt, iterations } = await hashPassword(password);

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  // 3) INSERT — the email UNIQUE constraint is the FINAL arbiter of de-dup (§17.2):
  //    a concurrent double-register of the same email collides here, the loser
  //    surfaces as EmailTakenError → 409. We never rely on a pre-check alone.
  try {
    await db
      .prepare(
        `INSERT INTO users (id, email, password_hash, password_salt, iterations, email_verified, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .bind(id, email, hash, salt, iterations, createdAt)
      .run();
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new EmailTakenError();
    }
    throw err;
  }

  return { id };
}

/** Detect a D1 / SQLite UNIQUE constraint violation (email already registered). */
function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /UNIQUE constraint failed|constraint failed/i.test(err.message);
}

/**
 * 按 email 查一行 user（§17.3 登录用）。
 *
 * - 命中：返回 {@link UserRow}。
 * - 未命中：返回 `null`。
 *
 * 注意：登录的「邮箱不存在 vs 密码错」必须**统一 401**且**耗时不可区分**——这条放在
 * {@link authenticateUser} 里封装（用户不存在也跑一次假 hash）。直接用本函数的调用方
 * 须自行保证不泄漏「邮箱是否注册过」的信号（§17.3）。
 *
 * @param db D1 binding。
 * @param email 登录邮箱。
 * @returns 命中的 {@link UserRow}，或 `null`。
 */
export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  const row = await db
    .prepare(
      `SELECT id, email, password_hash, password_salt, iterations, email_verified, created_at
       FROM users WHERE email = ?`,
    )
    .bind(email)
    .first<{
      id: string;
      email: string;
      password_hash: string;
      password_salt: string;
      iterations: number;
      email_verified: number;
      created_at: string;
    }>();
  if (row === null) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    iterations: row.iterations,
    emailVerified: row.email_verified,
    createdAt: row.created_at,
  };
}

/**
 * 校验邮箱 + 密码，成功返回该 user 的 `{ id }`、失败返回 `null`（§17.3）。
 *
 * 契约（实现在合约内）：
 * - {@link findUserByEmail}(email) → 命中则 {@link verifyPassword}(password, hash, salt,
 *   iterations)；通过 → `{ id }`，否则 `null`。
 * - **防时序枚举 email（安全 nit，§17.3）：** 当邮箱**不存在**时，**仍跑一次等价开销的
 *   假 hash**（对一个固定占位 hash 跑 verifyPassword）再返回 `null`，使「邮箱存在但密码错」
 *   与「邮箱根本不存在」两条路径耗时不可区分——否则攻击者能靠响应时延枚举一个邮箱是否注册过。
 * - 失败一律收敛成 `null`（不区分「不存在」与「密码错」）；login route 把 `null` 统一映射成
 *   `401`（§17.3）。绝不把密码 / hash / 「邮箱是否存在」写进日志或响应。
 *
 * @param db D1 binding。
 * @param email 登录邮箱。
 * @param password 登录明文密码。
 * @returns `{ id }`（校验通过），或 `null`（任何失败）。
 */
export async function authenticateUser(
  db: D1Database,
  email: string,
  password: string,
): Promise<{ id: string } | null> {
  const user = typeof email === "string" ? await findUserByEmail(db, email) : null;

  // Email does not exist (or wasn't even a string) → STILL run one equivalent-cost
  // hash against a fixed placeholder, then return null (§17.3 anti-timing-enumeration).
  // Otherwise "email exists but wrong password" and "email not registered" would
  // differ in latency, letting an attacker enumerate which emails are registered.
  if (user === null) {
    await verifyPassword(
      typeof password === "string" ? password : "",
      DECOY_HASH,
      DECOY_SALT,
      DEFAULT_PBKDF2_ITERATIONS,
    );
    return null;
  }

  const ok =
    typeof password === "string" &&
    (await verifyPassword(password, user.passwordHash, user.passwordSalt, user.iterations));
  // Failure collapses to null without distinguishing "no such email" from "wrong
  // password" — the login route maps null → a UNIFIED 401 (§17.3).
  return ok ? { id: user.id } : null;
}

// Fixed decoy hash/salt for the user-absent path (§17.3). They are valid base64 of
// the right byte lengths (16-byte salt, 32-byte derived) so verifyPassword runs a
// full PBKDF2 derivation — matching the cost of a real user lookup — and returns
// false. These are NOT a real password's hash; they exist only to equalize timing.
const DECOY_SALT = "AAAAAAAAAAAAAAAAAAAAAA=="; // 16 zero bytes, base64
const DECOY_HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes, base64
