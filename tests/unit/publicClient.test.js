// Unit specs for src/core/publicClient.ts — the answerer-side seam for the PUBLIC
// fill page (第 6 步). Backend contracts: GET /api/forms/:slug (公开拉取, SPEC §16.2/
// §16.4) and POST /api/submit (公开提交, SPEC §15.2/§16.5/§20).
//
// CRITICAL CONTRACT — NO BEARER. These two endpoints are public: the request comes
// from a stranger (the answerer), not the owner. publicClient MUST NOT attach an
// `Authorization` header even when an owner token happens to be in the store. We
// PROVE this by setting an owner token in the apiClient store before each call and
// asserting the outgoing request carries no `authorization` header — i.e. the public
// path is structurally token-unaware, not just "we forgot to pass auth:true".
//
// We mock the lowest seam (global `fetch`, the same level apiClient/configClient/
// formsClient unit tests mock) so these also pin path / method / body construction
// and the typed ApiError (status + backend `{ error }` message) pass-through.
// The page-level behavior (render fields, success state, 404 page, 409 closed, 400
// hint) is pinned in tests/integration/public-fill.spec.jsx.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getPublicForm, submitForm } from "../../src/core/publicClient";
import { setToken, clearToken, ApiError } from "../../src/core/apiClient";

function jsonResponse(body, init = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

// Pull the request headers out of a fetch mock call as a lowercased plain object,
// whether the impl passed a Headers instance or a plain object literal.
function headersOf(init) {
  const h = init.headers;
  if (!h) return {};
  if (typeof h.forEach === "function" && !Array.isArray(h) && !(h instanceof Object && !h.get)) {
    // a Headers-like object
    const out = {};
    h.forEach((v, k) => {
      out[String(k).toLowerCase()] = v;
    });
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = v;
  return out;
}

// The §16.2 public projection of a published form (only slug + meta + fields).
const PUBLIC_FORM = {
  slug: "f8Kq2pXa",
  meta: { title: "活动报名表", description: "请填写你的报名信息" },
  fields: [
    { id: "f_name", type: "text", label: "姓名", required: true },
    {
      id: "f_hobby",
      type: "checkbox",
      label: "兴趣",
      options: [
        { label: "阅读", value: "read" },
        { label: "运动", value: "sport" },
      ],
    },
  ],
};

beforeEach(() => {
  // A leftover owner token in the store MUST NOT leak onto a public request — set one
  // so the no-Bearer assertions are meaningful (not vacuously true on an empty store).
  clearToken();
  setToken("jwt-owner-should-not-leak");
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearToken();
});

describe("publicClient · getPublicForm", () => {
  it("GETs /api/forms/:slug and resolves the PublicForm (slug + meta + fields)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(PUBLIC_FORM));
    vi.stubGlobal("fetch", fetchMock);

    const out = await getPublicForm("f8Kq2pXa");

    expect(out).toEqual(PUBLIC_FORM);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/forms/f8Kq2pXa");
    // It's a GET, not the owner list GET path (/api/forms) and not a POST.
    expect((init.method ?? "GET").toUpperCase()).toBe("GET");
    // GET carries no body.
    expect(init.body).toBeUndefined();
  });

  it("sends NO Authorization header even when an owner token is in the store (§16.4)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(PUBLIC_FORM));
    vi.stubGlobal("fetch", fetchMock);

    await getPublicForm("f8Kq2pXa");

    const headers = headersOf(fetchMock.mock.calls[0][1]);
    // The public pull is token-unaware: no Bearer, no owner credential, ever.
    expect(headers).not.toHaveProperty("authorization");
    expect(JSON.stringify(fetchMock.mock.calls[0][1])).not.toContain("jwt-owner-should-not-leak");
  });

  it("rejects with a 404 ApiError for an unknown slug (friendly 表单不存在 page upstream)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "no such form" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPublicForm("nope")).rejects.toMatchObject({ name: "ApiError", status: 404 });
  });

  it("rejects with a 502 ApiError on an upstream error (retriable load state upstream)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "upstream" }, { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPublicForm("f8Kq2pXa")).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
    });
  });
});

describe("publicClient · submitForm", () => {
  const ANSWERS = [
    { label: "姓名", value: "张三" },
    { label: "兴趣", value: ["阅读", "运动"] },
  ];

  it("POSTs /api/submit with the body { formSlug, answers } (SPEC §15.2/§16.5)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, recordId: "recABC" }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await submitForm("f8Kq2pXa", ANSWERS);

    expect(out).toMatchObject({ ok: true, recordId: "recABC" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/submit");
    expect(init.method).toBe("POST");
    // The wire body is exactly { formSlug, answers } — formSlug is the route slug.
    const body = JSON.parse(init.body);
    expect(body).toEqual({ formSlug: "f8Kq2pXa", answers: ANSWERS });
    // multi-choice value stays an array on the wire (not flattened to a string).
    expect(Array.isArray(body.answers.find((a) => a.label === "兴趣").value)).toBe(true);
  });

  it("sends NO Authorization header even when an owner token is in the store (§16.4)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, recordId: "r1" }));
    vi.stubGlobal("fetch", fetchMock);

    await submitForm("f8Kq2pXa", ANSWERS);

    const headers = headersOf(fetchMock.mock.calls[0][1]);
    // The answerer's submit must never carry the owner's Bearer token.
    expect(headers).not.toHaveProperty("authorization");
    expect(JSON.stringify(fetchMock.mock.calls[0][1])).not.toContain("jwt-owner-should-not-leak");
  });

  it("rejects with a 400 ApiError carrying the backend message (缺必填 / 形状错误)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "姓名 必填" }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitForm("f8Kq2pXa", [])).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "姓名 必填",
    });
  });

  it("rejects with a 404 ApiError when the form no longer exists", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "no such form" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitForm("gone", ANSWERS)).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
    });
  });

  it("rejects with a 409 ApiError carrying the message (表单未开放提交 / 未配飞书, §20.2)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "表单未开放提交" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitForm("f8Kq2pXa", ANSWERS)).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      message: "表单未开放提交",
    });
  });

  it("rejects with a 502 ApiError on an upstream (飞书) error", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "upstream" }, { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitForm("f8Kq2pXa", ANSWERS)).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
    });
  });
});

// Sanity: ApiError is the surface these calls reject with (keeps the import meaningful).
describe("publicClient · error surface", () => {
  it("non-2xx rejections are ApiError instances", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getPublicForm("x")).rejects.toBeInstanceOf(ApiError);
  });
});
