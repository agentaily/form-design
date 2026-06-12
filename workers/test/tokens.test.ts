import { describe, it, expect } from "vitest";
import {
  generateTokenPlaintext,
  hashToken,
  isTokenUsable,
  TOKEN_RANDOM_BYTES,
  type AuthTokenRow,
} from "../src/tokens";

// Inner-loop unit specs for the PURE token primitives in tokens.ts (SPEC.md §22.4 /
// §23.4 / §24.3). These are the network-free / D1-free seam the outer loop builds on,
// tested here in isolation: plaintext generation (entropy), one-way hashing
// (deterministic + irreversible), and the usable/invalid decision (all branches).
//
//   - generateTokenPlaintext: high-entropy, URL-safe, distinct per call
//   - hashToken: deterministic (same plaintext → same hash), one-way (≠ plaintext)
//   - isTokenUsable: usable only when kind matches AND未用 AND未过期 (each branch)

const NOW = Date.UTC(2026, 5, 12, 12, 0, 0); // 2026-06-12T12:00:00Z
const iso = (ms: number) => new Date(ms).toISOString();

/** A baseline freshly-issued, unused, future-expiring verify row at NOW. */
function freshRow(overrides: Partial<AuthTokenRow> = {}): AuthTokenRow {
  return {
    tokenHash: "deadbeef",
    userId: "11111111-2222-3333-4444-555555555555",
    kind: "verify",
    expiresAt: iso(NOW + 60 * 60 * 1000), // +1h
    usedAt: null,
    createdAt: iso(NOW),
    ...overrides,
  };
}

describe("generateTokenPlaintext (SPEC.md §22.4)", () => {
  it("returns a non-empty, URL-safe string", () => {
    const t = generateTokenPlaintext();
    expect(t).toBeTypeOf("string");
    expect(t.length).toBeGreaterThan(0);
    // URL-safe: no chars that would need escaping inside an email link ?token=.
    // (base64url / hex alphabets are both covered by [A-Za-z0-9_-]).
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("carries ≥ 128 bit of entropy (encodes at least TOKEN_RANDOM_BYTES of randomness)", () => {
    // hex encodes 1 byte → 2 chars; base64url encodes 3 bytes → 4 chars. Either way
    // a TOKEN_RANDOM_BYTES (=32) payload yields a comfortably long string. We assert
    // a conservative lower bound (base64url of 32 bytes ≈ 43 chars).
    const t = generateTokenPlaintext();
    const minLen = Math.ceil((TOKEN_RANDOM_BYTES * 8) / 6); // base64url floor
    expect(t.length).toBeGreaterThanOrEqual(minLen);
  });

  it("is unpredictable — distinct on every call (no counter / timestamp derivation)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      seen.add(generateTokenPlaintext());
    }
    // 64 independent draws of ≥128-bit randomness must never collide.
    expect(seen.size).toBe(64);
  });
});

describe("hashToken (SPEC.md §22.4)", () => {
  it("is deterministic — the same plaintext always hashes to the same value", async () => {
    const plaintext = generateTokenPlaintext();
    const a = await hashToken(plaintext);
    const b = await hashToken(plaintext);
    // Confirm 时把收到的明文重新 hash 再按 token_hash 查行 — 必须确定性。
    expect(a).toBe(b);
  });

  it("is one-way — the hash is not the plaintext and reveals nothing of it", async () => {
    const plaintext = generateTokenPlaintext();
    const h = await hashToken(plaintext);
    expect(h).not.toBe(plaintext);
    expect(h).not.toContain(plaintext);
  });

  it("maps distinct plaintexts to distinct hashes", async () => {
    const a = await hashToken(generateTokenPlaintext());
    const b = await hashToken(generateTokenPlaintext());
    expect(a).not.toBe(b);
  });

  it("emits a stable-length, storable (URL/TEXT-safe) digest", async () => {
    const h = await hashToken("any-plaintext-here");
    expect(h.length).toBeGreaterThan(0);
    // The token_hash column is plain TEXT; hex or base64url both qualify.
    expect(h).toMatch(/^[A-Za-z0-9_+/=-]+$/);
  });
});

describe("isTokenUsable (SPEC.md §23.4 / §24.3)", () => {
  it("is true for a fresh, unused, non-expired row of the expected kind", () => {
    expect(isTokenUsable(freshRow(), "verify", NOW)).toBe(true);
  });

  it("is false when the kind does not match", () => {
    // A reset token presented to verify-confirm (or vice versa) → invalid.
    expect(isTokenUsable(freshRow({ kind: "reset" }), "verify", NOW)).toBe(false);
    expect(isTokenUsable(freshRow({ kind: "verify" }), "reset", NOW)).toBe(false);
  });

  it("is false when the token has already been used (used_at set)", () => {
    expect(isTokenUsable(freshRow({ usedAt: iso(NOW - 1000) }), "verify", NOW)).toBe(false);
  });

  it("is false when the token has expired (now ≥ expires_at)", () => {
    const expired = freshRow({ expiresAt: iso(NOW - 1000) });
    expect(isTokenUsable(expired, "verify", NOW)).toBe(false);
  });

  it("is false exactly at the expiry instant (boundary: now === expires_at)", () => {
    const atBoundary = freshRow({ expiresAt: iso(NOW) });
    expect(isTokenUsable(atBoundary, "verify", NOW)).toBe(false);
  });

  it("defaults `now` to the current time when omitted", () => {
    // A row that expired in the distant past must be invalid under the default clock.
    const longExpired = freshRow({ expiresAt: iso(Date.UTC(2000, 0, 1)) });
    expect(isTokenUsable(longExpired, "verify")).toBe(false);
    // ...and a far-future row is still usable under the default clock.
    const longLived = freshRow({ expiresAt: iso(Date.UTC(2100, 0, 1)) });
    expect(isTokenUsable(longLived, "verify")).toBe(true);
  });
});
