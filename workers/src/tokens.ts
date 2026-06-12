// tokens.ts — type contracts for one-shot, time-bound auth tokens（邮箱验证 + 找回密码共用）.
// See SPEC.md §22.4 (token 层) / §23 (邮箱验证) / §24 (找回密码).
//
// 两种 kind 同表（auth_tokens，migration 0002）：
//   - 'verify'：注册软验证 / 重发验证；确认成功 → 把 users.email_verified 置 1（§23）。
//   - 'reset' ：找回密码；确认成功 → 重置该 user 的 password_hash/salt/iterations（§24）。
//
// 安全核心（库泄漏也拿不到活 token，§22.4）：
//   - 明文 token 是高熵随机串（放进邮件链接 ?token=），**只在生成时返回一次**用于发信；
//     之后服务端永不再持有明文。落库的只有它的 SHA-256（token_hash）。
//   - 确认时把收到的明文重新 SHA-256，再按 token_hash 查行 —— 时序安全、库里查不到原值。
//   - 单次使用（used_at）+ 限时（expires_at）：用过 / 过期 / kind 不匹配 → 一律「无效」，
//     统一收敛、不区分原因（防 token 探测，§24.3）。
//
// Layering（测试 seam）：
//   - 纯函数（inner-loop 单测目标，DOM-free / network-free / D1-free）：
//       generateTokenPlaintext  —— 高熵随机串（URL-safe）。
//       hashToken               —— SHA-256(明文) → 落库串（确定性，同明文同输出）。
//       isTokenUsable           —— 给定 row + now + 期望 kind，判定可用 / 无效（纯判定）。
//   - D1 读写（outer-loop seam，SELF.fetch 经 verify/reset 端点驱动）：
//       issueToken / consumeToken / revokeUserTokens —— 在纯函数之上做 INSERT / 查验作废 / 清理。

// ---------------------------------------------------------------------------
// 约定常量（实现可在合约内微调，但语义不变）
// ---------------------------------------------------------------------------

/** verify token 的有效期（秒），默认 24h（§23.5）。带 expires_at 是硬约定。 */
export const VERIFY_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** reset token 的有效期（秒），默认 1h（§24.4）——改密 token 取更短窗口降低被捡到的风险。 */
export const RESET_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * 明文 token 的随机字节数（§22.4）。高熵不可枚举（≥ 128 bit）；以 URL-safe 串编码后放进
 * 邮件链接 ?token=。具体编码（base64url / hex）由实现在合约内定，但必须 URL-safe 且全表统一。
 */
export const TOKEN_RANDOM_BYTES = 32;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** token 的两种用途（落 auth_tokens.kind，migration 0002）。 */
export type TokenKind = "verify" | "reset";

/**
 * `auth_tokens` 表的一行（§22.4）——内部数据层视图。**绝不**整体回给客户端，尤其
 * `tokenHash` 永不出网。明文 token 不在此结构里（库里根本不存明文）。
 */
export interface AuthTokenRow {
  /** token 明文的 SHA-256（落 token_hash，主键）；绝不出网（§22.4）。 */
  tokenHash: string;
  /** 该 token 归属的 user（users.id，§17.11）。 */
  userId: string;
  /** 用途：'verify' | 'reset'。 */
  kind: TokenKind;
  /** ISO-8601 过期时刻（verify 24h、reset 1h）。 */
  expiresAt: string;
  /** ISO-8601 使用时刻；`null`=未用（单次使用）。 */
  usedAt: string | null;
  /** ISO-8601 生成时刻。 */
  createdAt: string;
}

/**
 * {@link issueToken} 的产物：返回**明文**（发信用，只此一次）+ 落库行的非敏感视图。
 * 明文 `plaintext` 仅用于拼邮件链接，调用方用完即弃、绝不入库 / 进日志 / 回响应体（§22.4）。
 */
export interface IssuedToken {
  /** 高熵随机明文 token（放进邮件链接 ?token=）；只此一次，服务端事后不再持有。 */
  plaintext: string;
  /** 已落库行的 SHA-256（= hashToken(plaintext)）；用于调用方关联，绝不出网。 */
  tokenHash: string;
  /** ISO-8601 过期时刻（now + TTL）。 */
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// 纯逻辑（inner-loop 单测目标；实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * 生成一个高熵、URL-safe 的明文 token（§22.4）。
 *
 * 契约（实现在合约内）：
 * - 用 `crypto.getRandomValues`（{@link TOKEN_RANDOM_BYTES} 字节，≥ 128 bit 熵）→ 编码成
 *   URL-safe 串（base64url / hex，编码方式由实现定但全表统一），可安全放进邮件链接 ?token=。
 * - 绝不可预测 / 不可枚举：不用时间戳 / 计数器 / user 信息派生；纯随机。
 * - 返回的是**明文**，调用方负责立刻 {@link hashToken} 落 hash、把明文只交给发信，之后丢弃。
 *
 * @returns 高熵随机明文 token（URL-safe）。
 */
export function generateTokenPlaintext(): string {
  // 高熵不可枚举：TOKEN_RANDOM_BYTES (=32) 字节 = 256 bit 纯随机，绝不派生自时间 / 计数器 /
  // user 信息（§22.4）。编成 base64url 串（URL-safe，可直接放进邮件链接 ?token=）。
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_RANDOM_BYTES));
  return bytesToBase64Url(bytes);
}

