// users.ts — type contracts for the users (owner accounts) data layer.
// See SPEC.md §17.2 (注册 + 未验证可覆盖), §17.3 (登录), §17.4 (密码哈希),
// §17.11 (users 表), §23 (邮箱验证), §24 (找回密码).
//
// 多用户改造的用户数据层：开放注册（任意邮箱 + 密码自助注册即成 owner），email 唯一
// （登录名 + 注册去重）。users.id（crypto.randomUUID()）是隔离键——即 session JWT 的
// sub，也即 owner_config.owner_id / forms.owner_id 写入的真实 user id（§17.5 / §17.9）。
//
// 明文密码绝不入库：createUser 经 password.ts 派生 hash + salt + iterations 落库
// （§17.4）。authenticateUser 封装「用户不存在也跑一次假 hash」的防时序枚举约束
// （§17.3）。
//
// 防「占座别人邮箱」（§17.2 修订）：createUser 的去重语义从「email 一占就 409」改成
// **「未验证可覆盖」**——email 已验证（email_verified=1）才 409 锁死；email 存在但未验证
// （=0）则覆盖重注册（换新 id + 新密码、清旧未验证号残留）。一旦验证就锁死，没人能用
// 「注册了不验证」长期占住别人的邮箱。markEmailVerified / resetUserPassword 服务 §23 / §24。
//
// Layering: 下面的 D1 读写函数是 outer-loop 的 seam（SELF.fetch 驱动 register / login /
// verify-email / password-reset 端点），纯校验（email 形状 / 密码强度）是 inner-loop 单测目标。

import { hashPassword, verifyPassword, DEFAULT_PBKDF2_ITERATIONS } from "./password";
// revokeUserTokens 用于 createUser 覆盖重注册时清旧未验证号 token（§17.2）、
// resetUserPassword 改密成功后作废其余 reset token（§24.3）。
import { revokeUserTokens } from "./tokens";

// ---------------------------------------------------------------------------
// 约定常量
// ---------------------------------------------------------------------------

/** 密码强度下限（§17.2）：长度 < 此值即「弱密码」→ register 返回 400。 */
export const MIN_PASSWORD_LENGTH = 8;

/** 显示名长度上限（§17 个人资料）：trim 后 > 此值 → PUT /api/auth/profile 返回 400。 */
export const MAX_DISPLAY_NAME_LENGTH = 64;

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
  /** 邮箱验证状态位（§23）：注册 / 覆盖时 0，verify-email/confirm 成功后置 1。它**不门禁**任何
   *  功能（§23.1），唯一后端作用是 §17.2 去重三态（未验证可覆盖、已验证锁死）+ 前端 banner。 */
  emailVerified: number;
  /** owner 显示名（§17 个人资料）：可空，空（NULL）= 未设置 → 前端回退用邮箱。明文存，
   *  绝不参与密码 / 鉴权（改它不动 email / password_* / email_verified）。 */
  displayName: string | null;
  /** ISO-8601 注册时刻。 */
  createdAt: string;
}

