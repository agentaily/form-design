import { describe, it, expect } from "vitest";
import { sign as honoSign } from "hono/jwt";
import {
  signSession,
  verifySession,
  DEFAULT_OWNER_SUB,
  DEFAULT_SESSION_TTL_SECONDS,
} from "../src/auth";

// Inner-loop unit specs for the pure sign/verify seam in auth.ts. These are the
// mockable core the outer-loop auth-api.test.ts builds on, tested here in
// isolation (no Hono, no D1, no fetch): just AUTH_SECRET in / Session | null out.
//
//   - signSession   → verifySession round-trips (sub='default' + a future exp)
//   - verifySession returns null for a bad signature (wrong secret)
//   - verifySession returns null for an expired token
//   - verifySession returns null for a structurally invalid token
//   - a failure never throws a sensitive detail (収敛 to null, §17.7)
//
// Contract: SPEC.md §17.3 (session JWT 约定) / §17.4 (验签 + 未过期) / §17.7 (安全).

const SECRET = "unit-test-auth-secret-hmac-key-abc123";
const WRONG_SECRET = "a-completely-different-secret-xyz789";

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("signSession + verifySession round-trip (SPEC.md §17.3 / §17.4)", () => {
  it("a freshly signed session verifies back to sub='default' + a future exp", async () => {
    const before = nowSeconds();
    const token = await signSession(SECRET);
    expect(token).toBeTypeOf("string");
    expect(token.length).toBeGreaterThan(0);
    // JWT is three base64url segments — never the raw secret/password.
    expect(token.split(".")).toHaveLength(3);
    expect(token).not.toContain(SECRET);

    const session = await verifySession(token, SECRET);
    expect(session).not.toBeNull();
    // MVP single owner: sub is the fixed default.
    expect(session?.sub).toBe(DEFAULT_OWNER_SUB);
    // exp is a Unix-seconds timestamp in the future, within the default TTL window.
    expect(session?.exp).toBeTypeOf("number");
    expect(session!.exp).toBeGreaterThan(before);
    expect(session!.exp).toBeLessThanOrEqual(before + DEFAULT_SESSION_TTL_SECONDS + 5);
  });

  it("honours a custom sub + short TTL when signing", async () => {
    const before = nowSeconds();
    const token = await signSession(SECRET, { sub: "default", ttlSeconds: 60 });
    const session = await verifySession(token, SECRET);
    expect(session).not.toBeNull();
    expect(session?.sub).toBe("default");
    expect(session!.exp).toBeGreaterThan(before);
    expect(session!.exp).toBeLessThanOrEqual(before + 60 + 5);
  });

  it("the signed payload carries no secret material (JWT is signed, not encrypted)", async () => {
    const token = await signSession(SECRET);
    // The payload segment is base64url-decodable by anyone; it must hold only
    // non-sensitive claims (sub/exp/iat), never the signing secret (§17.3 / §17.7).
    const payloadSeg = token.split(".")[1];
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(payloadSeg.replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
        ch.charCodeAt(0),
      ),
    );
    expect(json).not.toContain(SECRET);
    const claims = JSON.parse(json) as Record<string, unknown>;
    expect(claims.sub).toBe(DEFAULT_OWNER_SUB);
    expect(claims.exp).toBeTypeOf("number");
  });
});

describe("verifySession rejection paths return null (SPEC.md §17.4 / §17.7)", () => {
  it("returns null for a token signed with a DIFFERENT secret (bad signature)", async () => {
    // Signed with the wrong secret → our AUTH_SECRET can't verify it.
    const token = await signSession(WRONG_SECRET);
    const session = await verifySession(token, SECRET);
    expect(session).toBeNull();
  });

  it("returns null for an expired token (exp in the past)", async () => {
    // Hand-sign a token whose exp is already in the past, with the RIGHT secret —
    // so only the exp check can reject it (proves verify enforces 未过期, §17.4).
    const past = nowSeconds() - 60;
    const expired = await honoSign({ sub: DEFAULT_OWNER_SUB, exp: past }, SECRET, "HS256");
    const session = await verifySession(expired, SECRET);
    expect(session).toBeNull();
  });

  it("returns null for structurally invalid / garbage tokens without throwing", async () => {
    // Each of these must collapse to null (never throw a sensitive detail, §17.7).
    for (const bad of ["", "not-a-jwt", "a.b", "a.b.c.d", "...", "garbage.garbage.garbage"]) {
      const session = await verifySession(bad, SECRET);
      expect(session).toBeNull();
    }
  });

  it("never throws an error carrying the secret on a rejected token (§17.7)", async () => {
    // verifySession must converge failures to null, not surface the secret / the
    // rejected token's internals via a thrown message.
    const tampered = (await signSession(SECRET)) + "TAMPERED";
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