/**
 * 把明文 token 哈希成可落库 / 可查验的串（§22.4）。SHA-256(明文) → 编码串（与
 * token_hash 列同编码）。**确定性**：同一明文恒得同一输出（确认时据此按主键查行）。
 *
 * - 单向：从输出无法还原明文；库泄漏拿不到活 token。
 * - 入参 / 返回都不进日志；它只是把明文转成存储/查验键，不回显明文（§22.4）。
 *
 * @param plaintext 明文 token（来自 {@link generateTokenPlaintext} 或邮件链接 ?token=）。
 * @returns SHA-256 派生的存储/查验串（落 auth_tokens.token_hash）。
 */
export async function hashToken(plaintext: string): Promise<string> {
  // SHA-256(明文) → base64url 串（与 generateTokenPlaintext 同编码，全表统一，§22.4）。
  // 确定性（同明文恒同输出，确认时据此按 token_hash 查行）+ 单向（库泄漏拿不到活 token）。
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintext));
  return bytesToBase64Url(new Uint8Array(digest));
}

/**
 * 纯判定一行 token 在 `now` 是否可用于 `expectedKind`（§23.4 / §24.3）。
 *
 * 可用 ⇔ 全部成立：`row.kind === expectedKind` 且 `row.usedAt === null`（未用）且
 * `now < expiresAt`（未过期）。任一不成立 → 不可用。**不区分**「不存在 / 已用 / 过期 /
 * kind 错」——调用方统一收敛成同一「无效」语义，绝不向外泄漏是哪一种（防 token 探测）。
 *
 * @param row 命中的 {@link AuthTokenRow}（按 token_hash 查到的行）。
 * @param expectedKind 期望用途（verify-confirm 传 'verify'，reset-confirm 传 'reset'）。
 * @param now 当前时刻（Unix 毫秒，默认 `Date.now()`）。
 * @returns 是否可用（纯判定，无副作用）。
 */
export function isTokenUsable(
  row: AuthTokenRow,
  expectedKind: TokenKind,
  now: number = Date.now(),
): boolean {
  // 可用 ⇔ kind 匹配 且 未用 且 未过期（§23.4 / §24.3）。任一不成立 → 不可用；调用方
  // 把任何「不可用」统一收敛成同一「无效」语义，不区分原因（防 token 探测）。
  if (row.kind !== expectedKind) {
    return false;
  }
  if (row.usedAt !== null) {
    return false;
  }
  // now ≥ expires_at 即过期（含边界：恰在过期时刻也算过期）。
  return now < Date.parse(row.expiresAt);
}

// ---------------------------------------------------------------------------
// base64url 编码（URL-safe，全表统一；放进邮件链接 ?token= 不需转义）
// ---------------------------------------------------------------------------

/** 把字节编成 base64url 串（`+/` → `-_`、去掉 `=` 填充），URL-safe（§22.4）。 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// D1 读写（outer-loop seam；实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * 为某 user 生成并落库一个一次性 token，返回**明文**（发信用，只此一次）+ hash + 过期时刻
 * （§23.3 / §24.2）。
 *
 * 契约（实现在合约内）：
 * - {@link generateTokenPlaintext}() → 明文；{@link hashToken}(明文) → tokenHash。
 * - `INSERT` 一行 `auth_tokens`：`token_hash`、`user_id`、`kind`、`expires_at = now + ttl`
 *   （verify 用 {@link VERIFY_TOKEN_TTL_SECONDS}、reset 用 {@link RESET_TOKEN_TTL_SECONDS}，
 *   `ttlSeconds` 可覆盖）、`used_at = NULL`、`created_at = now`（ISO-8601）。
 * - **绝不**落库明文；明文只在返回值 {@link IssuedToken.plaintext} 里出现一次，供调用方拼
 *   邮件链接，之后丢弃（不入库 / 不进日志 / 不回响应，§22.4）。
 * - 同一 user 可有多枚未用 token（重发验证 / 多次发起改密）；旧的不自动失效（除非
 *   {@link revokeUserTokens} 主动清，或它们各自过期）。
 *
 * @param db D1 binding（同 users / owner_config 所用的 `DB`）。
 * @param userId 归属 user（users.id）。
 * @param kind 用途（'verify' | 'reset'）。
 * @param ttlSeconds 可选 TTL 覆盖；缺省按 kind 取默认。
 * @returns {@link IssuedToken}（含明文，发信用一次）。
 */
