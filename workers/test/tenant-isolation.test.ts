import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { testEnv, applySchema, resetForms, resetConfig } from "./helpers";
import { importConfigKey } from "../src/crypto";
import { saveForm, listForms, updateForm, deleteForm, getFormOwner } from "../src/forms";
import { saveConfig, getMaskedConfig, getOwnerConfig } from "../src/config";

// Inner-loop unit specs for the multi-tenant data layer (SPEC.md §17.9 第 1–7 条).
// These drive the forms / config functions DIRECTLY against the test D1 (no Hono,
// no auth middleware) to pin the WHERE-owner_id filtering that makes 横向越权
// impossible — the route-level 404/isolation behavior is the outer loop's
// tenant-isolation.spec / *-api.test.ts. Here we assert the data layer itself:
//
//   - getFormOwner reverse-looks-up the owning owner_id by slug
//   - listForms only returns the queried owner's forms
//   - updateForm / deleteForm no-op (null / false) across owners
//   - saveConfig / getMaskedConfig / getOwnerConfig are per-owner isolated

const OWNER_A = "aaaaaaaa-0000-0000-0000-000000000001";
const OWNER_B = "bbbbbbbb-0000-0000-0000-000000000002";

const FORM_A = {
  meta: { title: "A 的表单" },
  fields: [{ id: "f1", type: "text" as const, label: "姓名" }],
};
const FORM_B = {
  meta: { title: "B 的表单" },
  fields: [{ id: "f1", type: "text" as const, label: "公司" }],
};

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetForms();
  await resetConfig();
});

describe("getFormOwner reverse-lookup (SPEC.md §17.9 第 5 条)", () => {
  it("returns the owner_id that published the slug", async () => {
    const { slug } = await saveForm(testEnv.DB, OWNER_A, FORM_A);
    expect(await getFormOwner(testEnv.DB, slug)).toBe(OWNER_A);
  });

  it("returns null for a slug that does not exist", async () => {
    expect(await getFormOwner(testEnv.DB, "no-such-slug")).toBeNull();
  });
});

describe("listForms is scoped to one owner (SPEC.md §17.9 第 6 条)", () => {
  it("returns only the queried owner's forms, never another owner's", async () => {
    const a = await saveForm(testEnv.DB, OWNER_A, FORM_A);
    const b = await saveForm(testEnv.DB, OWNER_B, FORM_B);

    const aList = await listForms(testEnv.DB, OWNER_A);
    expect(aList.map((f) => f.slug)).toEqual([a.slug]);
    // B's form must NOT leak into A's list.
    expect(aList.map((f) => f.slug)).not.toContain(b.slug);

    const bList = await listForms(testEnv.DB, OWNER_B);
    expect(bList.map((f) => f.slug)).toEqual([b.slug]);
  });

  it("returns an empty list for an owner with no forms", async () => {
    await saveForm(testEnv.DB, OWNER_A, FORM_A);
    expect(await listForms(testEnv.DB, OWNER_B)).toEqual([]);
  });
});

describe("updateForm enforces owner_id (SPEC.md §17.9 第 2 条)", () => {
  it("updates a form for its own owner", async () => {
    const { slug } = await saveForm(testEnv.DB, OWNER_A, FORM_A);
    const updated = await updateForm(testEnv.DB, slug, OWNER_A, { status: "closed" });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("closed");
  });

  it("returns null (no-op) when a DIFFERENT owner tries to update the slug — and the row is untouched", async () => {
    const { slug } = await saveForm(testEnv.DB, OWNER_A, FORM_A);
    // B attempts to close A's form by slug → WHERE owner_id=B updates 0 rows → null.
    const crossOwner = await updateForm(testEnv.DB, slug, OWNER_B, { status: "closed" });
    expect(crossOwner).toBeNull();
    // A's form is unchanged (still published).
    const aView = await updateForm(testEnv.DB, slug, OWNER_A, {});
    expect(aView).not.toBeNull();
    expect(aView!.status).toBe("published");
  });

  it("returns null for a slug that does not exist (same as cross-owner — no existence leak)", async () => {
    expect(await updateForm(testEnv.DB, "no-such-slug", OWNER_A, { status: "closed" })).toBeNull();
  });
});

describe("deleteForm enforces owner_id (SPEC.md §17.9 第 3 条)", () => {
  it("deletes a form for its own owner", async () => {
    const { slug } = await saveForm(testEnv.DB, OWNER_A, FORM_A);
    expect(await deleteForm(testEnv.DB, slug, OWNER_A)).toBe(true);
    expect(await getFormOwner(testEnv.DB, slug)).toBeNull();
  });

  it("returns false (no-op) when a DIFFERENT owner tries to delete the slug — and the row survives", async () => {
    const { slug } = await saveForm(testEnv.DB, OWNER_A, FORM_A);
    // B attempts to delete A's form by slug → WHERE owner_id=B deletes 0 rows → false.
    expect(await deleteForm(testEnv.DB, slug, OWNER_B)).toBe(false);
    // A's form still exists.
    expect(await getFormOwner(testEnv.DB, slug)).toBe(OWNER_A);
  });

  it("returns false for a slug that does not exist (same as cross-owner)", async () => {
    expect(await deleteForm(testEnv.DB, "no-such-slug", OWNER_A)).toBe(false);
  });
});

describe("owner_config is per-owner isolated (SPEC.md §17.9 第 7 条)", () => {
  it("A's saved config is invisible to B, and vice versa", async () => {
    const key = await importConfigKey(testEnv.CONFIG_KEY);

    // A saves a DeepSeek key; B has saved nothing yet.
    await saveConfig(testEnv.DB, key, OWNER_A, { deepseek: { apiKey: "sk-owner-A-secret-key" } });

    // B reads its own config → all-null skeleton (the never-configured state).
    const bMasked = await getMaskedConfig(testEnv.DB, key, OWNER_B);
    expect(bMasked.deepseek.apiKey).toBeNull();
    expect(bMasked.updatedAt).toBeNull();

    // A reads its own config → masked, present.
    const aMasked = await getMaskedConfig(testEnv.DB, key, OWNER_A);
    expect(aMasked.deepseek.apiKey).not.toBeNull();
    expect(aMasked.updatedAt).not.toBeNull();

    // B's decrypted in-Worker view is empty — A's plaintext key never reaches B.
    const bPlain = await getOwnerConfig(testEnv.DB, key, OWNER_B);
    expect(bPlain.deepseek).toBeNull();
  });

  it("one owner's save does not overwrite another owner's row", async () => {
    const key = await importConfigKey(testEnv.CONFIG_KEY);
    await saveConfig(testEnv.DB, key, OWNER_A, {
      deepseek: { apiKey: "sk-A-key", model: "model-A" },
    });
    await saveConfig(testEnv.DB, key, OWNER_B, {
      deepseek: { apiKey: "sk-B-key", model: "model-B" },
    });

    // A re-reads → still A's own values, not clobbered by B's save.
    const aPlain = await getOwnerConfig(testEnv.DB, key, OWNER_A);
    expect(aPlain.deepseek?.apiKey).toBe("sk-A-key");
    expect(aPlain.deepseek?.model).toBe("model-A");

    const bPlain = await getOwnerConfig(testEnv.DB, key, OWNER_B);
    expect(bPlain.deepseek?.apiKey).toBe("sk-B-key");
    expect(bPlain.deepseek?.model).toBe("model-B");
  });
});
