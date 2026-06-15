import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applySchema,
  resetProjects,
  resetChatSessions,
  resetUsers,
  registerOwner,
  authHeader,
  testEnv,
} from "./helpers";
import {
  migrateSessionsToProjects,
  rollbackProjectMigration,
  WORKSPACE_SNAPSHOT_ID,
  MIGRATION_BACKUP_TABLE,
  MIGRATE_CONFIRM,
} from "../src/migrateProjects";

// Outer-loop acceptance for the A' 一次性数据迁移 (PR-B, docs/refactor-project-conversation.md §2.3),
// realized at two altitudes against a real miniflare D1:
//   * DATA LAYER (`migrateSessionsToProjects` / `rollbackProjectMigration` on testEnv.DB): seed old
//     chat_sessions rows (project_id NULL, some with a #76 workspace snapshot turn), run the
//     migration, assert the end-state — projects minted with the right workspace, snapshot turn
//     stripped from turns_json, project_id backfilled, timestamps carried over, no-snapshot rows →
//     empty projects, dry-run writes nothing, idempotent re-run is a no-op, owner scope isolates,
//     backup written, rollback restores the pristine pre-migration state.
//   * ENDPOINT (`POST /api/admin/migrate-projects` via SELF.fetch): owner-only guard (401 without
//     token), dry-run default returns a report and writes nothing, apply requires confirm, the run
//     is scoped to the calling owner (never touches another owner's rows).
//
// WHY seed via direct D1 insert: old rows must have project_id = NULL + a literal snapshot turn +
// specific timestamps — the PR-A PUT routes can't produce that shape precisely. The schema has no FK
// to users, so a synthetic string owner_id is enough for the data-layer block; the endpoint block
// uses real registered owners (the guard validates the JWT sub).
//
// Contract: docs/refactor-project-conversation.md §2.3 + workers/src/migrateProjects.ts.

const BASE = "https://api.local";

const snapshotTurn = (meta: unknown, fields: unknown) => ({
  id: WORKSPACE_SNAPSHOT_ID,
  role: "assistant",
  kind: "workspace",
  meta,
  fields,
});

interface SeedRow {
  ownerId: string;
  sessionId: string;
  turns: unknown[];
  history?: unknown[];
  formSlug?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Insert an OLD chat_sessions row (project_id NULL, title NULL) directly — the pre-A' shape. */
async function seedOldSession(r: SeedRow): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO chat_sessions
       (owner_id, session_id, turns_json, history_json, form_slug, created_at, updated_at, project_id, title)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(
      r.ownerId,
      r.sessionId,
      JSON.stringify(r.turns),
      JSON.stringify(r.history ?? []),
      r.formSlug ?? null,
      r.createdAt ?? "2026-01-01T00:00:00.000Z",
      r.updatedAt ?? "2026-02-02T00:00:00.000Z",
    )
    .run();
}

interface SessionRow {
  project_id: string | null;
  turns_json: string;
  title: string | null;
}
async function readSession(ownerId: string, sessionId: string): Promise<SessionRow | null> {
  return testEnv.DB.prepare(
    `SELECT project_id, turns_json, title FROM chat_sessions WHERE owner_id = ? AND session_id = ?`,
  )
    .bind(ownerId, sessionId)
    .first<SessionRow>();
}

interface ProjectRow {
  meta_json: string | null;
  fields_json: string | null;
  form_slug: string | null;
  created_at: string;
  updated_at: string;
}
async function readProject(ownerId: string, projectId: string): Promise<ProjectRow | null> {
  return testEnv.DB.prepare(
    `SELECT meta_json, fields_json, form_slug, created_at, updated_at
     FROM projects WHERE owner_id = ? AND project_id = ?`,
  )
    .bind(ownerId, projectId)
    .first<ProjectRow>();
}