export async function issueToken(
  db: D1Database,
  userId: string,
  kind: TokenKind,
  ttlSeconds?: number,
): Promise<IssuedToken> {
  const plaintext = generateTokenPlaintext();
  const tokenHash = await hashToken(plaintext);
  const ttl =
    ttlSeconds ?? (kind === "verify" ? VERIFY_TOKEN_TTL_SECONDS : RESET_TOKEN_TTL_SECONDS);
  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttl * 1000).toISOString();

  // 只落 hash + 元数据，**绝不**落明文（§22.4）。明文只在返回值里出现一次供发信。
  await db
    .prepare(
      `INSERT INTO auth_tokens (token_hash, user_id, kind, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    )
    .bind(tokenHash, userId, kind, expiresAt, createdAt)
    .run();

  return { plaintext, tokenHash, expiresAt };
}

/**
 * 校验并**消费**一个明文 token（确认环节，§23.4 / §24.3）。成功即在同一步把它作废。
 *
 * 契约（实现在合约内）：
 * - {@link hashToken}(plaintext) → 按 token_hash 查 `auth_tokens` 行。
 * - {@link isTokenUsable}(row, expectedKind, now) 为真 ⇒ 把 `used_at` 写成当前时刻（单次使用、
 *   作废）并返回该行的 `userId`；否则（行不存在 / 已用 / 过期 / kind 不匹配）→ 返回 `null`。
 * - **原子单次使用**：作废用「`UPDATE ... SET used_at=? WHERE token_hash=? AND used_at IS NULL`、
 *   影响 1 行才算消费成功」兜住并发重放（两个并发确认同一 token，只有一个 1 行成功，另一个 0
 *   行 → `null`）——不能只靠先查后写（TOCTOU）。
 * - 失败一律收敛成 `null`，**不区分**原因，绝不把 token 内容 / 失败缘由写进响应或日志（§24.3）。
 *
 * @param db D1 binding。
 * @param plaintext 来自邮件链接 ?token= 的明文 token。
 * @param expectedKind 期望用途（verify-confirm 传 'verify'、reset-confirm 传 'reset'）。
 * @returns 消费成功的 `{ userId }`，或 `null`（任何失败，统一收敛）。
 */
export async function consumeToken(
  db: D1Database,
  plaintext: string,
  expectedKind: TokenKind,
): Promise<{ userId: string } | null> {
  const tokenHash = await hashToken(plaintext);
  const row = await db
    .prepare(
      `SELECT token_hash, user_id, kind, expires_at, used_at, created_at
       FROM auth_tokens WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .first<{
      token_hash: string;
      user_id: string;
      kind: string;
      expires_at: string;
      used_at: string | null;
      created_at: string;
    }>();

  // 行不存在 / kind 不匹配 / 已用 / 过期 → 一律收敛成 null，不区分原因（§24.3）。
  if (row === null) {
    return null;
  }
  const authRow: AuthTokenRow = {
    tokenHash: row.token_hash,
    userId: row.user_id,
    kind: row.kind as TokenKind,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
  if (!isTokenUsable(authRow, expectedKind)) {
    return null;
  }

  // 原子单次使用（§22.4）：`UPDATE ... WHERE token_hash=? AND used_at IS NULL`、影响 1 行
  // 才算消费成功——兜住并发重放（两个并发确认同一 token，只有一个 1 行成功，另一个 0 行 → null）。
  // 不能只靠上面的先查后写（TOCTOU）。
  const usedAt = new Date().toISOString();
  const result = await db
    .prepare(`UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`)
    .bind(usedAt, tokenHash)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    return null;
  }
  return { userId: authRow.userId };
}

/**
 * 作废某 user 名下指定 kind 的所有未用 token（§17.2 覆盖重注册 / §24.3 改密成功后清残留）。
 *
 * 契约（实现在合约内）：
 * - `DELETE`（或把 used_at 标记为现在）`auth_tokens WHERE user_id=? AND kind=?`，把该 user 名下
 *   该 kind 的活 token 一并作废。删除语义由实现择一（DELETE 或标记），但必须使旧 token 此后
 *   {@link consumeToken} 一律失败。
 * - 用途：①覆盖重注册时清掉被覆盖的旧未验证号的残留 verify token；②改密成功后让该 user 名下
 *   其余 reset token 立即失效（防一封旧邮件二次改密）。
 *
 * @param db D1 binding。
 * @param userId 目标 user（users.id）。
 * @param kind 要作废的 token 用途。
 */
export async function revokeUserTokens(
  db: D1Database,
  userId: string,
  kind: TokenKind,
): Promise<void> {
  // DELETE 让该 user 名下该 kind 的所有 token 此后 consumeToken 一律失败（§17.2 / §24.3）。
  await db
    .prepare(`DELETE FROM auth_tokens WHERE user_id = ? AND kind = ?`)
    .bind(userId, kind)
    .run();
}
