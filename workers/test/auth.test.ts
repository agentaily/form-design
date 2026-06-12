import { describe, it, expect } from "vitest";
import { sign as honoSign } from "hono/jwt";
import {
  signSession,
  verifySession,
  timingSafeEqualStr,
  DEFAULT_SESSION_TTL_SECONDS,
} from "../src/auth";

// Inner-loop unit specs for the pure sign/verify seam in auth.ts. These are the
// mockable core the outer-loop auth-api.test.ts builds on, tested here in
// isolation (no Hono, no D1, no fetch): just AUTH_SECRET in / Session | null out.
//
// Multi-user (§17.5): `sub` is the owner's REAL user id — required at sign time,
// no fallback default. signSession({ sub }) round-trips; verifySession converges
// every failure (bad signature / expired / garbage) to null without throwing.
//
//   - signSession({ sub }) → verifySession round-trips (the same sub + a future exp)
//   - verifySession returns null for a bad signature (wrong secret)
//   - verifySession returns null for an expired token
//   - verifySession returns null for a structurally invalid token
//   - a failure never throws a sensitive detail (収敛 to null, §17.6)
//
// Contract: SPEC.md §17.5 (session JWT 约定) / §17.6 (验签 + 未过期 + 安全).

const SECRET = "unit-test-auth-secret-hmac-key-abc123";
const WRONG_SECRET = "a-completely-different-secret-xyz789";
// A representative real user id (crypto.randomUUID() shape) — sub is now the
// data-isolation key, never the old fixed 'default'.
const USER_ID = "11111111-2222-3333-4444-555555555555";

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("signSession + verifySession round-trip (SPEC.md §17.5 / §17.6)", () => {
  it("a freshly signed session verifies back to the same sub + a future exp", async () => {
    const before = nowSeconds();
    const token = await signSession(SECRET, { sub: USER_ID });
    expect(token).toBeTypeOf("string");
    expect(token.length).toBeGreaterThan(0);
    // JWT is three base64url segments — never the raw secret/password.
    expect(token.split(".")).toHaveLength(3);
    expect(token).not.toContain(SECRET);

    const session = await verifySession(token, SECRET);
    expect(session).not.toBeNull();
    // Multi-user: sub is the real user id we signed, round-tripped intact.
    expect(session?.sub).toBe(USER_ID);
    // exp is a Unix-seconds timestamp in the future, within the default TTL window.
    expect(session?.exp).toBeTypeOf("number");
    expect(session!.exp).toBeGreaterThan(before);
    expect(session!.exp).toBeLessThanOrEqual(before + DEFAULT_SESSION_TTL_SECONDS + 5);
  });

  it("honours a custom sub + short TTL when signing", async () => {
    const before = nowSeconds();
    const otherId = "99999999-8888-7777-6666-555555555555";
    const token = await signSession(SECRET, { sub: otherId, ttlSeconds: 60 });
    const session = await verifySession(token, SECRET);
    expect(session).not.toBeNull();
    expect(session?.sub).toBe(otherId);
    expect(session!.exp).toBeGreaterThan(before);
    expect(session!.exp).toBeLessThanOrEqual(before + 60 + 5);
  });

  it("the signed payload carries no secret material (JWT is signed, not encrypted)", async () => {
    const token = await signSession(SECRET, { sub: USER_ID });
    // The payload segment is base64url-decodable by anyone; it must hold only
    // non-sensitive claims (sub/exp/iat), never the signing secret (§17.5 / §17.6).
    const payloadSeg = token.split(".")[1];
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(payloadSeg.replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
        ch.charCodeAt(0),
      ),
    );
    expect(json).not.toContain(SECRET);
    const claims = JSON.parse(json) as Record<string, unknown>;
    expect(claims.sub).toBe(USER_ID);
    expect(claims.exp).toBeTypeOf("number");
  });
});

describe("verifySession rejection paths return null (SPEC.md §17.6)", () => {
  it("returns null for a token signed with a DIFFERENT secret (bad signature)", async () => {
    // Signed with the wrong secret → our AUTH_SECRET can't verify it.
    const token = await signSession(WRONG_SECRET, { sub: USER_ID });
    const session = await verifySession(token, SECRET);
    expect(session).toBeNull();
  });

  it("returns null for an expired token (exp in the past)", async () => {
    // Hand-sign a token whose exp is already in the past, with the RIGHT secret —
    // so only the exp check can reject it (proves verify enforces 未过期, §17.6).
    const past = nowSeconds() - 60;
    const expired = await honoSign({ sub: USER_ID, exp: past }, SECRET, "HS256");
    const session = await verifySession(expired, SECRET);
    expect(session).toBeNull();
  });

  it("returns null for structurally invalid / garbage tokens without throwing", async () => {
    // Each of these must collapse to null (never throw a sensitive detail, §17.6).
    for (const bad of ["", "not-a-jwt", "a.b", "a.b.c.d", "...", "garbage.garbage.garbage"]) {
      const session = await verifySession(bad, SECRET);
      expect(session).toBeNull();
    }
  });

  it("never throws an error carrying the secret on a rejected token (§17.6)", async () => {
    // verifySession must converge failures to null, not surface the secret / the
    // rejected token's internals via a thrown message.
    const tampered = (await signSession(SECRET, { sub: USER_ID })) + "TAMPERED";
    let threw: unknown;
    let result: unknown;
    try {
      result = await verifySession(tampered, SECRET);
    } catch (err) {
      threw = err;
    }
    // Preferred contract:收敛 to null, no throw.
    expect(threw).toBeUndefined();
    expect(result).toBeNull();
  });
});

// --- §17.8 安全 nit：常量时间密码比较 ----------------------------------------
//
// timingSafeEqualStr 替代朴素 `===`：相等 → true、不等 → false、不同长 → false。
// 这里只断言它的功能正确性（布尔值）；时序属性（不短路）无法在功能测里可靠观测，
// 由实现保证。「不同长」与「同长但内容不同」两支足以钉死功能契约。
describe("timingSafeEqualStr (SPEC.md §17.8 常量时间比较)", () => {
  it("returns true for two equal strings", () => {
    expect(timingSafeEqualStr("correct-horse-battery-staple", "correct-horse-battery-staple")).toBe(
      true,
    );
  });

  it("returns false for two same-length but differing strings", () => {
    // 同长（都 5）但内容不同 → false（功能上等同 !==，但内部走常量时间）。
    expect(timingSafeEqualStr("abcde", "abcdX")).toBe(false);
    // 首位即不同的同长串 → 仍 false（不因「第一位就不同」而有别的结果）。
    expect(timingSafeEqualStr("Xbcde", "abcde")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(timingSafeEqualStr("abc", "abcdef")).toBe(false);
    expect(timingSafeEqualStr("abcdef", "abc")).toBe(false);
  });

  it("returns true for two empty strings and false when only one is empty", () => {
    expect(timingSafeEqualStr("", "")).toBe(true);
    expect(timingSafeEqualStr("", "x")).toBe(false);
    expect(timingSafeEqualStr("x", "")).toBe(false);
  });
});
