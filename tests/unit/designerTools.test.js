import { describe, it, expect, beforeEach } from "vitest";
import {
  createFormModel,
  addField,
  updateField,
  removeField,
  duplicateField,
  reorderFields,
  setFormMeta,
  getFormSchema,
  applyDesignerTool,
  reserveUidsFrom,
  __resetUid,
} from "../../src/core/designerTools";

beforeEach(() => __resetUid());

describe("designerTools · reserveUidsFrom (载回编辑防 id 撞)", () => {
  it("advances the counter past loaded ids so a new field never collides", () => {
    // A form loaded back for editing keeps its original ids (fld_3, fld_5).
    reserveUidsFrom(["fld_3", "fld_5"]);
    const m = createFormModel();
    // The next added field gets an id strictly greater than every loaded one (fld_6).
    const out = addField(m, { type: "text", label: "新字段" });
    expect(out.id).toBe("fld_6");
    expect(["fld_3", "fld_5"]).not.toContain(out.id);
  });

  it("ignores ids without a base36 suffix and never lowers the counter", () => {
    addField(createFormModel(), { type: "text", label: "x" }); // counter → 1
    reserveUidsFrom(["weird", "no-suffix", "fld_1"]); // max seen (1) not above counter
    const out = addField(createFormModel(), { type: "text", label: "y" });
    expect(out.id).toBe("fld_2"); // counter advanced normally, never reset
  });
});

describe("designerTools · addField", () => {
  it("appends a field and returns its public shape (no _new flag)", () => {
    const m = createFormModel();
    const out = addField(m, { type: "text", label: "姓名", required: true });
    expect(out).toEqual({ id: "fld_1", type: "text", label: "姓名", required: true });
    expect(m.fields[0]._new).toBe(true); // transient flag stays on the model
  });

  it("inserts new fields before a trailing consent field by default", () => {
    const m = createFormModel();
    addField(m, { type: "consent", label: "我已阅读并同意" });
    addField(m, { type: "text", label: "姓名" });
    expect(m.fields.map((f) => f.label)).toEqual(["姓名", "我已阅读并同意"]);
  });

  it("rejects an unknown type and an option-less radio", () => {
    const m = createFormModel();
    expect(() => addField(m, { type: "slider", label: "x" })).toThrow(/unknown field type/);
    expect(() => addField(m, { type: "radio", label: "票种" })).toThrow(/options/);
  });

  it("normalizes {label,value} options down to label strings", () => {
    const m = createFormModel();
    const out = addField(m, {
      type: "select",
      label: "方向",
      options: ["前端", { label: "后端", value: "be" }],
    });
    expect(out.options).toEqual(["前端", "后端"]);
  });
});

describe("designerTools · update/remove/duplicate/reorder", () => {
  it("updates a field by id and re-marks it new", () => {
    const m = createFormModel();
    const { id } = addField(m, { type: "text", label: "公司" });
    m.fields[0]._new = false;
    const out = updateField(m, { id, patch: { required: true } });
    expect(out.required).toBe(true);
    expect(m.fields[0]._new).toBe(true);
  });

  it("throws when updating a missing id", () => {
    const m = createFormModel();
    expect(() => updateField(m, { id: "nope", patch: {} })).toThrow(/field not found/);
  });

  it("removes a field by id", () => {
    const m = createFormModel();
    const { id } = addField(m, { type: "text", label: "姓名" });
    expect(removeField(m, id)).toEqual({ removed: id });
    expect(m.fields).toHaveLength(0);
  });

  it("duplicates a field right after the original with a fresh id and copied options", () => {
    const m = createFormModel();
    const { id } = addField(m, { type: "radio", label: "票种", options: ["A", "B"] });
    const copy = duplicateField(m, id);
    expect(m.fields.map((f) => f.id)).toEqual([id, copy.id]);
    expect(copy.id).not.toBe(id);
    expect(copy.options).toEqual(["A", "B"]);
    m.fields[1].options.push("C"); // copy is independent
    expect(m.fields[0].options).toEqual(["A", "B"]);
  });

  it("reorders fields by a full id permutation, rejecting a partial set", () => {
    const m = createFormModel();
    const a = addField(m, { type: "text", label: "A" }).id;
    const b = addField(m, { type: "text", label: "B" }).id;
    expect(reorderFields(m, [b, a]).ids).toEqual([b, a]);
    expect(m.fields.map((f) => f.label)).toEqual(["B", "A"]);
    expect(() => reorderFields(m, [a])).toThrow(/permutation/);
  });
});

describe("designerTools · meta + schema", () => {
  it("merges form meta and reads it back via the schema", () => {
    const m = createFormModel();
    setFormMeta(m, { title: "报名", meta: ["6.28"] });
    setFormMeta(m, { desc: "西岸" });
    expect(m.meta).toEqual({ title: "报名", meta: ["6.28"], desc: "西岸" });
    addField(m, { type: "text", label: "姓名" });
    const schema = getFormSchema(m);
    expect(schema.meta.title).toBe("报名");
    expect(schema.fields[0]).not.toHaveProperty("_new"); // schema is the model's public view
  });
});

describe("designerTools · applyDesignerTool dispatch", () => {
  it("routes tool names to operations and rejects unknown tools", () => {
    const m = createFormModel();
    const out = applyDesignerTool(m, "add_field", { type: "text", label: "姓名" });
    expect(out).toMatchObject({ label: "姓名" });
    expect(() => applyDesignerTool(m, "frobnicate", {})).toThrow(/unknown tool/);
  });
});
