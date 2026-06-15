// Unit specs for src/core/projectClient.ts — the frontend seam for PROJECT-level workspace
// persistence (A' 项目↔对话, §26.10; auth §17). Realizes the unit-altitude slice of the A' refactor:
//   * a stable, localStorage-backed design PROJECT id (minted once, reused after) — mirrors the
//     session-id helper, with the in-memory fallback when storage is unavailable.
//   * loadProject / saveProjectWorkspace / listProjects / deleteProject — owner-only, carry Bearer;
//     { project } hit / { project: null } empty; PUT sends { meta, fields(, formSlug) }.
//
// CONTRACT — OWNER-ONLY, CARRIES BEARER: every call goes through apiFetch with `auth:true`. We mock
// the lowest seam (global `fetch`) to pin path / method / the request+response shape and the typed
// ApiError surface (401 → caller routes into /signin). The project-id helper is pinned against a fake
// localStorage (and its unavailable fallback).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DESIGN_PROJECT_ID_KEY,
  PROJECTS_PATH,
  getOrCreateProjectId,
  setActiveProjectId,
  newProjectId,
  loadProject,
  saveProjectWorkspace,
  listProjects,
  deleteProject,
} from "../../src/core/projectClient";
import { setToken, clearToken, ApiError } from "../../src/core/apiClient";

function jsonResponse(body, init = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

// A §26.10 project record (workspace projection): meta + fields (JSON-parsed) + slug + stamps.
const PROJECT = {
  projectId: "pj-1aaaa-uuid",
  meta: { title: "活动报名" },
  fields: [{ id: "fld_5", type: "text", label: "姓名", required: true }],
  formSlug: null,
  createdAt: "2026-06-13T08:00:00.000Z",
  updatedAt: "2026-06-13T08:05:00.000Z",
};

const SUMMARIES = [
  {
    projectId: "pj-2",
    title: "客户满意度问卷",
    fieldCount: 6,
    formSlug: null,
    updatedAt: "2026-06-13T10:00:00.000Z",
  },
  {
    projectId: "pj-1",
    title: "活动报名表单",
    fieldCount: 9,
    formSlug: "f8Kq2pXa",
    updatedAt: "2026-06-13T08:00:00.000Z",
  },
];

// This vitest/jsdom config does NOT provide a `localStorage` global; install a fake per test.
function installFakeLocalStorage() {
  const store = new Map();
  const fake = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => void store.clear(),
  };
  vi.stubGlobal("localStorage", fake);
  return fake;
}

beforeEach(() => {
  clearToken();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearToken();
});

describe("projectClient · getOrCreateProjectId", () => {
  it("mints a fresh id on first call and persists it to localStorage (§A'.1)", () => {
    const store = installFakeLocalStorage();
    expect(store.getItem(DESIGN_PROJECT_ID_KEY)).toBeNull();

    const id = getOrCreateProjectId();

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(store.getItem(DESIGN_PROJECT_ID_KEY)).toBe(id);
  });

  it("reuses the same id on the second call (stable across reloads)", () => {
    installFakeLocalStorage();
    const first = getOrCreateProjectId();
    const second = getOrCreateProjectId();
    expect(second).toBe(first);
  });

  it("returns a pre-existing localStorage id verbatim (resume the same project)", () => {
    const store = installFakeLocalStorage();
    store.setItem(DESIGN_PROJECT_ID_KEY, "preexisting-pj-123");
    expect(getOrCreateProjectId()).toBe("preexisting-pj-123");
  });

  it("falls back to an in-memory id when localStorage is unavailable (mirrors memToken)", () => {
    const throwing = {
      getItem() {
        throw new Error("storage unavailable");
      },
      setItem() {
        throw new Error("storage unavailable");
      },
      removeItem() {
        throw new Error("storage unavailable");
      },
      clear() {
        throw new Error("storage unavailable");
      },
    };
    vi.stubGlobal("localStorage", throwing);
    const a = getOrCreateProjectId();
    const b = getOrCreateProjectId();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(b).toBe(a); // the in-memory mirror coheres the page
  });
});

