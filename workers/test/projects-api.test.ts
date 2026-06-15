import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applySchema,
  resetProjects,
  resetChatSessions,
  resetUsers,
  registerOwner,
  authHeader,
} from "./helpers";

// Outer-loop acceptance specs for 项目级共享工作区 + 会话归属 / rename (owner-only, §26.10,
// A' 「项目 ↔ 对话」重构 PR-A), driven through the real Hono app in workerd via SELF.fetch
// against a local miniflare D1. Realizes the backend slice of
// features/project-workspace.feature:
//   * owner-only 鉴权门: 缺/坏 token → 401 on GET list / GET project / PUT / DELETE / PATCH rename.
//   * 项目工作区 PUT → GET round-trip: meta + fields + formSlug 原样回; 整段替换 last-write-wins;
//     缺 formSlug 不清空已关联 slug.
//   * GET 未命中 / 跨 owner → 200 { project: null }（非 404，不暴露存在性）.
//   * GET /api/projects 列表: updatedAt DESC、title 推导（meta.title / 「未命名表单」回退）、
//     fieldCount、零项目空数组、只含本 owner（跨 owner 隔离）.
//   * PUT body 校验: 非 JSON / fields 非数组 / meta 非对象非 null → 400.
//   * DELETE 项目 → 200 { deleted:true } + 再 GET → { project:null }; 不存在/跨 owner → 404.
//   * 会话 rename (PATCH): 改 title → 列表显示新标题（显式标题优先于推导）; 不存在/跨 owner → 404;
//     title 非 string / 空 / whitespace → 400; rename 不刷 updated_at（列表顺序不变）.
//
// 会话级联删（删项目级联删其下会话）的数据语义在 api 海拔造不出（PR-A 的 PUT 会话路由不写
// project_id），故在数据层验证 — 见 describe "deleteProject cascade …" 块尾.
//
// Contract: SPEC.md §26.10 + §17.1 (鉴权矩阵) + workers/src/projects.ts /
// workers/src/chatSessions.ts.

const BASE = "https://api.local";

const PROJECT_ID = "proj-aaaa-1111-2222-3333-444455556666";

// Distinctive strings (-OWNER-A / -OWNER-B) so any cross-owner leak is unmistakable.
const META = { title: "活动报名表-OWNER-A", description: "一段描述" };
const FIELDS = [
  { id: "f-1", type: "text", label: "姓名" },
  { id: "f-2", type: "email", label: "邮箱" },
  { id: "f-3", type: "tel", label: "电话" },
];

function projectPath(projectId: string): string {
  return `${BASE}/api/projects/${encodeURIComponent(projectId)}`;
}

