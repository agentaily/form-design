import { describe, it, expect } from "vitest";
import {
  WORKSPACE_SNAPSHOT_ID,
  splitWorkspaceSnapshot,
  planSessionMigration,
  type OldSessionRow,
} from "../src/migrateProjects";

// Inner-loop pure-function units for the A' 一次性数据迁移 (PR-B, docs/refactor-project-conversation.md
// §2.3). No D1 / no SELF — `splitWorkspaceSnapshot` (the #76 migration-time port) and
// `planSessionMigration` are framework-agnostic, so we TDD them directly. Both are defensive: a
// corrupt / empty / null turns_json must NEVER throw (one bad row must not break the whole batch).

const snapshotTurn = (meta: unknown, fields: unknown) => ({
  id: WORKSPACE_SNAPSHOT_ID,
  role: "assistant",
  kind: "workspace",
  meta,
  fields,
});

const row = (over: Partial<OldSessionRow> = {}): OldSessionRow => ({
  owner_id: "owner-1",
  session_id: "sess-1",
  turns_json: "[]",
  form_slug: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-02-02T00:00:00.000Z",
  ...over,
});

describe("splitWorkspaceSnapshot (#76 migration-time port)", () => {
  it("extracts the snapshot turn and returns the rest as real turns, order preserved", () => {
    const meta = { title: "活动报名表" };
    const fields = [{ id: "f-1", type: "text", label: "姓名" }];
    const turns = [
      { id: "u-0", role: "user", text: "帮我做报名表" },
      snapshotTurn(meta, fields),
      { id: "a-1", role: "assistant", text: "好的" },
    ];
    const { turns: real, workspace } = splitWorkspaceSnapshot(turns);
    expect(real).toEqual([
      { id: "u-0", role: "user", text: "帮我做报名表" },
      { id: "a-1", role: "assistant", text: "好的" },
    ]);
    expect(workspace).toEqual({ meta, fields });
  });

  it("returns workspace null when there is no snapshot turn (turns untouched)", () => {
    const turns = [{ id: "u-0", role: "user", text: "纯对话" }];
    const { turns: real, workspace } = splitWorkspaceSnapshot(turns);
    expect(real).toEqual(turns);
    expect(workspace).toBeNull();
  });

  it("coerces a non-array snapshot.fields to [] and a missing meta to null", () => {
    const { workspace } = splitWorkspaceSnapshot([snapshotTurn(undefined, "not-an-array")]);
    expect(workspace).toEqual({ meta: null, fields: [] });
  });

  it("tolerates null / empty without throwing", () => {
    expect(splitWorkspaceSnapshot(null)).toEqual({ turns: [], workspace: null });
    expect(splitWorkspaceSnapshot(undefined)).toEqual({ turns: [], workspace: null });
    expect(splitWorkspaceSnapshot([])).toEqual({ turns: [], workspace: null });
  });
});

describe("planSessionMigration (§2.3)", () => {
  it("extracts a snapshot's workspace into project meta/fields and strips the turn from turns_json", () => {
    const meta = { title: "活动报名表", description: "描述" };
    const fields = [
      { id: "f-1", type: "text", label: "姓名" },
      { id: "f-2", type: "email", label: "邮箱" },
    ];
    const turns = [{ id: "u-0", role: "user", text: "帮我做报名表" }, snapshotTurn(meta, fields)];
    const plan = planSessionMigration(
      row({
        turns_json: JSON.stringify(turns),
        form_slug: "abc123",
        created_at: "2026-03-03T00:00:00.000Z",
        updated_at: "2026-04-04T00:00:00.000Z",
      }),
      "proj-MINTED",
    );

    expect(plan.hadSnapshot).toBe(true);
    expect(plan.projectId).toBe("proj-MINTED");
    // 工作区抽进 project meta/fields。
    expect(JSON.parse(plan.metaJson!)).toEqual(meta);
    expect(JSON.parse(plan.fieldsJson!)).toEqual(fields);
    // form_slug 从会话上移到 project；时间戳沿用会话（§2.3）。
    expect(plan.formSlug).toBe("abc123");
    expect(plan.createdAt).toBe("2026-03-03T00:00:00.000Z");
    expect(plan.updatedAt).toBe("2026-04-04T00:00:00.000Z");
    // 快照 turn 从 turns_json 删掉（只剩真实对话）。
    expect(JSON.parse(plan.newTurnsJson!)).toEqual([
      { id: "u-0", role: "user", text: "帮我做报名表" },
    ]);
    // 报告字段。
    expect(plan.fieldCount).toBe(2);
    expect(plan.titlePreview).toBe("活动报名表");
  });

  it("a snapshot with meta=null keeps metaJson null but still serializes its fields", () => {
    const fields = [{ id: "f-1", type: "text", label: "仅字段无标题" }];
    const plan = planSessionMigration(
      row({ turns_json: JSON.stringify([snapshotTurn(null, fields)]) }),
      "proj-1",
    );
    expect(plan.hadSnapshot).toBe(true);
    expect(plan.metaJson).toBeNull();
    expect(JSON.parse(plan.fieldsJson!)).toEqual(fields);
    expect(plan.titlePreview).toBeNull();
    expect(plan.fieldCount).toBe(1);
    // 快照剥离后无真实 turn → newTurnsJson 是空数组。
    expect(JSON.parse(plan.newTurnsJson!)).toEqual([]);
  });

  it("no-snapshot row → empty workspace: meta_json AND fields_json NULL, turns_json untouched", () => {
    const turns = [
      { id: "u-0", role: "user", text: "纯 §26 老对话" },
      { id: "a-1", role: "assistant", text: "回应" },
    ];
    const plan = planSessionMigration(row({ turns_json: JSON.stringify(turns) }), "proj-empty");
    expect(plan.hadSnapshot).toBe(false);
    expect(plan.metaJson).toBeNull();
    expect(plan.fieldsJson).toBeNull(); // §2.3 空工作区留 NULL
    expect(plan.newTurnsJson).toBeNull(); // 无快照不动 turns_json（避免 churn）
    expect(plan.fieldCount).toBe(0);
    expect(plan.titlePreview).toBeNull();
  });

  it("carries form_slug = null through when the old session had none", () => {
    const plan = planSessionMigration(row({ form_slug: null }), "proj-1");
    expect(plan.formSlug).toBeNull();
  });

  it("treats a corrupt / empty / null turns_json as a no-snapshot empty workspace (never throws)", () => {
    for (const bad of ["not json{{{", "{}", "", null]) {
      const plan = planSessionMigration(row({ turns_json: bad }), "proj-x");
      expect(plan.hadSnapshot).toBe(false);
      expect(plan.metaJson).toBeNull();
      expect(plan.fieldsJson).toBeNull();
      expect(plan.newTurnsJson).toBeNull();
    }
  });
});
