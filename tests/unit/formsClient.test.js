// Unit specs for src/core/formsClient.ts — the frontend seam for form publishing +
// management (SPEC §16 发布/公开拉取约定 + §21 owner-only 管理 CRUD, §17 auth).
//
// These bind the WIRE contract of the five calls (path / method / `auth:true` /
// payload construction / typed ApiError pass-through), in particular:
//   • publishForm maps the designer model (FormMeta + UiField[], with desc + UI types +
//     options:string[]) → the §16.2 PublishFormInput wire shape ({ meta:{title,
//     description?}, fields:[{id,type,label,required?,options?:{label,value}[]}] }) and
//     POSTs it owner-only; returns { slug } (+ optional url).
//   • listForms unwraps the §21.2 { forms, count } envelope to the FormSummary[] array.
//   • updateForm PATCHes status published↔closed; deleteForm DELETEs by slug.
//   • publicFormUrl is a pure /f/:slug builder (no I/O), backend url preferred upstream.
//
// We mock the lowest seam (global `fetch`, the same level apiClient.test.js /
// configClient.test.js mock) rather than apiClient itself, so these also pin that
// formsClient routes through apiFetch with Bearer injection and the typed ApiError.
// The component-level behavior (link display, status badges, delete confirm, 401 →
// onNeedLogin) is pinned separately in tests/integration/form-publish-mgmt.spec.jsx.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  publishForm,
  listForms,
  updateForm,
  updateFormDefinition,
  getFormForEdit,
  deleteForm,
  publicFormUrl,
  PUBLIC_FORM_PATH,
} from "../../src/core/formsClient";
import { setToken, clearToken, ApiError } from "../../src/core/apiClient";

function jsonResponse(body, init = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

// A designer-shape form as App holds it (FormMeta + UiField[]): meta carries `desc`
// (UI key) not `description`; a choice field carries UI type + `options: string[]`.
const DESIGNER_META = { title: "活动报名表", desc: "请填写你的报名信息", kicker: "活动" };
const DESIGNER_FIELDS = [
  { id: "f_name", type: "text", label: "姓名", required: true },
  { id: "f_hobby", type: "checks", label: "兴趣", options: ["阅读", "运动"] },
];

beforeEach(() => {
  clearToken();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearToken();
});

describe("formsClient · publishForm", () => {
  it("POSTs /api/forms as the owner (Bearer) and resolves the { slug } result", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ slug: "f8Kq2pXa" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await publishForm(DESIGNER_META, DESIGNER_FIELDS);

    expect(out).toMatchObject({ slug: "f8Kq2pXa" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/forms");
    // POST, not PATCH/DELETE, and not the GET list path.
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
    expect(init.headers["content-type"]).toBe("application/json");
  });

  it("maps the designer model to the §16.2 wire shape (meta.title + description, fields)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ slug: "s1" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await publishForm(DESIGNER_META, DESIGNER_FIELDS);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // meta.title is carried through (required, non-empty per §16.2).
    expect(body.meta.title).toBe("活动报名表");
    // The designer `desc` surfaces as the wire `description` (never an empty/dropped desc).
    expect(body.meta.description).toBe("请填写你的报名信息");
    // fields is the required array, one wire field per designer field, ids preserved.
    expect(Array.isArray(body.fields)).toBe(true);
    expect(body.fields).toHaveLength(2);
    expect(body.fields.map((f) => f.id)).toEqual(["f_name", "f_hobby"]);
    // Each wire field carries the §16.2 shape: id / type / label present.
    body.fields.forEach((f) => {
      expect(typeof f.id).toBe("string");
      expect(typeof f.type).toBe("string");
      expect(typeof f.label).toBe("string");
    });
    // required is preserved on the field that had it.
    expect(body.fields.find((f) => f.id === "f_name").required).toBe(true);
  });

  it("maps a choice field's options:string[] → §16.2 {label,value}[] objects", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ slug: "s1" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await publishForm(DESIGNER_META, DESIGNER_FIELDS);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const hobby = body.fields.find((f) => f.id === "f_hobby");
    // §16.2 options are objects, never raw strings.
    expect(Array.isArray(hobby.options)).toBe(true);
    expect(hobby.options).toHaveLength(2);
    hobby.options.forEach((o) => {
      expect(o).toBeTypeOf("object");
      expect(typeof o.label).toBe("string");
      // each carries a value too (label/value pair, not a bare string)
      expect("value" in o).toBe(true);
    });
    expect(hobby.options.map((o) => o.label)).toEqual(["阅读", "运动"]);
    // The bare-string form must NOT have leaked onto the wire.
    expect(hobby.options).not.toContain("阅读");
  });

  it("attaches a backend-provided url when POST returns one (§16.2 optional url)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { slug: "f8Kq2pXa", url: "https://form-design.agentaily.com/f/f8Kq2pXa" },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await publishForm(DESIGNER_META, DESIGNER_FIELDS);
    expect(out.slug).toBe("f8Kq2pXa");
    expect(out.url).toBe("https://form-design.agentaily.com/f/f8Kq2pXa");
  });

  it("rejects with a 400 ApiError carrying the backend message (missing title / bad fields)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "meta.title 必填" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishForm({ title: "" }, DESIGNER_FIELDS)).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "meta.title 必填",
    });
  });

  it("rejects with a 401 ApiError so the caller can route into login (§17)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishForm(DESIGNER_META, DESIGNER_FIELDS)).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });
});