/**
 * Thrown by {@link createUser} when the email is taken by a **VERIFIED** account
 * （`email_verified=1`，§17.2 修订）。register route 据此回 `409 { error }`，**不**新建
 * user、不签 token。
 *
 * 注意（未验证可覆盖，§17.2）：email 已存在但**未验证**（`email_verified=0`）**不**抛本错误
 * —— 那条路走「覆盖重注册」（换新 id + 新密码、清旧未验证号残留），见 {@link createUser}。
 * 只有命中**已验证**邮箱才锁死。唯一性的并发裁决仍是 `users.email` 的 UNIQUE 约束（兜住
 * 两个并发注册的 TOCTOU），不能只靠 {@link findUserByEmail} 预检（§17.2）。
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
 * 注册一个新 owner（§17.2 修订：**未验证可覆盖** / §17.4）。
 *
 * 契约（实现在合约内）：
 * - 校验 `email` 形状（{@link EMAIL_SHAPE_RE}）+ `password` 强度（≥ {@link MIN_PASSWORD_LENGTH}）；
 *   任一不合或缺字段 → 抛 {@link UserValidationError}（route → 400，不落库）。
 * - {@link hashPassword}(password) → `{ hash, salt, iterations }`；明文**绝不**入库。
 * - **去重三态（§17.2 修订，防占座别人邮箱）**，按 email 现有行决策：
 *   1. email 不存在 → 建号：`INSERT` 一行 `users`（`id=crypto.randomUUID()`、`email_verified=0`、
 *      `iterations` 来自 hashPassword、`created_at`=now ISO-8601）。
 *   2. email 存在且**已验证**（`email_verified=1`）→ 抛 {@link EmailTakenError}（route → 409，锁死）。
 *   3. email 存在但**未验证**（`email_verified=0`）→ **覆盖重注册**：换**新** user id + 写新派生
 *      密码、`email_verified` 仍为 0、`created_at` 刷新；并**清掉旧未验证号的残留**——
 *      `owner_config` / `forms` 中 `owner_id = 旧 id` 的行删除，旧号名下 `auth_tokens` 经
 *      {@link revokeUserTokens}(db, 旧 id, 'verify') 作废。这样没人能用「注册了不验证」长期
 *      占住别人的邮箱；一旦验证就走第 2 条锁死。
 * - **覆盖的并发语义（与 UNIQUE 协作）：** email 仍受 `users.email` UNIQUE 约束。覆盖**二选一**
 *   并写清：(a) **UPDATE** 同 email 那行的 id/密码列（同一行原地换值，无 INSERT 冲突）；或
 *   (b) **delete 旧行 + INSERT 新行**，在一个 D1 batch / 事务里完成、并靠 INSERT 撞 UNIQUE 兜底
 *   并发（两个并发覆盖同一未验证邮箱，先到者成功、后到者撞 UNIQUE → 视作 {@link EmailTakenError}
 *   或重试，由实现定）。无论 (a)/(b)，UNIQUE 都是「同一邮箱不会并发产出两条 users 行」的最终裁决；
 *   实现**必须**靠它兜并发，不能只靠 findUserByEmail 预检（TOCTOU）。
 * - 返回（新建或覆盖后的）user 的 `{ id }`，供 register route `signSession(AUTH_SECRET, { sub: id })`
 *   实现「注册即登录」、并据此异步发验证邮件（§23.2，best-effort）。
 *
 * @param db D1 binding（同 owner_config / forms 所用的 `DB`）。
 * @param email 注册邮箱。
 * @param password 注册明文密码。
 * @returns `{ id }`（新建或覆盖后 user 的真实 id）。
 * @throws {@link UserValidationError} 形状 / 强度非法（route → 400）。
 * @throws {@link EmailTakenError} 邮箱被**已验证**账号占用（route → 409）。
 */
