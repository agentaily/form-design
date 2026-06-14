// Unit specs for src/core/submissionsClient.ts — the owner-side seam for the 数据
// 后台 (第 6 步). Backend contract: GET /api/forms/:slug/submissions (owner-only,
// SPEC §18; auth §17).
//
// CONTRACT — OWNER-ONLY, CARRIES BEARER. This is the OPPOSITE of publicClient: it
// goes through apiFetch with `auth:true`, so the owner's session token is attached as
// `Authorization: Bearer <token>`. We prove that by setting an owner token and
// asserting the outgoing request carries it. A missing/expired session surfaces as a
// 401 ApiError for SubmissionsContent to route into login (onNeedLogin, §17.4).
//
// We mock the lowest seam (global `fetch`) so these also pin path / method / the
// { submissions, count } shape pass-through and the typed ApiError surface. The
// component-level behavior (list rows, count, empty state, 401 → onNeedLogin) is
// pinned in tests/integration/data-dashboard.spec.jsx.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { listSubmissions } from "../../src/core/submissionsClient";
import { setToken, clearToken, ApiError } from "../../src/core/apiClient";

function jsonResponse(body, init = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

// A §18.2 submissions payload, **D1 主存投影**：每条提交是 { id, answers, createdAt, feishu }
// （不再是旧飞书的 { recordId, fields, createdTime }）。answers 的 value 可为 string 或 string[]。
const RESULT = {
  submissions: [
    {
      id: "sub-AAA",
      answers: [
        { label: "姓名", value: "张三" },
        { label: "兴趣", value: ["阅读", "运动"] },
      ],
      createdAt: "2026-06-10T08:00:00.000Z",
      feishu: { recordId: "recAAA", syncedAt: "2026-06-10T08:00:05.000Z", error: null },
    },
    {
      id: "sub-BBB",
      answers: [{ label: "姓名", value: "李四" }],
      createdAt: "2026-06-09T08:00:00.000Z",
      feishu: { recordId: null, syncedAt: null, error: null },
    },
  ],
  count: 2,
};

beforeEach(() => {
  clearToken();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearToken();
});

describe("submissionsClient · listSubmissions", () => {
  it("GETs /api/forms/:slug/submissions as the owner (Bearer) and resolves { submissions, count }", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse(RESULT));
    vi.stubGlobal("fetch", fetchMock);

    const out = await listSubmissions("f8Kq2pXa");

    expect(out).toEqual(RESULT);
    const [url, init] = fetchMock.mock.calls[0];
    // The owner data-read path is /api/forms/:slug/submissions (§18.1).
    expect(url).toContain("/api/forms/f8Kq2pXa/submissions");
    expect((init.method ?? "GET").toUpperCase()).toBe("GET");
    // OWNER-ONLY: the Bearer token is attached (the opposite of publicClient).
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
    // GET carries no body.
    expect(init.body).toBeUndefined();
  });

  it("resolves the empty state { submissions: [], count: 0 } without erroring", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ submissions: [], count: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listSubmissions("f8Kq2pXa")).resolves.toEqual({ submissions: [], count: 0 });
  });

  it("rejects with a 401 ApiError (session expired → route into login, §17/§18.5)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listSubmissions("f8Kq2pXa")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });

  it("rejects with a 404 ApiError for an unknown slug / 非本人表单 (§18.5)", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ error: "form not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listSubmissions("gone")).rejects.toMatchObject({ name: "ApiError", status: 404 });
  });

  // D1 主存版本：读端不打飞书，故后端**不再**在此返回 409 未配飞书 / 502 上游错误。本读端只
  // 区分 401（未登录）/ 404（不存在或非本人）；任何意外的非 2xx 仍统一收敛成 ApiError（见下）。
});

// Sanity: ApiError is the surface these calls reject with (keeps the import meaningful).
describe("submissionsClient · error surface", () => {
  it("non-2xx rejections are ApiError instances", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listSubmissions("x")).rejects.toBeInstanceOf(ApiError);
  });
});