describe("formsClient · listForms", () => {
  const SUMMARY = {
    slug: "f8Kq2pXa",
    meta: { title: "活动报名表", description: "请填写你的报名信息" },
    status: "published",
    createdAt: "2026-06-11T08:00:00.000Z",
  };

  it("GETs /api/forms as the owner (Bearer) and unwraps { forms, count } → FormSummary[]", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ forms: [SUMMARY], count: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await listForms();

    // Resolves to the array, NOT the { forms, count } envelope.
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject(SUMMARY);

    const [url, init] = fetchMock.mock.calls[0];
    // The owner list path is /api/forms WITHOUT a :slug segment (§21.1).
    expect(url).toMatch(/\/api\/forms(\?|$)/);
    expect(init.method).toBe("GET");
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
    // GET carries no body.
    expect(init.body).toBeUndefined();
  });

  it("resolves to [] for an owner with no forms (normal empty state, not an error)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ forms: [], count: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listForms()).resolves.toEqual([]);
  });

  it("rejects with a 401 ApiError (session expired → route into login, §17)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listForms()).rejects.toMatchObject({ name: "ApiError", status: 401 });
  });
});

describe("formsClient · updateForm", () => {
  it("PATCHes /api/forms/:slug as the owner with the status patch (published→closed)", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ slug: "f8Kq2pXa", status: "closed" }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await updateForm("f8Kq2pXa", { status: "closed" });

    expect(out).toMatchObject({ slug: "f8Kq2pXa", status: "closed" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/forms/f8Kq2pXa");
    expect(init.method).toBe("PATCH");
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ status: "closed" });
  });

  it("PATCHes the reopen direction (closed→published) carrying the right status", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ slug: "s1", status: "published" }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await updateForm("s1", { status: "published" });
    expect(out.status).toBe("published");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ status: "published" });
  });

  it("rejects with a 404 ApiError for an unknown slug (§21.5)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "no such form" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateForm("gone", { status: "closed" })).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
    });
  });

  it("rejects with a 400 ApiError on an illegal status (§21.3 — never draft)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "illegal status" }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateForm("s1", { status: "closed" })).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
    });
  });

  it("rejects with a 401 ApiError (session expired → route into login, §17)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateForm("s1", { status: "closed" })).rejects.toMatchObject({ status: 401 });
  });
});

describe("formsClient · getFormForEdit (载回设计器编辑)", () => {
  // The backend's owner read-back (the empty-body no-op PATCH) returns the wire view:
  // §16.2 fields ({label,value}[] options, §3.2 types) + wire meta ({title,description}).
  const WIRE_VIEW = {
    slug: "f8Kq2pXa",
    status: "published",
    createdAt: "2026-06-11T08:00:00.000Z",
    meta: { title: "活动报名表", description: "请填写你的报名信息" },
    fields: [
      { id: "fld_3", type: "text", label: "姓名", required: true },
      {
        id: "fld_7",
        type: "checkbox",
        label: "兴趣",
        options: [
          { label: "阅读", value: "阅读" },
          { label: "运动", value: "运动" },
        ],
      },
    ],
  };

  it("reads the form back via an EMPTY-BODY PATCH (owner read-back, Bearer)", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse(WIRE_VIEW));
    vi.stubGlobal("fetch", fetchMock);

    await getFormForEdit("f8Kq2pXa");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/forms/f8Kq2pXa");
    // No owner GET exists; the read-back is the no-op PATCH with an empty body (§21.3).
    expect(init.method).toBe("PATCH");
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
    expect(JSON.parse(init.body)).toEqual({});
  });

  it("maps the wire view back to the designer shape (meta.desc + status + UiField[])", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(WIRE_VIEW));
    vi.stubGlobal("fetch", fetchMock);

    const form = await getFormForEdit("f8Kq2pXa");

    expect(form.slug).toBe("f8Kq2pXa");
    expect(form.status).toBe("published");
    // wire meta.description → designer meta.desc (UI key the designer renders).
    expect(form.meta).toMatchObject({ title: "活动报名表", desc: "请填写你的报名信息" });
    expect(form.fields).toHaveLength(2);
    // §3.2 checkbox → designer multi-choice `checks`; text → text.
    expect(form.fields[0]).toMatchObject({ type: "text", label: "姓名", required: true });
    expect(form.fields[1].type).toBe("checks");
    // wire {label,value}[] options collapse back to a string[] of labels.
    expect(form.fields[1].options).toEqual(["阅读", "运动"]);
  });

  it("PRESERVES stored field ids (so a later update round-trips them for rename detection)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(WIRE_VIEW));
    vi.stubGlobal("fetch", fetchMock);

    const form = await getFormForEdit("f8Kq2pXa");
    // ids are carried verbatim, never re-minted — the backend matches changed labels by id.
    expect(form.fields.map((f) => f.id)).toEqual(["fld_3", "fld_7"]);
  });

  it("rejects with a 404 ApiError for an unknown / cross-owner slug (§17.9)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "no such form" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getFormForEdit("gone")).rejects.toMatchObject({ name: "ApiError", status: 404 });
  });

  it("rejects with a 401 ApiError (session expired → route into login, §17)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getFormForEdit("s1")).rejects.toMatchObject({ name: "ApiError", status: 401 });
  });
});