export async function createUser(
  db: D1Database,
  email: string,
  password: string,
): Promise<{ id: string }> {
  // 1) 校验 email 形状 + 密码强度（任一不合 / 缺字段 → UserValidationError，route → 400，不落库）。
  if (typeof email !== "string" || !EMAIL_SHAPE_RE.test(email)) {
    throw new UserValidationError("invalid email");
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new UserValidationError("password too weak");
  }

  // 2) 派生密码（明文绝不入库，§17.4）。
  const { hash, salt, iterations } = await hashPassword(password);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  // 3) 去重三态（§17.2 修订）。按 email 现有行决策——
  const existing = await findUserByEmail(db, email);

  if (existing === null) {
    // (a) email 不存在 → 建号。INSERT 的 UNIQUE(email) 是并发裁决：两个并发注册同一**新**
    //     邮箱，先到者成功、后到者撞 UNIQUE → EmailTakenError（route → 409）。不靠预检兜并发。
    try {
      await db
        .prepare(
          `INSERT INTO users (id, email, password_hash, password_salt, iterations, email_verified, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
        )
        .bind(id, email, hash, salt, iterations, createdAt)
        .run();
    } catch (err) {
      // UNIQUE 冲突（并发注册同一新邮箱的后到者）→ 锁死语义同「已占用」。
      throw mapUniqueViolation(err);
    }
    return { id };
  }

  if (existing.emailVerified === 1) {
    // (b) email 已验证 → 锁死，不建 / 不覆盖、不签 token（route → 409）。
    throw new EmailTakenError();
  }

  // (c) email 存在但**未验证** → 覆盖重注册：换**新** user id + 新派生密码，email_verified 仍 0，
  //     created_at 刷新；并清掉旧未验证号的残留（owner_config / forms / auth_tokens）。
  const oldId = existing.id;
  // 残留清理 + 删旧行 + 插新行在一个 D1 batch 里完成（原子）；INSERT 的 UNIQUE(email) 仍是
  // 并发覆盖的最终裁决——两个并发覆盖同一未验证邮箱，先到者的 batch 成功、后到者的 INSERT 撞
  // UNIQUE（旧行已被先到者删除并换成新行）→ EmailTakenError，由实现收敛（不靠预检兜并发，§17.2）。
  try {
    await db.batch([
      db.prepare(`DELETE FROM owner_config WHERE owner_id = ?`).bind(oldId),
      db.prepare(`DELETE FROM forms WHERE owner_id = ?`).bind(oldId),
      db.prepare(`DELETE FROM auth_tokens WHERE user_id = ?`).bind(oldId),
      db.prepare(`DELETE FROM users WHERE id = ? AND email_verified = 0`).bind(oldId),
      db
        .prepare(
          `INSERT INTO users (id, email, password_hash, password_salt, iterations, email_verified, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
        )
        .bind(id, email, hash, salt, iterations, createdAt),
    ]);
  } catch (err) {
    // 并发：另一个覆盖 / 验证已抢先改了这条 email 行 → INSERT 撞 UNIQUE → 收敛成 EmailTaken。
    throw mapUniqueViolation(err);
  }
  return { id };
}

/**
 * 把 D1 的 UNIQUE 约束冲突映射成 {@link EmailTakenError}（route → 409）。非 UNIQUE 冲突的
 * 其它错误原样抛出（部署 / 运行时异常，不该被收敛成 409）。
 */