describe("projectClient · setActiveProjectId / newProjectId", () => {
  it("setActive persists the id AND makes getOrCreate return it (mirror in sync)", () => {
    const store = installFakeLocalStorage();
    store.setItem(DESIGN_PROJECT_ID_KEY, "old-pj");
    setActiveProjectId("switched-pj");
    expect(store.getItem(DESIGN_PROJECT_ID_KEY)).toBe("switched-pj");
    expect(getOrCreateProjectId()).toBe("switched-pj");
  });

  it("newProjectId mints distinct ids across calls and makes the latest active", () => {
    installFakeLocalStorage();
    const a = newProjectId();
    const b = newProjectId();
    expect(a).not.toBe(b);
    expect(getOrCreateProjectId()).toBe(b);
  });
});

describe("projectClient · loadProject", () => {
  it("GETs /api/projects/:projectId as the owner (Bearer) and resolves { project }", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ project: PROJECT }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await loadProject("pj-1aaaa-uuid");

    expect(out).toEqual({ project: PROJECT });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`${PROJECTS_PATH}/pj-1aaaa-uuid`);
    expect((init.method ?? "GET").toUpperCase()).toBe("GET");
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
    expect(init.body).toBeUndefined();
  });

  it("resolves the empty state { project: null } for a never-persisted id (not a 404)", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ project: null }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadProject("never-seen")).resolves.toEqual({ project: null });
  });

  it("rejects with a 401 ApiError when the session expired (caller routes into /signin)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadProject("pj-1")).rejects.toMatchObject({ name: "ApiError", status: 401 });
  });
});

describe("projectClient · saveProjectWorkspace", () => {
  it("PUTs the workspace snapshot as the owner (Bearer) and resolves { projectId, updatedAt }", async () => {
    setToken("jwt-owner");
    const result = { projectId: "pj-1aaaa-uuid", updatedAt: "2026-06-13T08:05:00.000Z" };
    const fetchMock = vi.fn(async () => jsonResponse(result));
    vi.stubGlobal("fetch", fetchMock);

    const input = { meta: PROJECT.meta, fields: PROJECT.fields };
    const out = await saveProjectWorkspace("pj-1aaaa-uuid", input);

    expect(out).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`${PROJECTS_PATH}/pj-1aaaa-uuid`);
    expect(init.method.toUpperCase()).toBe("PUT");
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(input);
  });

  it("forwards an optional formSlug to associate the published form onto the project (§4.1)", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ projectId: "pj-1aaaa-uuid", updatedAt: "2026-06-13T09:00:00.000Z" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await saveProjectWorkspace("pj-1aaaa-uuid", {
      meta: PROJECT.meta,
      fields: PROJECT.fields,
      formSlug: "f8Kq2pXa",
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).formSlug).toBe("f8Kq2pXa");
  });

  it("rejects with a 401 ApiError when the session expired (caller routes into /signin)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveProjectWorkspace("pj-1", { meta: null, fields: [] })).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });
});

describe("projectClient · listProjects", () => {
  it("GETs /api/projects as the owner (Bearer) and resolves { projects }", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ projects: SUMMARIES }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await listProjects();

    expect(out).toEqual({ projects: SUMMARIES });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(PROJECTS_PATH);
    expect(url).not.toMatch(/\/projects\/[^/]/); // the LIST path, not a per-project path
    expect((init.method ?? "GET").toUpperCase()).toBe("GET");
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
  });

  it("resolves the empty state { projects: [] } for an owner with no projects (not an error)", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ projects: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listProjects()).resolves.toEqual({ projects: [] });
  });
});

describe("projectClient · deleteProject", () => {
  it("DELETEs /api/projects/:projectId as the owner (Bearer) and resolves { deleted }", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ deleted: true }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await deleteProject("pj-1");

    expect(out).toEqual({ deleted: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`${PROJECTS_PATH}/pj-1`);
    expect(init.method.toUpperCase()).toBe("DELETE");
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
  });

  it("rejects with a 404 ApiError for a foreign / never-existing project (caller handles)", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ error: "项目不存在" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteProject("not-mine")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
    });
  });
});