describe("formsClient · updateFormDefinition (写回 meta+fields)", () => {
  const DESIGNER_META = { title: "活动报名表", desc: "改后的介绍", kicker: "活动" };
  const DESIGNER_FIELDS = [
    { id: "fld_3", type: "tel", label: "联系电话", required: true }, // 改了标签的 tel 字段
    { id: "fld_7", type: "checks", label: "兴趣", options: ["阅读", "运动"] },
  ];

  it("PATCHes /api/forms/:slug as the owner with { meta, fields } (no status)", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ slug: "f8Kq2pXa", status: "published" }));
    vi.stubGlobal("fetch", fetchMock);

    await updateFormDefinition("f8Kq2pXa", DESIGNER_META, DESIGNER_FIELDS);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/forms/f8Kq2pXa");
    expect(init.method).toBe("PATCH");
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(["fields", "meta"]); // never touches status
  });

  it("maps the designer model → §16.2 wire shape (meta.description, §3.2 types, {label,value} options)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ slug: "s1", status: "published" }));
    vi.stubGlobal("fetch", fetchMock);

    await updateFormDefinition("s1", DESIGNER_META, DESIGNER_FIELDS);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.meta).toMatchObject({ title: "活动报名表", description: "改后的介绍" });
    // tel → §3.2 text; checks → §3.2 checkbox.
    const tel = body.fields.find((f) => f.id === "fld_3");
    expect(tel.type).toBe("text");
    const hobby = body.fields.find((f) => f.id === "fld_7");
    expect(hobby.type).toBe("checkbox");
    expect(hobby.options).toEqual([
      { label: "阅读", value: "阅读" },
      { label: "运动", value: "运动" },
    ]);
  });

  it("PRESERVES field ids on the wire so the backend matches a changed label as a rename", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ slug: "s1", status: "published" }));
    vi.stubGlobal("fetch", fetchMock);

    await updateFormDefinition("s1", DESIGNER_META, DESIGNER_FIELDS);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // The same ids that were loaded go back out — that id match is how 飞书列改名 works.
    expect(body.fields.map((f) => f.id)).toEqual(["fld_3", "fld_7"]);
  });

  it("rejects with a 401 ApiError (session expired → route into login, §17)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateFormDefinition("s1", DESIGNER_META, DESIGNER_FIELDS)).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });
});

describe("formsClient · deleteForm", () => {
  it("DELETEs /api/forms/:slug as the owner and resolves the { ok, slug } result", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, slug: "f8Kq2pXa" }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await deleteForm("f8Kq2pXa");

    expect(out).toMatchObject({ ok: true, slug: "f8Kq2pXa" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/forms/f8Kq2pXa");
    expect(init.method).toBe("DELETE");
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
  });

  it("rejects with a 404 ApiError for an unknown slug (strict, non-idempotent, §21.4)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "no such form" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteForm("gone")).rejects.toMatchObject({ name: "ApiError", status: 404 });
  });

  it("rejects with a 401 ApiError (session expired → route into login, §17)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteForm("s1")).rejects.toMatchObject({ status: 401 });
  });
});

describe("formsClient · publicFormUrl (pure, no I/O)", () => {
  it("builds the same-origin /f/:slug path when no base is given (§16.4.1)", () => {
    expect(publicFormUrl("f8Kq2pXa")).toBe("/f/f8Kq2pXa");
  });

  it("builds an absolute URL when a base origin is given", () => {
    expect(publicFormUrl("f8Kq2pXa", "https://form-design.agentaily.com")).toBe(
      "https://form-design.agentaily.com/f/f8Kq2pXa",
    );
  });

  it("does not double a slash when the base carries a trailing slash", () => {
    expect(publicFormUrl("f8Kq2pXa", "https://form-design.agentaily.com/")).toBe(
      "https://form-design.agentaily.com/f/f8Kq2pXa",
    );
  });

  it("exposes the contract-fixed PUBLIC_FORM_PATH ('/f/') it builds from", () => {
    expect(PUBLIC_FORM_PATH).toBe("/f/");
    // The built path actually starts with that prefix (not a divergent hardcode).
    expect(publicFormUrl("zzz").startsWith(PUBLIC_FORM_PATH)).toBe(true);
  });

  it("makes no network call (pure) — fetch is never touched", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    publicFormUrl("f8Kq2pXa");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Sanity: ApiError is the surface these calls reject with (keeps the import meaningful).
describe("formsClient · error surface", () => {
  it("non-2xx rejections are ApiError instances", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listForms()).rejects.toBeInstanceOf(ApiError);
  });
});