async function putProject(
  token: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return SELF.fetch(projectPath(projectId), {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
}

async function getProject(token: string, projectId: string): Promise<Response> {
  return SELF.fetch(projectPath(projectId), { headers: authHeader(token) });
}

async function listProjects(token: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/projects`, { headers: authHeader(token) });
}

async function deleteProject(token: string, projectId: string): Promise<Response> {
  return SELF.fetch(projectPath(projectId), { method: "DELETE", headers: authHeader(token) });
}

// --- chat-session helpers (rename needs a real persisted session) -----------

function sessionPath(sessionId: string): string {
  return `${BASE}/api/chat/session/${encodeURIComponent(sessionId)}`;
}

async function putSession(
  token: string,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return SELF.fetch(sessionPath(sessionId), {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
}

async function patchSession(
  token: string,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return SELF.fetch(sessionPath(sessionId), {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
}

async function listSessions(token: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/chat/sessions`, { headers: authHeader(token) });
}

/** A turns transcript whose first user message is `firstUserText`. */
function turnsWith(firstUserText: string): Array<Record<string, unknown>> {
  return [
    { id: "a-0", role: "assistant", kind: "text", text: "你好" },
    { id: "u-0", role: "user", text: firstUserText },
  ];
}

interface ProjectSummary {
  projectId: string;
  title: string;
  fieldCount: number;
  formSlug: string | null;
  updatedAt: string;
}

interface ProjectRecord {
  projectId: string;
  meta: unknown | null;
  fields: unknown[];
  formSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionSummary {
  sessionId: string;
  title: string;
  turnCount: number;
  formSlug: string | null;
  updatedAt: string;
}

beforeAll(async () => {
  await applySchema();
});
beforeEach(async () => {
  await resetProjects();
  await resetChatSessions();
  await resetUsers();
});

// ---------------------------------------------------------------------------
// owner-only 鉴权门（§26.1 / §17.1）：无/坏 token → 401，不泄露任何项目数据
// ---------------------------------------------------------------------------

describe("projects API · owner-only auth gate (§26.10 / §17.1)", () => {
  it("GET /api/projects without a token → 401 (no list leaks to anonymous)", async () => {
    const res = await SELF.fetch(`${BASE}/api/projects`);
    expect(res.status).toBe(401);
  });

  it("GET /api/projects/:id without a token → 401 (no project leaks)", async () => {
    const res = await SELF.fetch(projectPath(PROJECT_ID));
    expect(res.status).toBe(401);
  });

  it("PUT /api/projects/:id without a token → 401 (anonymous cannot persist)", async () => {
    const res = await SELF.fetch(projectPath(PROJECT_ID), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meta: META, fields: FIELDS }),
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/projects/:id without a token → 401", async () => {
    const res = await SELF.fetch(projectPath(PROJECT_ID), { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("PATCH /api/chat/session/:id (rename) without a token → 401", async () => {
    const res = await SELF.fetch(sessionPath("any-session"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "新标题" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/projects with a bad/garbage token → 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/projects`, {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 项目工作区 PUT → GET round-trip（§26.10）
// ---------------------------------------------------------------------------

describe("projects API · PUT → GET round-trip (§26.10)", () => {
  it("persists meta + fields + formSlug and reads them back verbatim, field order preserved", async () => {
    const { token } = await registerOwner();

    const put = await putProject(token, PROJECT_ID, {
      meta: META,
      fields: FIELDS,
      formSlug: "f8Kq2pXa",
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { projectId: string; updatedAt: string };
    expect(putBody.projectId).toBe(PROJECT_ID);
    expect(typeof putBody.updatedAt).toBe("string");

    const get = await getProject(token, PROJECT_ID);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { project: ProjectRecord };
    expect(body.project).not.toBeNull();
    expect(body.project.projectId).toBe(PROJECT_ID);
    expect(body.project.meta).toEqual(META);
    // 字段顺序与内容原样保留。
    expect(body.project.fields).toEqual(FIELDS);
    expect(body.project.formSlug).toBe("f8Kq2pXa");
    expect(typeof body.project.createdAt).toBe("string");
    expect(typeof body.project.updatedAt).toBe("string");
    // 凭据不出网 (§26.8): no owner_id surfaces.
    expect(JSON.stringify(body)).not.toContain("owner_id");
  });

  it("an empty project (meta null) reads back meta:null, fields:[], formSlug:null", async () => {
    const { token } = await registerOwner();
    const put = await putProject(token, PROJECT_ID, { meta: null, fields: [] });
    expect(put.status).toBe(200);

    const body = (await (await getProject(token, PROJECT_ID)).json()) as { project: ProjectRecord };
    expect(body.project.meta).toBeNull();
    expect(body.project.fields).toEqual([]);
    expect(body.project.formSlug).toBeNull();
  });
});

describe("projects API · empty state (§26.10)", () => {
  it("GET a never-saved project id → 200 { project: null } (not a 404)", async () => {
    const { token } = await registerOwner();
    const res = await getProject(token, "never-saved-project-id");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ project: null });
  });
});

// ---------------------------------------------------------------------------
// upsert last-write-wins + formSlug 缺省不清空（§26.10，镜像 §26.3）
// ---------------------------------------------------------------------------

describe("projects API · upsert last-write-wins (§26.10)", () => {
  it("a second PUT replaces the whole workspace for the same (owner, project)", async () => {
    const { token } = await registerOwner();
    await putProject(token, PROJECT_ID, { meta: META, fields: FIELDS });

    const NEW_META = { title: "全新表单-OWNER-A" };
    const NEW_FIELDS = [{ id: "g-1", type: "textarea", label: "留言" }];
    await putProject(token, PROJECT_ID, { meta: NEW_META, fields: NEW_FIELDS });

    const body = (await (await getProject(token, PROJECT_ID)).json()) as { project: ProjectRecord };
    expect(body.project.meta).toEqual(NEW_META);
    // 整段替换：不会与旧版本字段混在一起。
    expect(body.project.fields).toEqual(NEW_FIELDS);
    expect(JSON.stringify(body.project.fields)).not.toContain("姓名");
  });

  it("a PUT omitting formSlug does NOT clear an already-associated slug (§26.10)", async () => {
    const { token } = await registerOwner();
    // First PUT associates a slug.
    await putProject(token, PROJECT_ID, { meta: META, fields: FIELDS, formSlug: "f8Kq2pXa" });
    // A later ordinary save omits formSlug — the association must survive.
    await putProject(token, PROJECT_ID, { meta: META, fields: FIELDS });

    const body = (await (await getProject(token, PROJECT_ID)).json()) as {
      project: { formSlug: unknown };
    };
    expect(body.project.formSlug).toBe("f8Kq2pXa");
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects 列表：updatedAt DESC、title 推导、fieldCount、空态、跨 owner 隔离
// ---------------------------------------------------------------------------

describe("projects API · list owner's projects (§26.10)", () => {
  it("returns all projects, newest-updated first, with derived title + fieldCount", async () => {
    const { token } = await registerOwner();
    // Space writes a few ms apart so updated_at strictly increases and the expected DESC
    // order (reverse of insertion) is deterministic — independent of the project_id tiebreak.
    const tick = () => new Promise((r) => setTimeout(r, 5));
    await putProject(token, "proj-old", { meta: { title: "最早的项目" }, fields: [{ id: "x" }] });
    await tick();
    await putProject(token, "proj-mid", {
      meta: { title: "中间的项目" },
      fields: [{ id: "x" }, { id: "y" }],
    });
    await tick();
    await putProject(token, "proj-new", {
      meta: { title: "活动报名表" },
      fields: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });

    const res = await listProjects(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: ProjectSummary[] };
    expect(body.projects).toHaveLength(3);

    // ORDER BY updated_at DESC — newest write first.
    expect(body.projects.map((p) => p.projectId)).toEqual(["proj-new", "proj-mid", "proj-old"]);

    const byId = Object.fromEntries(body.projects.map((p) => [p.projectId, p]));
    // title 取 meta.title；fieldCount = fields 长度（§26.10）。
    expect(byId["proj-new"]).toMatchObject({ title: "活动报名表", fieldCount: 3 });
    expect(byId["proj-mid"]).toMatchObject({ title: "中间的项目", fieldCount: 2 });
    expect(byId["proj-old"]).toMatchObject({ title: "最早的项目", fieldCount: 1 });

    // 凭据不出网 (§26.8)：列表里不暴露 owner_id；也不带工作区全量字段（省带宽）。
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("owner_id");
    expect(raw).not.toContain("fields_json");
  });

  it("a project with no meta.title falls back to 「未命名表单」 in the list", async () => {
    const { token } = await registerOwner();
    await putProject(token, "proj-untitled", { meta: { description: "无标题" }, fields: [] });

    const body = (await (await listProjects(token)).json()) as { projects: ProjectSummary[] };
    const item = body.projects.find((p) => p.projectId === "proj-untitled");
    expect(item?.title).toBe("未命名表单");
  });

  it("a project with null meta also falls back to 「未命名表单」", async () => {
    const { token } = await registerOwner();
    await putProject(token, "proj-nometa", { meta: null, fields: [] });

    const body = (await (await listProjects(token)).json()) as { projects: ProjectSummary[] };
    const item = body.projects.find((p) => p.projectId === "proj-nometa");
    expect(item?.title).toBe("未命名表单");
    expect(item?.fieldCount).toBe(0);
  });

  it("projects formSlug per item (null before publish, the slug after)", async () => {
    const { token } = await registerOwner();
    await putProject(token, "proj-draft", { meta: { title: "草稿" }, fields: [] });
    await putProject(token, "proj-pub", {
      meta: { title: "已发布" },
      fields: [],
      formSlug: "f8Kq2pXa",
    });

    const body = (await (await listProjects(token)).json()) as { projects: ProjectSummary[] };
    const byId = Object.fromEntries(body.projects.map((p) => [p.projectId, p]));
    expect(byId["proj-draft"].formSlug).toBeNull();
    expect(byId["proj-pub"].formSlug).toBe("f8Kq2pXa");
  });

  it("returns { projects: [] } when the owner has no projects (empty state, not an error)", async () => {
    const { token } = await registerOwner();
    const res = await listProjects(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [] });
  });
});

describe("projects API · cross-owner isolation (§26.8)", () => {
  it("each owner's list contains only their own projects", async () => {
    const ownerA = await registerOwner();
    const ownerB = await registerOwner();

    await putProject(ownerA.token, "a-1", { meta: { title: "A 的项目一-OWNER-A" }, fields: [] });
    await putProject(ownerA.token, "a-2", { meta: { title: "A 的项目二-OWNER-A" }, fields: [] });
    await putProject(ownerB.token, "b-1", { meta: { title: "B 的项目-OWNER-B" }, fields: [] });

    const listA = (await (await listProjects(ownerA.token)).json()) as {
      projects: ProjectSummary[];
    };
    const listB = (await (await listProjects(ownerB.token)).json()) as {
      projects: ProjectSummary[];
    };

    expect(listA.projects.map((p) => p.projectId).sort()).toEqual(["a-1", "a-2"]);
    // A 的列表绝不含 B 的任何项目（§26.8）。
    expect(JSON.stringify(listA.projects)).not.toContain("OWNER-B");
    expect(listA.projects.map((p) => p.projectId)).not.toContain("b-1");

    expect(listB.projects.map((p) => p.projectId)).toEqual(["b-1"]);
    expect(JSON.stringify(listB.projects)).not.toContain("OWNER-A");
  });

  it("owner A cannot read owner B's project at the same project id → { project: null }", async () => {
    const ownerA = await registerOwner();
    const ownerB = await registerOwner();

    // B saves a project under PROJECT_ID.
    const put = await putProject(ownerB.token, PROJECT_ID, {
      meta: { title: "B 的项目-OWNER-B" },
      fields: FIELDS,
    });
    expect(put.status).toBe(200);

    // A, logged in with their own account, reads the SAME project id → sees nothing
    // (keyed (owner_id, project_id); A's owner_id doesn't match B's row). Not a 404 —
    // does not reveal that the project belongs to B.
    const getA = await getProject(ownerA.token, PROJECT_ID);
    expect(getA.status).toBe(200);
    expect(await getA.json()).toEqual({ project: null });

    // Sanity: B still reads their own.
    const getB = (await (await getProject(ownerB.token, PROJECT_ID)).json()) as {
      project: ProjectRecord | null;
    };
    expect(getB.project).not.toBeNull();
    expect(getB.project!.meta).toEqual({ title: "B 的项目-OWNER-B" });
  });
});

// ---------------------------------------------------------------------------
// PUT body 校验（§26.10）：非 JSON / fields 非数组 / meta 非对象非 null → 400，不落库
// ---------------------------------------------------------------------------

describe("projects API · bad request (§26.10)", () => {
  it("PUT with a non-JSON body → 400, nothing persisted", async () => {
    const { token } = await registerOwner();
    const res = await SELF.fetch(projectPath(PROJECT_ID), {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeader(token) },
      body: "not json{{{",
    });
    expect(res.status).toBe(400);
    // Nothing was written → GET is still empty.
    expect(await (await getProject(token, PROJECT_ID)).json()).toEqual({ project: null });
  });

  it("PUT with fields not an array → 400 「fields 必须是数组」, nothing persisted", async () => {
    const { token } = await registerOwner();
    const res = await putProject(token, PROJECT_ID, { meta: META, fields: "nope" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "fields 必须是数组" });
    expect(await (await getProject(token, PROJECT_ID)).json()).toEqual({ project: null });
  });

  it("PUT with meta a non-object, non-null value → 400 「meta 必须是对象或 null」", async () => {
    const { token } = await registerOwner();
    // meta as an array — arrays are not valid FormMeta.
    const resArr = await putProject(token, PROJECT_ID, { meta: [1, 2, 3], fields: [] });
    expect(resArr.status).toBe(400);
    expect((await resArr.json()) as { error: string }).toMatchObject({
      error: "meta 必须是对象或 null",
    });
    // meta as a scalar.
    const resStr = await putProject(token, PROJECT_ID, { meta: "just a string", fields: [] });
    expect(resStr.status).toBe(400);

    // Neither attempt persisted anything.
    expect(await (await getProject(token, PROJECT_ID)).json()).toEqual({ project: null });
  });
});

// ---------------------------------------------------------------------------
// DELETE 项目（§26.10）：删到 200 { deleted:true } + 再 GET → null；不存在/跨 owner → 404
// ---------------------------------------------------------------------------

describe("projects API · delete a project (§26.10)", () => {
  it("owner deletes their own project → 200 { deleted: true }, gone from GET + list", async () => {
    const { token } = await registerOwner();
    await putProject(token, "keep-me", { meta: { title: "保留这个" }, fields: [] });
    await putProject(token, PROJECT_ID, { meta: META, fields: FIELDS });

    const del = await deleteProject(token, PROJECT_ID);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });

    // Single GET of the deleted project → empty state (not a 404, same as never-saved).
    const get = await getProject(token, PROJECT_ID);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ project: null });

    // List no longer contains it, but the untouched project survives.
    const body = (await (await listProjects(token)).json()) as { projects: ProjectSummary[] };
    expect(body.projects.map((p) => p.projectId)).toEqual(["keep-me"]);
  });

  it("DELETE another owner's project → 404 「项目不存在」 and the victim's project is untouched", async () => {
    const ownerA = await registerOwner();
    const ownerB = await registerOwner();

    await putProject(ownerB.token, PROJECT_ID, {
      meta: { title: "B 的项目-OWNER-B" },
      fields: FIELDS,
    });

    // A tries to delete B's project id — A has no such row → 404, B's project must survive.
    const del = await deleteProject(ownerA.token, PROJECT_ID);
    expect(del.status).toBe(404);
    expect((await del.json()) as { error: string }).toMatchObject({ error: "项目不存在" });

    // B's project is untouched — still readable + listed by B.
    const getB = (await (await getProject(ownerB.token, PROJECT_ID)).json()) as {
      project: ProjectRecord | null;
    };
    expect(getB.project).not.toBeNull();
    const listB = (await (await listProjects(ownerB.token)).json()) as {
      projects: ProjectSummary[];
    };
    expect(listB.projects.map((p) => p.projectId)).toEqual([PROJECT_ID]);
  });

  it("DELETE a never-existed project id → 404 「项目不存在」", async () => {
    const { token } = await registerOwner();
    const del = await deleteProject(token, "never-existed-project-id");
    expect(del.status).toBe(404);
    expect((await del.json()) as { error: string }).toMatchObject({ error: "项目不存在" });
  });
});

// ---------------------------------------------------------------------------
// 会话 rename（§26.10 PATCH /api/chat/session/:sessionId）：改 title，列表显示新标题
// ---------------------------------------------------------------------------

describe("chat-session rename API · PATCH title (§26.10)", () => {
  it("renames a session → 200 { renamed: true } and the list shows the new title", async () => {
    const { token } = await registerOwner();
    await putSession(token, "sess-rename", { turns: turnsWith("帮我做一个报名表"), history: [] });

    const patch = await patchSession(token, "sess-rename", { title: "活动报名表 v2" });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ renamed: true });

    const body = (await (await listSessions(token)).json()) as { sessions: SessionSummary[] };
    const item = body.sessions.find((s) => s.sessionId === "sess-rename");
    expect(item?.title).toBe("活动报名表 v2");
  });

  it("an explicit title takes precedence over the derived first-user-message title", async () => {
    const { token } = await registerOwner();
    // First user message would derive to 「帮我做一个报名表」.
    await putSession(token, "sess-explicit", {
      turns: turnsWith("帮我做一个报名表"),
      history: [],
    });
    await patchSession(token, "sess-explicit", { title: "我的活动表" });

    const body = (await (await listSessions(token)).json()) as { sessions: SessionSummary[] };
    const item = body.sessions.find((s) => s.sessionId === "sess-explicit");
    expect(item?.title).toBe("我的活动表");
    expect(item?.title).not.toBe("帮我做一个报名表");
  });

  it("an un-renamed session keeps the derived title (no explicit title set)", async () => {
    const { token } = await registerOwner();
    await putSession(token, "sess-derived", { turns: turnsWith("帮我做一个报名表"), history: [] });

    const body = (await (await listSessions(token)).json()) as { sessions: SessionSummary[] };
    const item = body.sessions.find((s) => s.sessionId === "sess-derived");
    expect(item?.title).toBe("帮我做一个报名表");
  });

  it("DOES NOT reorder the list (updated_at is not refreshed by a rename)", async () => {
    const { token } = await registerOwner();
    const tick = () => new Promise((r) => setTimeout(r, 5));
    // older → newer; rename the OLDER one and confirm it stays last (not bumped to front).
    await putSession(token, "sess-older", { turns: turnsWith("较早的会话"), history: [] });
    await tick();
    await putSession(token, "sess-newer", { turns: turnsWith("较新的会话"), history: [] });

    // Sanity: newer-first before rename.
    const before = (await (await listSessions(token)).json()) as { sessions: SessionSummary[] };
    expect(before.sessions.map((s) => s.sessionId)).toEqual(["sess-newer", "sess-older"]);

    const patch = await patchSession(token, "sess-older", { title: "重命名后的较早会话" });
    expect(patch.status).toBe(200);

    // Order unchanged — rename did not bump 「sess-older」 to the front (updated_at untouched).
    const after = (await (await listSessions(token)).json()) as { sessions: SessionSummary[] };
    expect(after.sessions.map((s) => s.sessionId)).toEqual(["sess-newer", "sess-older"]);
    const renamed = after.sessions.find((s) => s.sessionId === "sess-older");
    expect(renamed?.title).toBe("重命名后的较早会话");
  });

  it("rename another owner's session → 404 「会话不存在」 and the victim's title is unaffected", async () => {
    const ownerA = await registerOwner();
    const ownerB = await registerOwner();

    await putSession(ownerB.token, "sess-victim", {
      turns: turnsWith("B 的会话-OWNER-B"),
      history: [],
    });

    const patch = await patchSession(ownerA.token, "sess-victim", { title: "A 试图改 B 的标题" });
    expect(patch.status).toBe(404);
    expect((await patch.json()) as { error: string }).toMatchObject({ error: "会话不存在" });

    // B's session keeps its derived title — A's attempted rename never landed.
    const listB = (await (await listSessions(ownerB.token)).json()) as {
      sessions: SessionSummary[];
    };
    const item = listB.sessions.find((s) => s.sessionId === "sess-victim");
    expect(item?.title).toBe("B 的会话-OWNER-B");
  });

  it("rename a never-existed session id → 404 「会话不存在」", async () => {
    const { token } = await registerOwner();
    const patch = await patchSession(token, "never-existed-session", { title: "无所谓" });
    expect(patch.status).toBe(404);
    expect((await patch.json()) as { error: string }).toMatchObject({ error: "会话不存在" });
  });

  it("rename with a non-string title → 400 「title 必须是字符串」, nothing changed", async () => {
    const { token } = await registerOwner();
    await putSession(token, "sess-badtitle", { turns: turnsWith("原始会话"), history: [] });

    const patch = await patchSession(token, "sess-badtitle", { title: 123 });
    expect(patch.status).toBe(400);
    expect((await patch.json()) as { error: string }).toMatchObject({
      error: "title 必须是字符串",
    });

    // Title unchanged → still the derived title.
    const body = (await (await listSessions(token)).json()) as { sessions: SessionSummary[] };
    const item = body.sessions.find((s) => s.sessionId === "sess-badtitle");
    expect(item?.title).toBe("原始会话");
  });

  it("rename with an empty / whitespace-only title → 400 「title 不能为空」", async () => {
    const { token } = await registerOwner();
    await putSession(token, "sess-empty", { turns: turnsWith("原始会话"), history: [] });

    const resEmpty = await patchSession(token, "sess-empty", { title: "" });
    expect(resEmpty.status).toBe(400);
    expect((await resEmpty.json()) as { error: string }).toMatchObject({ error: "title 不能为空" });

    const resWs = await patchSession(token, "sess-empty", { title: "   " });
    expect(resWs.status).toBe(400);
    expect((await resWs.json()) as { error: string }).toMatchObject({ error: "title 不能为空" });

    // Title still the derived one — neither bad attempt landed.
    const body = (await (await listSessions(token)).json()) as { sessions: SessionSummary[] };
    const item = body.sessions.find((s) => s.sessionId === "sess-empty");
    expect(item?.title).toBe("原始会话");
  });
});
