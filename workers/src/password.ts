// password.ts — type contracts for password hashing (PBKDF2-HMAC-SHA256).
// See SPEC.md §17.4 (密码哈希约定).
//
// 多用户改造的密码层：明文密码**绝不入库**，只存可校验、不可逆的 PBKDF2 派生值 +
// per-user 随机 salt + 记录 iterations。WebCrypto 原生（crypto.subtle，workerd 唯一
// 原生 KDF 是 PBKDF2，无 scrypt/bcrypt；不引第三方依赖），复用 crypto.ts 的 base64
// helper 风格。
//
// Layering: 这两个纯函数（DOM-free / network-free）是 inner-loop 单测目标：
//   - hashPassword:   注册时派生（新随机 salt + 默认 iterations）→ { hash, salt, iterations }
//   - verifyPassword: 登录时用存的 salt + iterations 重算 + 常量时间比对 → boolean
// users.ts（createUser / authenticateUser）与 auth 端点（register / login）在其之上，
// 由 outer-loop 通过 SELF.fetch 驱动。

import { timingSafeEqualStr } from "./auth";

// ---------------------------------------------------------------------------
// 约定常量（实现可在合约内微调，但语义不变）
// ---------------------------------------------------------------------------

/**
 * PBKDF2 迭代数起步值（§17.4）。权衡 workerd 的 CPU 上限；记录进每个用户的记录
 * （{@link HashedPassword.iterations}）以便日后调高而不破坏旧 hash——校验时用该用户
 * **存的** iterations 重算，而非这个全局默认。新注册用本默认。
 */
export const DEFAULT_PBKDF2_ITERATIONS = 100_000;

/** PBKDF2 的底层哈希（§17.4：PBKDF2-HMAC-SHA256）。 */
export const PBKDF2_HASH = "SHA-256";

/** per-user 随机 salt 的字节长度（16 字节 = 128 bit，足够防彩虹表 / 撞 salt）。 */
export const SALT_BYTES = 16;

/** 派生 hash 的字节长度（32 字节 = 256 bit）。 */
export const DERIVED_KEY_BYTES = 32;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 一次成功 {@link hashPassword} 的产物——落库进 `users` 表的三列（§17.11）：
 * `password_hash` / `password_salt` / `iterations`。明文密码本身**绝不**包含在内、
 * 也绝不入库。
 */
export interface HashedPassword {
  /** PBKDF2 派生值，base64（落 `password_hash`）。 */
  hash: string;
  /** 本次派生用的 per-user 随机 salt，base64（落 `password_salt`）。 */
  salt: string;
  /** 本次派生用的迭代数（落 `iterations`，校验时按此重算）。 */
  iterations: number;
}

// ---------------------------------------------------------------------------
// 纯逻辑（实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * 把明文密码派生成可落库的 {@link HashedPassword}（§17.4）。
 *
 * 契约（实现在合约内）：
 * - 生成一个**新的随机 salt**（`crypto.getRandomValues`，{@link SALT_BYTES} 字节），
 *   绝不全局共用；用 PBKDF2-HMAC-{@link PBKDF2_HASH}、{@link DEFAULT_PBKDF2_ITERATIONS}
 *   次迭代派生出 {@link DERIVED_KEY_BYTES} 字节的 key。
 * - `hash` / `salt` 以 base64 返回（复用 crypto.ts 的 base64 编码风格）。
 * - 返回里**绝不**包含明文密码；明文出了本函数即应被丢弃，绝不入库 / 进日志（§17.4）。
 *
 * @param plaintext 注册 / 改密时的明文密码（已由 users.ts 校验过强度 ≥ 8 位）。
 * @returns 落库三元组 `{ hash, salt, iterations }`。
 */
export async function hashPassword(plaintext: string): Promise<HashedPassword> {
  // Fresh per-user random salt — never globally shared (§17.4). 128-bit is ample
  // against rainbow tables / salt collisions.
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveBits(plaintext, salt, DEFAULT_PBKDF2_ITERATIONS);
  // Plaintext leaves nothing behind: only the derived value + salt + iterations
  // are returned (and later persisted). The plaintext itself is never stored.
  return {
    hash: bytesToBase64(derived),
    salt: bytesToBase64(salt),
    iterations: DEFAULT_PBKDF2_ITERATIONS,
  };
}

/**
 * 校验一个明文密码是否匹配已存的派生 hash（§17.4）——{@link hashPassword} 的逆向校验。
 *
 * 契约（实现在合约内）：
 * - 用**存的** `salt` + `iterations`（不是默认值）把 `plaintext` 重新派生一遍，再与
 *   存的 `hash` 做**常量时间等长比较**（`auth.ts` 的 `timingSafeEqualStr`，§17.8 / §17.10），
 *   而非朴素 `===`——比对耗时不随「第几位不同」变化。
 * - 匹配 → `true`，否则 `false`；**绝不抛敏感细节**，也不把密码 / hash 写进日志或响应。
 * - 用 `iterations` 而非全局默认重算，是为了「将来调高迭代数不破坏旧 hash」（§17.4）。
 *
 * @param plaintext 登录时提交的明文密码。
 * @param hash 存的 PBKDF2 派生值（base64）。
 * @param salt 存的 per-user salt（base64）。
 * @param iterations 存的迭代数（按此重算）。
 * @returns 是否匹配（常量时间）。
 */
export async function verifyPassword(
  plaintext: string,
  hash: string,
  salt: string,
  iterations: number,
): Promise<boolean> {
  // Re-derive with the STORED salt + iterations (not the global default) — this
  // is what lets us raise the iteration count later without breaking old hashes.
  let recomputed: string;
  try {
    const saltBytes = base64ToBytes(salt);
    const derived = await deriveBits(plaintext, saltBytes, iterations);
    recomputed = bytesToBase64(derived);
  } catch {
    // A malformed stored salt/hash must not throw a sensitive detail upward —
    // a verification that can't even run is simply "does not match".
    return false;
  }
  // Constant-time compare of the two base64 derived values (§17.4 / §17.10) — never
  // a naive `===` that would leak which byte first differs via timing.
  return timingSafeEqualStr(recomputed, hash);
}

/**
 * Derive a {@link DERIVED_KEY_BYTES}-byte key from `plaintext` + `salt` via
 * PBKDF2-HMAC-{@link PBKDF2_HASH} over `iterations` rounds (the shared core of
 * {@link hashPassword} and {@link verifyPassword}). Pure WebCrypto, no deps.
 */
async function deriveBits(
  plaintext: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(plaintext),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: PBKDF2_HASH, salt, iterations },
    keyMaterial,
    DERIVED_KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Decode a base64 string into bytes (mirrors crypto.ts). */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encode bytes into a base64 string (mirrors crypto.ts). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
