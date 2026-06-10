import { describe, it, expect } from "vitest";
import {
  createSchema,
  addField,
  updateField,
  removeField,
  reorderFields,
  setValidation,
  validateValue,
  FIELD_TYPES,
} from "../../src/core/schema.js";

const txt = (id, label = "L") => ({ id, type: "text", label });

describe("schema · addField", () => {
  it("appends a normalized field with required defaulting to false", () => {
    const s = createSchema();
    const f = addField(s, txt("name", "姓名"));
    expect(f.required).toBe(false);
    expect(s.fields.map((x) => x.id)).toEqual(["name"]);
  });

  it("auto-generates an id when none is given", () => {
    const s = createSchema();
    const f = addField(s, { type: "text", label: "x" });
    expect(f.id).toBeTruthy();
  });

  it("can insert at an index", () => {
    const s = createSchema([txt("a"), txt("b")]);
    addField(s, txt("mid"), 1);
    expect(s.fields.map((x) => x.id)).toEqual(["a", "mid", "b"]);
  });

  it("rejects unknown field types", () => {
    const s = createSchema();
    expect(() => addField(s, { id: "x", type: "slider", label: "x" })).toThrow(/unknown field type/i);
  });

  it("rejects duplicate ids", () => {
    const s = createSchema([txt("a")]);
    expect(() => addField(s, txt("a"))).toThrow(/duplicate/i);
  });

  it("requires a label", () => {
    const s = createSchema();
    expect(() => addField(s, { id: "x", type: "text" })).toThrow(/label/i);
  });
});

describe("schema · updateField", () => {
  it("patches properties but never the id", () => {
    const s = createSchema([txt("a")]);
    updateField(s, "a", { required: true, label: "新" });
    expect(s.fields[0]).toMatchObject({ id: "a", required: true, label: "新" });
  });

  it("throws for an unknown id", () => {
    const s = createSchema();
    expect(() => updateField(s, "ghost", { required: true })).toThrow(/not found/i);
  });
});

describe("schema · removeField", () => {
  it("removes and returns the field", () => {
    const s = createSchema([txt("a"), txt("b")]);
    const removed = removeField(s, "a");
    expect(removed.id).toBe("a");
    expect(s.fields.map((x) => x.id)).toEqual(["b"]);
  });
});

describe("schema · reorderFields", () => {
  it("reorders to the given permutation", () => {
    const s = createSchema([txt("a"), txt("b"), txt("c")]);
    reorderFields(s, ["c", "a", "b"]);
    expect(s.fields.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("rejects a non-permutation", () => {
    const s = createSchema([txt("a"), txt("b")]);
    expect(() => reorderFields(s, ["a"])).toThrow(/permutation/i);
    expect(() => reorderFields(s, ["a", "ghost"])).toThrow(/permutation/i);
  });
});

describe("schema · setValidation", () => {
  it("merges rules onto the field", () => {
    const s = createSchema([{ id: "tel", type: "text", label: "手机号" }]);
    setValidation(s, "tel", { pattern: "^1\\d{10}$", message: "手机号格式不正确" });
    expect(s.fields[0].validation).toEqual({ pattern: "^1\\d{10}$", message: "手机号格式不正确" });
  });
});

describe("schema · validateValue", () => {
  it("flags required empties", () => {
    expect(validateValue({ type: "text", label: "x", required: true }, "")).toMatch(/必填/);
    expect(validateValue({ type: "checkbox", label: "x", required: true }, [])).toMatch(/必填/);
  });

  it("passes a filled required field", () => {
    expect(validateValue({ type: "text", label: "x", required: true }, "ok")).toBeNull();
  });

  it("enforces a pattern", () => {
    const f = { type: "text", label: "手机号", validation: { pattern: "^1\\d{10}$" } };
    expect(validateValue(f, "12345")).toMatch(/格式/);
    expect(validateValue(f, "13800138000")).toBeNull();
  });

  it("enforces number min/max", () => {
    const f = { type: "number", label: "n", validation: { min: 1, max: 10 } };
    expect(validateValue(f, 0)).toBeTruthy();
    expect(validateValue(f, 11)).toBeTruthy();
    expect(validateValue(f, 5)).toBeNull();
  });
});

describe("schema · field types", () => {
  it("covers the spec's declared set", () => {
    expect(FIELD_TYPES).toEqual([
      "text",
      "number",
      "select",
      "date",
      "checkbox",
      "radio",
      "file",
      "group",
    ]);
  });
});
