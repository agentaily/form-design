import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { testEnv, applySchema } from "./helpers";
import {
  createUser,
  findUserByEmail,
  authenticateUser,
  EmailTakenError,
  UserValidationError,
  MIN_PASSWORD_LENGTH,
} from "../src/users";

// Inner-loop unit specs for users.ts — the open-registration user data layer
// (SPEC.md §17.2 / §17.3 / §17.4 / §17.11). These run against the test D1
// (miniflare, schema applied in beforeAll) but at the data-layer level, NOT through
// the Hono routes (those are the outer loop's auth-api.test.ts). We assert:
//
//   - createUser validates email shape + password strength (UserValidationError → 400)
//   - createUser persists ONLY the derived hash + salt + iterations (绝不入库明文)
//   - createUser de-dups on the UNIQUE email constraint (EmailTakenError → 409)
//   - findUserByEmail hits / misses
//   - authenticateUser verifies correct creds → { id }, rejects wrong → null
//   - authenticateUser runs even when the email does not exist (anti-enumeration)

const EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery-staple"; // ≥ 8

beforeAll(async () => {
  await applySchema();
});

// Each scenario starts from a clean users table (the suite registers / counts rows).
beforeEach(async () => {
  await testEnv.DB.exec("DELETE FROM users");
});

describe("createUser (SPEC.md §17.2 注册)", () => {
  it("creates a user and returns its real id (crypto.randomUUID shape)", async () => {
    const { id } = await createUser(testEnv.DB, EMAIL, PASSWORD);
    // The id is the data-isolation key (sub / owner_id) — a UUID, not 'default'.
    expect(id).toBeTypeOf("string");
    expect(id).not.toBe("default");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("persists only the PBKDF2 hash + salt + iterations — never the plaintext", async () => {
    const { id } = await createUser(testEnv.DB, EMAIL, PASSWORD);
    const user = await findUserByEmail(testEnv.DB, EMAIL);
    expect(user).not.toBeNull();
    expect(user!.id).toBe(id);
    // 明文密码绝不入库 (§17.4): the stored hash/salt are not the plaintext.
    expect(user!.passwordHash).not.toContain(PASSWORD);
    expect(user!.passwordSalt).not.toContain(PASSWORD);
    expect(user!.passwordHash.length).toBeGreaterThan(0);
    expect(user!.passwordSalt.length).toBeGreaterThan(0);
    expect(user!.iterations).toBeGreaterThan(0);
    // email_verified is reserved-and-fixed-0 this milestone (§17.11).
    expect(user!.emailVerified).toBe(0);
  });

  it("rejects a malformed email with UserValidationError (route → 400, not stored)", async () => {
    await expect(createUser(testEnv.DB, "not-an-email", PASSWORD)).rejects.toBeInstanceOf(
      UserValidationError,
    );
    // Nothing persisted on a validation failure.
    expect(await findUserByEmail(testEnv.DB, "not-an-email")).toBeNull();
  });

  it("rejects a weak password (< MIN_PASSWORD_LENGTH) with UserValidationError", async () => {
    const weak = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    await expect(createUser(testEnv.DB, EMAIL, weak)).rejects.toBeInstanceOf(UserValidationError);
    expect(await findUserByEmail(testEnv.DB, EMAIL)).toBeNull();
  });

  it("accepts a password of exactly MIN_PASSWORD_LENGTH", async () => {
    const exact = "a".repeat(MIN_PASSWORD_LENGTH);
    const { id } = await createUser(testEnv.DB, EMAIL, exact);
    expect(id).toBeTypeOf("string");
  });

  it("rejects a re-registration of the same email with EmailTakenError (UNIQUE → 409)", async () => {
    await createUser(testEnv.DB, EMAIL, PASSWORD);
    // The UNIQUE email constraint is the FINAL de-dup arbiter (§17.2) — a second
    // INSERT of the same email collides and surfaces as EmailTakenError.
    await expect(createUser(testEnv.DB, EMAIL, "another-strong-password")).rejects.toBeInstanceOf(
      EmailTakenError,
    );
  });
});

describe("findUserByEmail (SPEC.md §17.3)", () => {
  it("returns the row for a registered email", async () => {
    await createUser(testEnv.DB, EMAIL, PASSWORD);
    const user = await findUserByEmail(testEnv.DB, EMAIL);
    expect(user?.email).toBe(EMAIL);
  });

  it("returns null for an unknown email", async () => {
    expect(await findUserByEmail(testEnv.DB, "nobody@example.com")).toBeNull();
  });
});

describe("authenticateUser (SPEC.md §17.3 登录)", () => {
  it("returns { id } for the correct email + password", async () => {
    const { id } = await createUser(testEnv.DB, EMAIL, PASSWORD);
    const authed = await authenticateUser(testEnv.DB, EMAIL, PASSWORD);
    expect(authed).not.toBeNull();
    expect(authed!.id).toBe(id);
  });

  it("returns null for a registered email with the WRONG password", async () => {
    await createUser(testEnv.DB, EMAIL, PASSWORD);
    // Failure converges to null (the route maps it to a unified 401, §17.3).
    expect(await authenticateUser(testEnv.DB, EMAIL, "wrong-password-here")).toBeNull();
  });

  it("returns null for an email that was never registered (no enumeration signal)", async () => {
    // The user-absent path STILL runs a decoy hash (§17.3) so it can't be told apart
    // from "wrong password" — functionally we only assert it converges to null
    // without throwing (the timing property is guaranteed by the impl, not observable here).
    const authed = await authenticateUser(testEnv.DB, "ghost@example.com", PASSWORD);
    expect(authed).toBeNull();
  });

  it("returns null for a missing / empty password without throwing", async () => {
    await createUser(testEnv.DB, EMAIL, PASSWORD);
    expect(await authenticateUser(testEnv.DB, EMAIL, "")).toBeNull();
  });
});