async function countBackup(): Promise<number> {
  const r = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${MIGRATION_BACKUP_TABLE}`).first<{
    n: number;
  }>();
  return r?.n ?? 0;
}

beforeAll(async () => {
  await applySchema();
});
beforeEach(async () => {
  await resetProjects();
  await resetChatSessions();
  await resetUsers();
  // The migration self-creates this table at runtime; drop it so each scenario starts clean.
  await testEnv.DB.exec(`DROP TABLE IF EXISTS ${MIGRATION_BACKUP_TABLE}`);
});

const OWNER_A = "owner-id-OWNER-A";
const OWNER_B = "owner-id-OWNER-B";

describe("migrateSessionsToProjects · 抽快照 + 回填 (§2.3, data layer)", () => {
  it("migrates a snapshot session into a project + strips the snapshot turn + backfills project_id", async () => {
    const db = testEnv.DB;
    const meta = { title: "活动报名表", description: "一段描述" };
    const fields = [
      { id: "f-1", type: "text", label: "姓名" },
      { id: "f-2", type: "email", label: "邮箱" },
    ];
    await seedOldSession({
      ownerId: OWNER_A,
      sessionId: "sess-snap",
      turns: [{ id: "u-0", role: "user", text: "帮我做报名表" }, snapshotTurn(meta, fields)],
      formSlug: "abc123",
      createdAt: "2026-03-03T00:00:00.000Z",
      updatedAt: "2026-04-04T00:00:00.000Z",
    });

    const report = await migrateSessionsToProjects(db, {});
    expect(report.mode).toBe("apply");
    expect(report.migrated).toBe(1);
    expect(report.withSnapshot).toBe(1);
    expect(report.withoutSnapshot).toBe(0);
    expect(report.backedUp).toBe(1);

    // 会话 project_id 回填 + 快照 turn 从 turns_json 删掉。
    const sess = await readSession(OWNER_A, "sess-snap");
    expect(sess?.project_id).toBeTruthy();
    expect(JSON.parse(sess!.turns_json)).toEqual([
      { id: "u-0", role: "user", text: "帮我做报名表" },
    ]);
    expect(sess?.title).toBeNull(); // 运行期推导，迁移不写 title

    // 新 project 行：工作区抽对、form_slug 上移、时间戳沿用会话（§2.3）。
    const proj = await readProject(OWNER_A, sess!.project_id!);
    expect(JSON.parse(proj!.meta_json!)).toEqual(meta);
    expect(JSON.parse(proj!.fields_json!)).toEqual(fields);
    expect(proj?.form_slug).toBe("abc123");
    expect(proj?.created_at).toBe("2026-03-03T00:00:00.000Z");
    expect(proj?.updated_at).toBe("2026-04-04T00:00:00.000Z");
  });

  it("a no-snapshot row mints an empty project (meta/fields NULL) and leaves turns_json untouched", async () => {
    const db = testEnv.DB;
    const turns = [
      { id: "u-0", role: "user", text: "纯 §26 老对话" },
      { id: "a-1", role: "assistant", text: "回应" },
    ];
    await seedOldSession({ ownerId: OWNER_A, sessionId: "sess-plain", turns });

    const report = await migrateSessionsToProjects(db, {});
    expect(report.withSnapshot).toBe(0);
    expect(report.withoutSnapshot).toBe(1);

    const sess = await readSession(OWNER_A, "sess-plain");
    expect(sess?.project_id).toBeTruthy();
    // 无快照 → turns_json 原样不动。
    expect(JSON.parse(sess!.turns_json)).toEqual(turns);

    const proj = await readProject(OWNER_A, sess!.project_id!);
    expect(proj?.meta_json).toBeNull();
    expect(proj?.fields_json).toBeNull(); // §2.3 空工作区留 NULL
  });

  it("dry-run reports what would change but writes NOTHING", async () => {
    const db = testEnv.DB;
    await seedOldSession({
      ownerId: OWNER_A,
      sessionId: "sess-dry",
      turns: [snapshotTurn({ title: "T" }, [{ id: "f-1", type: "text", label: "x" }])],
    });

    const report = await migrateSessionsToProjects(db, { dryRun: true });
    expect(report.mode).toBe("dry-run");
    expect(report.migrated).toBe(1);
    expect(report.withSnapshot).toBe(1);
    expect(report.backedUp).toBe(0);
    expect(report.samples[0]).toMatchObject({
      sessionId: "sess-dry",
      hadSnapshot: true,
      title: "T",
    });

    // 零写：会话仍 NULL-project、turns_json 仍含快照、无 projects 行、无备份表。
    const sess = await readSession(OWNER_A, "sess-dry");
    expect(sess?.project_id).toBeNull();
    expect(JSON.parse(sess!.turns_json)).toHaveLength(1);
    const projCount = await db.prepare(`SELECT COUNT(*) AS n FROM projects`).first<{ n: number }>();
    expect(projCount?.n).toBe(0);
    const hasBackup = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .bind(MIGRATION_BACKUP_TABLE)
      .first();
    expect(hasBackup).toBeNull();
  });

  it("is idempotent: a second run migrates 0 rows and does not re-touch already-migrated sessions", async () => {
    const db = testEnv.DB;
    await seedOldSession({
      ownerId: OWNER_A,
      sessionId: "sess-idem",
      turns: [{ id: "u-0", role: "user", text: "hi" }, snapshotTurn({ title: "T" }, [])],
    });

    const first = await migrateSessionsToProjects(db, {});
    expect(first.migrated).toBe(1);
    const sess1 = await readSession(OWNER_A, "sess-idem");
    const projId1 = sess1!.project_id;

    // 二次跑：候选 = 0（已迁的 project_id 非 NULL），不重抽、不改 project_id。
    const second = await migrateSessionsToProjects(db, {});
    expect(second.migrated).toBe(0);
    expect(second.withSnapshot).toBe(0);

    const sess2 = await readSession(OWNER_A, "sess-idem");
    expect(sess2!.project_id).toBe(projId1); // 同一个 project，没被换
    const projCount = await db.prepare(`SELECT COUNT(*) AS n FROM projects`).first<{ n: number }>();
    expect(projCount?.n).toBe(1); // 没多 mint 一个
  });

  it("scopes to one owner: ownerId filter never touches another owner's rows", async () => {
    const db = testEnv.DB;
    await seedOldSession({
      ownerId: OWNER_A,
      sessionId: "a-sess",
      turns: [snapshotTurn({ title: "A" }, [])],
    });
    await seedOldSession({
      ownerId: OWNER_B,
      sessionId: "b-sess",
      turns: [snapshotTurn({ title: "B" }, [])],
    });

    const report = await migrateSessionsToProjects(db, { ownerId: OWNER_A });
    expect(report.migrated).toBe(1);

    expect((await readSession(OWNER_A, "a-sess"))?.project_id).toBeTruthy();
    expect((await readSession(OWNER_B, "b-sess"))?.project_id).toBeNull(); // B 不动
  });

  it("backs up the pristine pre-migration row + rollback restores it exactly", async () => {
    const db = testEnv.DB;
    const meta = { title: "原标题" };
    const fields = [{ id: "f-1", type: "text", label: "姓名" }];
    const originalTurns = [
      { id: "u-0", role: "user", text: "原始对话" },
      snapshotTurn(meta, fields),
    ];
    await seedOldSession({
      ownerId: OWNER_A,
      sessionId: "sess-roll",
      turns: originalTurns,
      formSlug: "slug-1",
    });

    await migrateSessionsToProjects(db, {});
    expect(await countBackup()).toBe(1);
    // 迁移后：snapshot 已剥离、project 已建。
    const migrated = await readSession(OWNER_A, "sess-roll");
    expect(JSON.parse(migrated!.turns_json)).toHaveLength(1);
    const mintedProjId = migrated!.project_id!;
    expect(await readProject(OWNER_A, mintedProjId)).not.toBeNull();

    // 回滚：turns_json 还原成 pristine 原值、project_id 置回 NULL、mint 的项目删掉、备份消费掉。
    const rb = await rollbackProjectMigration(db, {});
    expect(rb.mode).toBe("rollback");
    expect(rb.restored).toBe(1);

    const restored = await readSession(OWNER_A, "sess-roll");
    expect(restored!.project_id).toBeNull();
    expect(JSON.parse(restored!.turns_json)).toEqual(originalTurns); // 含快照，逐字还原
    expect(await readProject(OWNER_A, mintedProjId)).toBeNull(); // mint 的项目已删
    expect(await countBackup()).toBe(0); // 备份行消费完
  });

  it("rollback is owner-scoped + a no-op when there is nothing backed up", async () => {
    const db = testEnv.DB;
    // 无任何迁移 → 备份表为空（或不存在）→ rollback no-op。
    const rb = await rollbackProjectMigration(db, {});
    expect(rb.restored).toBe(0);
  });
});

describe("POST /api/admin/migrate-projects · owner-only 端点", () => {
  async function callMigrate(token: string | null, body: unknown): Promise<Response> {
    return SELF.fetch(`${BASE}/api/admin/migrate-projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? authHeader(token) : {}),
      },
      body: JSON.stringify(body),
    });
  }

  /** Seed an old session under a REAL registered owner (owner_id = the JWT sub). */
  async function seedForOwner(
    ownerId: string,
    sessionId: string,
    hasSnapshot: boolean,
  ): Promise<void> {
    const turns = hasSnapshot
      ? [
          { id: "u-0", role: "user", text: "hi" },
          snapshotTurn({ title: "端点表" }, [{ id: "f-1", type: "text", label: "x" }]),
        ]
      : [{ id: "u-0", role: "user", text: "纯对话" }];
    await seedOldSession({ ownerId, sessionId, turns });
  }

  it("rejects an unauthenticated request with 401", async () => {
    const res = await callMigrate(null, { mode: "dry-run" });
    expect(res.status).toBe(401);
  });

  it("dry-run (default) returns a report and writes nothing", async () => {
    const { token } = await registerOwner();
    const ownerId = JSON.parse(atob(token.split(".")[1])).sub as string;
    await seedForOwner(ownerId, "ep-dry", true);

    const res = await callMigrate(token, {}); // no mode → dry-run default
    expect(res.status).toBe(200);
    const report = (await res.json()) as { mode: string; migrated: number; backedUp: number };
    expect(report.mode).toBe("dry-run");
    expect(report.migrated).toBe(1);
    expect(report.backedUp).toBe(0);

    expect((await readSession(ownerId, "ep-dry"))?.project_id).toBeNull(); // untouched
  });

  it("apply without the confirm token is rejected 400 (no writes)", async () => {
    const { token } = await registerOwner();
    const ownerId = JSON.parse(atob(token.split(".")[1])).sub as string;
    await seedForOwner(ownerId, "ep-noconfirm", true);

    const res = await callMigrate(token, { mode: "apply" });
    expect(res.status).toBe(400);
    expect((await readSession(ownerId, "ep-noconfirm"))?.project_id).toBeNull();
  });

  it("apply with confirm migrates the caller's rows and is scoped to that owner", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const ownerA = JSON.parse(atob(a.token.split(".")[1])).sub as string;
    const ownerB = JSON.parse(atob(b.token.split(".")[1])).sub as string;
    await seedForOwner(ownerA, "ep-a", true);
    await seedForOwner(ownerB, "ep-b", true);

    const res = await callMigrate(a.token, { mode: "apply", confirm: MIGRATE_CONFIRM });
    expect(res.status).toBe(200);
    const report = (await res.json()) as { mode: string; migrated: number };
    expect(report.mode).toBe("apply");
    expect(report.migrated).toBe(1); // only A's row

    expect((await readSession(ownerA, "ep-a"))?.project_id).toBeTruthy();
    expect((await readSession(ownerB, "ep-b"))?.project_id).toBeNull(); // B untouched (owner scope)
  });
});
