import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applySchema, resetProjects, resetChatSessions, testEnv } from "./helpers";
import { upsertChatSession, loadChatSession } from "../src/chatSessions";
import { upsertProject, deleteProject } from "../src/projects";

// Data-layer acceptance for 删项目级联删其下会话 (§26.10, A' 项目↔对话, PR-A) — realizes the
// 「删除项目级联删除其下的全部会话」 scenario in features/project-workspace.feature.
//
// WHY here and not the api altitude: the PR-A `PUT /api/chat/session/:id` route does NOT write
// project_id (the route calls upsertChatSession without the 5th arg → sessions land with
// project_id = NULL). So an api test cannot naturally produce a session *attached to a project*.
// The cascade logic lives in `deleteProject` (DELETE chat_sessions WHERE owner_id=? AND
// project_id=?, then DELETE the project row). We exercise it at the data layer by writing
// project-scoped sessions via `upsertChatSession(db, owner, sess, input, projectId)` and asserting
// `deleteProject` removes them — while leaving another owner / another project untouched (§26.8).
//
// Uses synthetic owner ids: the projects / chat_sessions schema has no FK to users, so a string
// owner_id is enough. Distinctive ids (-OWNER-A / -OWNER-B / proj-P / proj-Q) make any leak
// across the isolation boundary unmistakable.
//
// Contract: SPEC.md §26.10 + workers/src/projects.ts (deleteProject) /
// workers/src/chatSessions.ts (upsertChatSession / loadChatSession project_id seam).

const OWNER_A = "owner-id-OWNER-A";
const OWNER_B = "owner-id-OWNER-B";
const PROJECT_P = "proj-P-1111";
const PROJECT_Q = "proj-Q-2222";

const turns = [{ id: "u-0", role: "user", text: "占位会话内容" }];

beforeAll(async () => {
  await applySchema();
});
beforeEach(async () => {
  await resetProjects();
  await resetChatSessions();
});

describe("deleteProject cascade · 删项目级联删其下会话 (§26.10)", () => {
  it("deleting project P removes every session attached to P", async () => {
    const db = testEnv.DB;
    // Project P holds two sessions (both project-scoped to P).
    await upsertProject(db, OWNER_A, PROJECT_P, { meta: { title: "项目 P" }, fields: [] });
    await upsertChatSession(db, OWNER_A, "p-sess-1", { turns, history: [] }, PROJECT_P);
    await upsertChatSession(db, OWNER_A, "p-sess-2", { turns, history: [] }, PROJECT_P);

    // Both are present before the delete (read scoped to P).
    expect(await loadChatSession(db, OWNER_A, "p-sess-1", PROJECT_P)).not.toBeNull();
    expect(await loadChatSession(db, OWNER_A, "p-sess-2", PROJECT_P)).not.toBeNull();

    // Delete the project → returns true (the project row existed).
    expect(await deleteProject(db, OWNER_A, PROJECT_P)).toBe(true);

    // Both sessions are gone (cascade) — and gone unconditionally, not just under the P scope.
    expect(await loadChatSession(db, OWNER_A, "p-sess-1", PROJECT_P)).toBeNull();
    expect(await loadChatSession(db, OWNER_A, "p-sess-2", PROJECT_P)).toBeNull();
    expect(await loadChatSession(db, OWNER_A, "p-sess-1")).toBeNull();
    expect(await loadChatSession(db, OWNER_A, "p-sess-2")).toBeNull();
  });

  it("the cascade is scoped: sessions under another project of the SAME owner survive", async () => {
    const db = testEnv.DB;
    await upsertProject(db, OWNER_A, PROJECT_P, { meta: { title: "项目 P" }, fields: [] });
    await upsertProject(db, OWNER_A, PROJECT_Q, { meta: { title: "项目 Q" }, fields: [] });
    await upsertChatSession(db, OWNER_A, "p-sess", { turns, history: [] }, PROJECT_P);
    await upsertChatSession(db, OWNER_A, "q-sess", { turns, history: [] }, PROJECT_Q);

    expect(await deleteProject(db, OWNER_A, PROJECT_P)).toBe(true);

    // P's session is gone, Q's session is untouched (cascade only deletes WHERE project_id=P).
    expect(await loadChatSession(db, OWNER_A, "p-sess", PROJECT_P)).toBeNull();
    expect(await loadChatSession(db, OWNER_A, "q-sess", PROJECT_Q)).not.toBeNull();
  });

  it("the cascade is owner-scoped: another owner's same-named project + sessions are untouched", async () => {
    const db = testEnv.DB;
    // Both owners have a project with the SAME project_id P, each with its own session.
    await upsertProject(db, OWNER_A, PROJECT_P, { meta: { title: "A 的项目 P" }, fields: [] });
    await upsertProject(db, OWNER_B, PROJECT_P, { meta: { title: "B 的项目 P" }, fields: [] });
    await upsertChatSession(db, OWNER_A, "a-sess", { turns, history: [] }, PROJECT_P);
    await upsertChatSession(db, OWNER_B, "b-sess", { turns, history: [] }, PROJECT_P);

    // A deletes A's project P → only A's session cascades; B's project + session survive (§26.8).
    expect(await deleteProject(db, OWNER_A, PROJECT_P)).toBe(true);

    expect(await loadChatSession(db, OWNER_A, "a-sess", PROJECT_P)).toBeNull();
    expect(await loadChatSession(db, OWNER_B, "b-sess", PROJECT_P)).not.toBeNull();
  });

  it("deleting a project with no sessions still succeeds (cascade deletes 0 sessions)", async () => {
    const db = testEnv.DB;
    await upsertProject(db, OWNER_A, PROJECT_P, { meta: { title: "空项目" }, fields: [] });

    // No sessions under P; the project row exists → deleteProject returns true regardless.
    expect(await deleteProject(db, OWNER_A, PROJECT_P)).toBe(true);
  });

  it("deleting a never-existed project returns false (no project row, nothing cascaded)", async () => {
    const db = testEnv.DB;
    expect(await deleteProject(db, OWNER_A, "never-existed-project")).toBe(false);
  });
});
