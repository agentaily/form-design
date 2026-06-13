import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applySchema, resetSubmissions, testEnv } from "./helpers";
import {
  insertSubmission,
  listSubmissions,
  recordFeishuSync,
  recordFeishuSyncError,
} from "../src/submissions";

// Inner-loop unit specs for the D1 submissions store (src/submissions.ts), driven
// directly against the miniflare D1 (no HTTP). Covers the seams the §15 submit route
// + §18 data-backend route compose: insert (主存写入)、list (owner+slug 隔离读)、
// recordFeishuSync / recordFeishuSyncError (飞书 best-effort 同步回执回填).
//
// Contract: SPEC.md §15 / §18.

const OWNER_A = "owner-aaaa-1111";
const OWNER_B = "owner-bbbb-2222";

describe("submissions D1 store (src/submissions.ts)", () => {
  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetSubmissions();
  });

  it("insertSubmission + listSubmissions round-trips the answers", async () => {
    await insertSubmission(testEnv.DB, {
      id: "s1",
      formSlug: "form-x",
      ownerId: OWNER_A,
      answers: [
        { label: "姓名", value: "张三" },
        { label: "兴趣", value: ["阅读", "运动"] },
      ],
      createdAt: "2026-06-14T00:00:00.000Z",
    });

    const rows = await listSubmissions(testEnv.DB, OWNER_A, "form-x");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("s1");
    expect(rows[0].createdAt).toBe("2026-06-14T00:00:00.000Z");
    expect(rows[0].answers).toEqual([
      { label: "姓名", value: "张三" },
      { label: "兴趣", value: ["阅读", "运动"] },
    ]);
    // A fresh submission has empty feishu sync receipt.
    expect(rows[0].feishu).toEqual({ recordId: null, syncedAt: null, error: null });
  });

  it("listSubmissions isolates by owner_id (A never sees B's)", async () => {
    await insertSubmission(testEnv.DB, {
      id: "a1",
      formSlug: "form-x",
      ownerId: OWNER_A,
      answers: [{ label: "q", value: "a" }],
      createdAt: "2026-06-14T00:00:00.000Z",
    });
    await insertSubmission(testEnv.DB, {
      id: "b1",
      formSlug: "form-x",
      ownerId: OWNER_B,
      answers: [{ label: "q", value: "b" }],
      createdAt: "2026-06-14T00:00:01.000Z",
    });

    const aRows = await listSubmissions(testEnv.DB, OWNER_A, "form-x");
    expect(aRows.map((r) => r.id)).toEqual(["a1"]);
    const bRows = await listSubmissions(testEnv.DB, OWNER_B, "form-x");
    expect(bRows.map((r) => r.id)).toEqual(["b1"]);
  });

  it("listSubmissions filters by form_slug and returns newest first", async () => {
    await insertSubmission(testEnv.DB, {
      id: "older",
      formSlug: "form-x",
      ownerId: OWNER_A,
      answers: [{ label: "q", value: "1" }],
      createdAt: "2026-06-14T00:00:00.000Z",
    });
    await insertSubmission(testEnv.DB, {
      id: "newer",
      formSlug: "form-x",
      ownerId: OWNER_A,
      answers: [{ label: "q", value: "2" }],
      createdAt: "2026-06-14T01:00:00.000Z",
    });
    await insertSubmission(testEnv.DB, {
      id: "other-form",
      formSlug: "form-y",
      ownerId: OWNER_A,
      answers: [{ label: "q", value: "3" }],
      createdAt: "2026-06-14T02:00:00.000Z",
    });

    const rows = await listSubmissions(testEnv.DB, OWNER_A, "form-x");
    // Only form-x rows, newest created_at first.
    expect(rows.map((r) => r.id)).toEqual(["newer", "older"]);
  });

  it("listSubmissions on an empty store returns []", async () => {
    expect(await listSubmissions(testEnv.DB, OWNER_A, "nope")).toEqual([]);
  });

  it("recordFeishuSync back-fills record id + synced_at and clears any prior error", async () => {
    await insertSubmission(testEnv.DB, {
      id: "s1",
      formSlug: "form-x",
      ownerId: OWNER_A,
      answers: [{ label: "q", value: "a" }],
      createdAt: "2026-06-14T00:00:00.000Z",
    });
    // A prior failed attempt left an error...
    await recordFeishuSyncError(testEnv.DB, "s1", "BitableWriteError");
    // ...then a later success clears it and records the receipt.
    await recordFeishuSync(testEnv.DB, "s1", "recABC", "2026-06-14T00:01:00.000Z");

    const [row] = await listSubmissions(testEnv.DB, OWNER_A, "form-x");
    expect(row.feishu).toEqual({
      recordId: "recABC",
      syncedAt: "2026-06-14T00:01:00.000Z",
      error: null,
    });
  });

  it("recordFeishuSyncError records a (non-sensitive) error without a record id", async () => {
    await insertSubmission(testEnv.DB, {
      id: "s1",
      formSlug: "form-x",
      ownerId: OWNER_A,
      answers: [{ label: "q", value: "a" }],
      createdAt: "2026-06-14T00:00:00.000Z",
    });
    await recordFeishuSyncError(testEnv.DB, "s1", "FeishuTokenError");

    const [row] = await listSubmissions(testEnv.DB, OWNER_A, "form-x");
    expect(row.feishu.error).toBe("FeishuTokenError");
    expect(row.feishu.recordId).toBeNull();
    expect(row.feishu.syncedAt).toBeNull();
  });
});