function mapUniqueViolation(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/i.test(message)) {
    return new EmailTakenError();
  }
  return err instanceof Error ? err : new Error(message);
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
      `SELECT id, email, password_hash, password_salt, iterations, email_verified, display_name, created_at
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
      display_name: string | null;
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
    displayName: row.display_name ?? null,
    createdAt: row.created_at,
  };
}

/**
 * 按 id 查一行 user（§23.3 owner-only 重发验证邮件用）。verify-email/request 据 session.sub
 * 反查当前用户的 email + 验证状态，**不**接受 body 里的任意 email（防被当成滥发别人邮箱的工具）。
 *
 * - 命中：返回 {@link UserRow}。
 * - 未命中：返回 `null`。
 *
 * @param db D1 binding。
 * @param id user id（= session JWT 的 sub，§17.5）。
 * @returns 命中的 {@link UserRow}，或 `null`。
 */
export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  const row = await db
    .prepare(
      `SELECT id, email, password_hash, password_salt, iterations, email_verified, display_name, created_at
       FROM users WHERE id = ?`,
    )
    .bind(id)
    .first<{
      id: string;
      email: string;
      password_hash: string;
      password_salt: string;
      iterations: number;
      email_verified: number;
      display_name: string | null;
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
    displayName: row.display_name ?? null,
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

// ---------------------------------------------------------------------------
// 邮箱验证 + 改密的数据层（§23 / §24；实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * 把某 user 标记为「邮箱已验证」（§23.4）——verify-email/confirm 消费完 token 后调用。
 *
 * 契约（实现在合约内）：
 * - `UPDATE users SET email_verified = 1 WHERE id = ?`。已是 1 → 幂等 no-op（仍算成功）。
 * - 一旦置 1，该邮箱在 {@link createUser} 里就**锁死**（再注册同邮箱 → 409，不再可覆盖，§17.2）。
 * - 不读 / 不回任何密码字段；只翻 email_verified 这一列。
 *
 * @param db D1 binding。
 * @param userId 要标记的 user（来自 consumeToken 的 `{ userId }`，§23.4）。
 */
export async function markEmailVerified(db: D1Database, userId: string): Promise<void> {
  // 只翻 email_verified 这一列；已是 1 → 幂等 no-op（仍算成功，§23.4）。一旦置 1，该邮箱在
  // createUser 里就锁死（再注册同邮箱 → 409，不再可覆盖，§17.2）。不读 / 不回任何密码字段。
  await db.prepare(`UPDATE users SET email_verified = 1 WHERE id = ?`).bind(userId).run();
}

/**
 * 写某 owner 的显示名（§17 个人资料）——PUT /api/auth/profile 校验完后调用。
 *
 * 契约（实现在合约内）：
 * - **只翻 display_name 这一列**：`UPDATE users SET display_name = ? WHERE id = ?`，
 *   不触碰 email / password_* / email_verified / created_at。
 * - 传 `null` 即清空显示名（绑成 SQL NULL）→ 前端回退用邮箱展示。
 * - 调用方负责 trim + 长度校验（§17，> {@link MAX_DISPLAY_NAME_LENGTH} → route 400）；
 *   本函数只落库，不再校验形状。
 *
 * @param db D1 binding。
 * @param id 目标 owner 的真实 user id（= session JWT 的 sub，§17.5）。
 * @param displayName 新显示名，或 `null`（清空）。
 */
export async function updateDisplayName(
  db: D1Database,
  id: string,
  displayName: string | null,
): Promise<void> {
  // null 绑成 SQL NULL（清空 → 回退用邮箱）。只翻 display_name 一列，绝不动密码 / email / 验证位。
  await db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).bind(displayName, id).run();
}

/**
 * 重置某 user 的密码（§24.3）——password-reset/confirm 校验完新密码强度 + 消费完 reset token
 * 后调用。
 *
 * 契约（实现在合约内）：
 * - 调用方**必须**已校验 `newPassword` 强度（≥ {@link MIN_PASSWORD_LENGTH}，复用 §17.2 规则）；
 *   本函数也可再校验一次，强度不足 → 抛 {@link UserValidationError}（route → 400，不改密）。
 * - {@link hashPassword}(newPassword) → 新 `{ hash, salt, iterations }`；明文**绝不**入库。
 * - `UPDATE users SET password_hash=?, password_salt=?, iterations=? WHERE id=?`，**整组**替换
 *   （新 salt + 新 iterations 一并刷新，旧 hash 不再可用）。
 * - 改密成功后 {@link revokeUserTokens}(db, userId, 'reset') 作废该 user 其余 reset token——防一封
 *   旧的找回密码邮件被二次利用（§24.3）。
 * - **不**触碰 email_verified / owner_config / forms；只换密码列。
 *
 * @param db D1 binding。
 * @param userId 目标 user（来自 consumeToken 的 `{ userId }`，§24.3）。
 * @param newPassword 新明文密码（已/再校验强度）。
 * @throws {@link UserValidationError} 新密码过弱（route → 400）。
 */
export async function resetUserPassword(
  db: D1Database,
  userId: string,
  newPassword: string,
): Promise<void> {
  // 再校验一次新密码强度（≥ MIN_PASSWORD_LENGTH，复用 §17.2 规则）；不足 → UserValidationError
  // （route → 400，不改密）。调用方通常已校验过，这是纵深防御。
  if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new UserValidationError("password too weak");
  }
  // 新派生 hash + salt + iterations（明文绝不入库，§17.4）。整组替换，旧 hash 不再可用。
  const { hash, salt, iterations } = await hashPassword(newPassword);
  await db
    .prepare(`UPDATE users SET password_hash = ?, password_salt = ?, iterations = ? WHERE id = ?`)
    .bind(hash, salt, iterations, userId)
    .run();
  // 改密成功后作废该 user 名下其余 reset token——防一封旧的找回密码邮件被二次利用（§24.3）。
  await revokeUserTokens(db, userId, "reset");
}
