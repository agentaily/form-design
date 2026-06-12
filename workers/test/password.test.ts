import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, DEFAULT_PBKDF2_ITERATIONS } from "../src/password";

// Inner-loop unit specs for password.ts — the PBKDF2-HMAC-SHA256 hash/verify seam
// (SPEC.md §17.4). Pure WebCrypto, no D1 / no Hono: plaintext in → { hash, salt,
// iterations } out, and a constant-time verify back. These compose into users.ts
// (createUser / authenticateUser), exercised by the outer loop via SELF.fetch.
//
//   - round-trip: a freshly hashed password verifies against its own derived value
//   - a wrong password is rejected
//   - each hash uses a fresh per-user salt (never globally shared)
//   - verify honours the STORED iterations (调高迭代数不破坏旧 hash)
//   - the plaintext never appears in the persisted triple (绝不入库)

const PASSWORD = "correct-horse-battery-staple";

describe("hashPassword + verifyPassword round-trip (SPEC.md §17.4)", () => {
  it("a freshly hashed password verifies back to true", async () => {
    // Given a plaintext password hashed for storage
    const { hash, salt, iterations } = await hashPassword(PASSWORD);

    // When the same plaintext is verified against the stored triple
    const ok = await verifyPassword(PASSWORD, hash, salt, iterations);

    // Then it matches
    expect(ok).toBe(true);
  });

  it("records the default iteration count on a fresh hash", async () => {
    const { iterations } = await hashPassword(PASSWORD);
    // iterations is persisted per-user so it can be raised later without breaking
    // old hashes; a fresh hash starts at the default (§17.4).
    expect(iterations).toBe(DEFAULT_PBKDF2_ITERATIONS);
  });

  it("emits base64 hash + salt (D1 stores them as TEXT)", async () => {
    const { hash, salt } = await hashPassword(PASSWORD);
    const base64 = /^[A-Za-z0-9+/]+=*$/;
    expect(hash).toMatch(base64);
    expect(salt).toMatch(base64);
  });

  it("never embeds the plaintext password in the persisted triple (绝不入库)", async () => {
    const { hash, salt } = await hashPassword(PASSWORD);
    // The derived hash + salt are not the plaintext (decode them to be sure no
    // ASCII of the password survives the base64).
    expect(hash).not.toContain(PASSWORD);
    expect(salt).not.toContain(PASSWORD);
    const decode = (b64: string) => atob(b64);
    expect(decode(hash)).not.toContain(PASSWORD);
    expect(decode(salt)).not.toContain(PASSWORD);
  });
});

describe("verifyPassword rejects a wrong password (SPEC.md §17.4)", () => {
  it("returns false for a different password against the same hash", async () => {
    const { hash, salt, iterations } = await hashPassword(PASSWORD);
    // A near-miss (one char off) must not verify — PBKDF2 is sensitive to the
    // whole input, and the constant-time compare of derived values rejects it.
    expect(await verifyPassword("correct-horse-battery-stapl3", hash, salt, iterations)).toBe(
      false,
    );
    expect(await verifyPassword("", hash, salt, iterations)).toBe(false);
    expect(await verifyPassword("totally-different", hash, salt, iterations)).toBe(false);
  });

  it("returns false (without throwing) for a malformed stored salt/hash", async () => {
    // A garbage stored value must not surface a sensitive detail upward — a verify
    // that can't even run is simply "does not match".
    const ok = await verifyPassword(PASSWORD, "!!!not-base64!!!", "###", DEFAULT_PBKDF2_ITERATIONS);
    expect(ok).toBe(false);
  });
});

describe("hashPassword uses a fresh per-user salt (SPEC.md §17.4)", () => {
  it("produces a different salt + hash for the same plaintext each time", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);

    // Per-user random salt → distinct salts, and therefore distinct derived hashes,
    // for the very same plaintext (never globally shared).
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);

    // Both still verify back to the same plaintext under their own salt.
    expect(await verifyPassword(PASSWORD, a.hash, a.salt, a.iterations)).toBe(true);
    expect(await verifyPassword(PASSWORD, b.hash, b.salt, b.iterations)).toBe(true);

    // ...and crucially, one's hash does NOT verify under the other's salt.
    expect(await verifyPassword(PASSWORD, a.hash, b.salt, b.iterations)).toBe(false);
  });
});

describe("verifyPassword honours the STORED iterations (SPEC.md §17.4)", () => {
  it("a hash derived at N iterations only verifies when re-derived at N", async () => {
    const { hash, salt, iterations } = await hashPassword(PASSWORD);
    // Re-deriving at a DIFFERENT iteration count yields a different value → reject.
    // This is what proves verify uses the stored iterations, not a global constant
    // — the mechanism that lets us raise iterations later without breaking old hashes.
    expect(await verifyPassword(PASSWORD, hash, salt, iterations + 1)).toBe(false);
    expect(await verifyPassword(PASSWORD, hash, salt, iterations)).toBe(true);
  });
});
