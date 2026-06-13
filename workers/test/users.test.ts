import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { testEnv, applySchema } from "./helpers";
import {
  createUser,
  findUserByEmail,
  findUserById,
  authenticateUser,
  markEmailVerified,
  updateDisplayName,
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
    // email_verified starts at 0 on a fresh register (§23): a real status bit now,
    // flipped to 1 only by verify-email/confirm — not gating any feature.
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

  // 去重三态 (§17.2 修订，防「占座别人邮箱」):
  //   不存在 → 建号；未验证 → 覆盖重注册（换新 id + 新密码 + 清残留）；已验证 → 锁死 (EmailTakenError)。

  it("OVERWRITES an UNVERIFIED same-email re-registration with a NEW id (未验证可覆盖, §17.2)", async () => {
    const first = await createUser(testEnv.DB, EMAIL, PASSWORD);
    // The email exists but is unverified (email_verified=0) → the真实邮箱主人 can take it
    // back: a re-register succeeds, mints a NEW user id, and stores the NEW password.
    const second = await createUser(testEnv.DB, EMAIL, "another-strong-password");
    expect(second.id).not.toBe(first.id);
    // The email row now resolves to the NEW account (single users row per email, UNIQUE).
    const row = await findUserByEmail(testEnv.DB, EMAIL);
    expect(row!.id).toBe(second.id);
    // ...and the old account id no longer exists (覆盖清掉了旧未验证行).
    expect(await findUserById(testEnv.DB, first.id)).toBeNull();
    // The NEW password authenticates; the OLD one no longer does.
    expect(await authenticateUser(testEnv.DB, EMAIL, "another-strong-password")).not.toBeNull();
    expect(await authenticateUser(testEnv.DB, EMAIL, PASSWORD)).toBeNull();
  });

  it("LOCKS a VERIFIED email — re-registration throws EmailTakenError (一旦验证就锁死, §17.2)", async () => {
    const { id } = await createUser(testEnv.DB, EMAIL, PASSWORD);
    // Once the email is verified (§23.4), it is locked: nobody can overwrite it.
    await markEmailVerified(testEnv.DB, id);
    await expect(createUser(testEnv.DB, EMAIL, "another-strong-password")).rejects.toBeInstanceOf(
      EmailTakenError,
    );
    // The verified account is untouched: its original password still authenticates.
    expect(await authenticateUser(testEnv.DB, EMAIL, PASSWORD)).not.toBeNull();
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

describe("display_name (SPEC.md §17 owner 个人资料)", () => {
  it("a freshly created user has display_name = null (未设置 → 回退用邮箱)", async () => {
    await createUser(testEnv.DB, EMAIL, PASSWORD);
    const user = await findUserByEmail(testEnv.DB, EMAIL);
    expect(user!.displayName).toBeNull();
  });

  it("updateDisplayName sets a display name (readable via findUserById/Email)", async () => {
    const { id } = await createUser(testEnv.DB, EMAIL, PASSWORD);
    await updateDisplayName(testEnv.DB, id, "陈伟");
    expect((await findUserById(testEnv.DB, id))!.displayName).toBe("陈伟");
    expect((await findUserByEmail(testEnv.DB, EMAIL))!.displayName).toBe("陈伟");
  });

  it("updateDisplayName with null clears the display name (回退用邮箱)", async () => {
    const { id } = await createUser(testEnv.DB, EMAIL, PASSWORD);
    await updateDisplayName(testEnv.DB, id, "陈伟");
    await updateDisplayName(testEnv.DB, id, null);
    expect((await findUserById(testEnv.DB, id))!.displayName).toBeNull();
  });

  it("updateDisplayName touches only display_name — never email / password / verified", async () => {
    const { id } = await createUser(testEnv.DB, EMAIL, PASSWORD);
    await markEmailVerified(testEnv.DB, id);
    const before = await findUserById(testEnv.DB, id);
    await updateDisplayName(testEnv.DB, id, "陈伟");
    const after = await findUserById(testEnv.DB, id);
    // The display name changed...
    expect(after!.displayName).toBe("陈伟");
    // ...but nothing else did, and the password still authenticates.
    expect(after!.email).toBe(before!.email);
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect(after!.passwordSalt).toBe(before!.passwordSalt);
    expect(after!.iterations).toBe(before!.iterations);
    expect(after!.emailVerified).toBe(before!.emailVerified);
    expect(await authenticateUser(testEnv.DB, EMAIL, PASSWORD)).not.toBeNull();
  });

  it("updateDisplayName is isolated per user (A's change does not touch B)", async () => {
    const a = await createUser(testEnv.DB, "a@example.com", PASSWORD);
    const b = await createUser(testEnv.DB, "b@example.com", PASSWORD);
    await updateDisplayName(testEnv.DB, a.id, "甲");
    expect((await findUserById(testEnv.DB, a.id))!.displayName).toBe("甲");
    expect((await findUserById(testEnv.DB, b.id))!.displayName).toBeNull();
  });
});
