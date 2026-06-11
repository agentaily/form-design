import { describe, it, expect } from "vitest";
import {
  createSchema,
  addField,
  updateField,
  removeField,
  duplicateField,
  reorderFields,
  setValidation,
  validateValue,
  FIELD_TYPES,
  __resetFieldIdCounter,
} from "../../src/core/schema";

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
    expect(() => addField(s, { id: "x", type: "slider", label: "x" })).toThrow(
      /unknown field type/i,
    );
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

describe("schema · duplicateField", () => {
  it("inserts the copy right after the source field", () => {
    const s = createSchema([txt("name", "姓名"), txt("email", "邮箱")]);
    const copy = duplicateField(s, "name");
    expect(s.fields.map((x) => x.id)).toEqual(["name", copy.id, "email"]);
  });

  it("gives the copy the same content but a different id", () => {
    const s = createSchema([{ id: "name", type: "text", label: "姓名", required: true }]);
    const copy = duplicateField(s, "name");
    expect(copy.id).not.toBe("name");
    expect({ ...copy, id: undefined }).toEqual({ ...s.fields[0], id: undefined });
  });

  it("grows the field count by one", () => {
    const s = createSchema([txt("name", "姓名"), txt("email", "邮箱")]);
    duplicateField(s, "name");
    expect(s.fields).toHaveLength(3);
  });

  it("returns the newly inserted field", () => {
    const s = createSchema([txt("name", "姓名")]);
    const copy = duplicateField(s, "name");
    expect(s.fields[1]).toBe(copy);
  });

  it("deep-copies so edits to the copy do not leak into the source", () => {
    const s = createSchema([
      { id: "g", type: "group", label: "组", children: [{ id: "c1", type: "text", label: "子" }] },
    ]);
    const copy = duplicateField(s, "g");
    copy.children[0].label = "改了";
    expect(s.fields[0].children[0].label).toBe("子");
  });

  it("gives cloned group children fresh ids recursively", () => {
    const s = createSchema([
      {
        id: "g",
        type: "group",
        label: "组",
        children: [
          { id: "c1", type: "text", label: "子1" },
          {
            id: "c2",
            type: "group",
            label: "嵌套",
            children: [{ id: "c3", type: "text", label: "孙" }],
          },
        ],
      },
    ]);
    const copy = duplicateField(s, "g");
    const copyIds = [copy.children[0].id, copy.children[1].id, copy.children[1].children[0].id];
    expect(copyIds).not.toContain("c1");
    expect(copyIds).not.toContain("c2");
    expect(copyIds).not.toContain("c3");
    expect(new Set(copyIds).size).toBe(3);
  });

  it("throws for an unknown id and leaves the schema unchanged", () => {
    const s = createSchema([txt("name", "姓名"), txt("email", "邮箱")]);
    expect(() => duplicateField(s, "ghost")).toThrow(/not found/i);
    expect(s.fields).toHaveLength(2);
  });

  // regression: an explicit id matching the auto-id pattern must not collide with
  // genFieldId()'s counter (the bug the reviewer caught). The reset pins the
  // counter to the collision window, so this FAILS if the collision-aware
  // allocator is reverted (without it, the clone would re-mint "field_1").
  it("mints unique ids even when an explicit id matches the auto-id pattern", () => {
    __resetFieldIdCounter(); // next genFieldId() would be "field_1"
    const s = createSchema([{ id: "field_1", type: "text", label: "x" }]);
    const copy = duplicateField(s, "field_1");
    expect(copy.id).not.toBe("field_1");
    const ids = s.fields.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length); // every id unique
  });

  it("deep-copies options and validation (no shared references)", () => {
    const s = createSchema([
      {
        id: "sel",
        type: "select",
        label: "方向",
        options: [{ label: "前端", value: "fe" }],
        validation: { message: "必选" },
      },
    ]);
    const copy = duplicateField(s, "sel");
    copy.options[0].value = "changed";
    copy.validation.message = "改了";
    expect(s.fields[0].options[0].value).toBe("fe");
    expect(s.fields[0].validation.message).toBe("必选");
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
