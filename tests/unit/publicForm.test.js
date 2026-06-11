// Unit specs for the pure helpers of src/public-form.jsx — the PUBLIC fill page
// (答题者侧, 第 6 步).
//
// collectAnswers(fields, values) is the §15.2/§16.5 answers-collection contract,
// pure (no React/DOM) so it's unit-checkable on its own:
//   - one entry per field that HAS a value: { label: field.label, value }
//   - single-value fields → value: string; checkbox-WITH-options → value: string[]
//   - empty values (empty string / whitespace-only / empty array) are OMITTED.
// PUBLIC_FIELD_RENDER is the backend-type → design-system control mapping (one source
// of truth). The full page render/submit behavior is pinned at the integration level
// in tests/integration/public-fill.spec.jsx.
import { describe, it, expect } from "vitest";
import { collectAnswers, PUBLIC_FIELD_RENDER } from "../../src/public-form.jsx";

// A representative published form: text (single), radio (single), checkbox-with-
// options (multi → array), and a checkbox-without-options consent (single).
const FIELDS = [
  { id: "f_name", type: "text", label: "姓名", required: true },
  {
    id: "f_ticket",
    type: "radio",
    label: "票种",
    options: [
      { label: "普通票", value: "std" },
      { label: "学生票", value: "stu" },
    ],
  },
  {
    id: "f_hobby",
    type: "checkbox",
    label: "兴趣",
    options: [
      { label: "阅读", value: "read" },
      { label: "运动", value: "sport" },
    ],
  },
  { id: "f_consent", type: "checkbox", label: "我已阅读须知" },
];

// Look up the answer for a field label in a collected answers[] (or undefined).
const answerFor = (answers, label) => answers.find((a) => a.label === label);

describe("public-form · collectAnswers", () => {
  it("collects single-value fields as { label, value:string }", () => {
    const answers = collectAnswers(FIELDS, { f_name: "张三", f_ticket: "std" });
    expect(answerFor(answers, "姓名")).toEqual({ label: "姓名", value: "张三" });
    expect(answerFor(answers, "票种")).toEqual({ label: "票种", value: "std" });
  });

  it("collects a checkbox-with-options as { label, value:string[] } (multi-choice)", () => {
    const answers = collectAnswers(FIELDS, { f_hobby: ["read", "sport"] });
    const hobby = answerFor(answers, "兴趣");
    expect(Array.isArray(hobby.value)).toBe(true);
    expect(hobby.value).toEqual(["read", "sport"]);
  });

  it("keys answers by the field's LABEL, not its id (§15.3 label = 飞书 column key)", () => {
    const answers = collectAnswers(FIELDS, { f_name: "张三" });
    expect(answers.map((a) => a.label)).toContain("姓名");
    // the internal id never leaks into the wire shape
    expect(JSON.stringify(answers)).not.toContain("f_name");
  });

  it("omits an empty string value (unanswered optional → no answer)", () => {
    const answers = collectAnswers(FIELDS, { f_name: "" });
    expect(answerFor(answers, "姓名")).toBeUndefined();
  });

  it("omits a whitespace-only value (§20.3 空值判定)", () => {
    const answers = collectAnswers(FIELDS, { f_name: "   " });
    expect(answerFor(answers, "姓名")).toBeUndefined();
  });

  it("omits an empty multi-choice array (no selection → no answer)", () => {
    const answers = collectAnswers(FIELDS, { f_hobby: [] });
    expect(answerFor(answers, "兴趣")).toBeUndefined();
  });

  it("omits a field that has no value at all (undefined)", () => {
    const answers = collectAnswers(FIELDS, {});
    expect(answers).toEqual([]);
  });

  it("only emits the filled fields, dropping the empty ones", () => {
    const answers = collectAnswers(FIELDS, {
      f_name: "张三",
      f_ticket: "", // empty → dropped
      f_hobby: ["read"], // kept (array)
      f_consent: "", // empty → dropped
    });
    expect(answers.map((a) => a.label).sort()).toEqual(["兴趣", "姓名"]);
  });
});

describe("public-form · PUBLIC_FIELD_RENDER mapping (one source of truth)", () => {
  it("maps choice types to the right design-system controls", () => {
    expect(PUBLIC_FIELD_RENDER.select).toBe("Select");
    expect(PUBLIC_FIELD_RENDER.radio).toBe("RadioGroup");
    expect(PUBLIC_FIELD_RENDER.checkbox).toBe("Checkbox");
  });

  it("maps text/number/date to the Input control", () => {
    expect(PUBLIC_FIELD_RENDER.text).toBe("Input");
    expect(PUBLIC_FIELD_RENDER.number).toBe("Input");
    expect(PUBLIC_FIELD_RENDER.date).toBe("Input");
  });

  it("covers every backend PublicFieldType so no field type renders blank", () => {
    // The mapping must have an entry for each §16.2 PublicFieldType.
    for (const t of ["text", "number", "select", "date", "checkbox", "radio", "file", "group"]) {
      expect(PUBLIC_FIELD_RENDER[t]).toBeTruthy();
    }
  });
});
