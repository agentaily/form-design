import { describe, it, expect } from "vitest";
import {
  parsePublishInput,
  generateSlug,
  FormValidationError,
  type PublishFormInput,
} from "../src/forms";

// Inner-loop unit specs for the pure seams behind 表单发布 + 公开拉取:
//   - parsePublishInput: shape validation (meta.title 非空 + fields 是数组 + 每个
//                        field 形状合法) → PublishFormInput or FormValidationError.
//   - generateSlug:      a fresh, URL-safe, high-entropy, non-guessable slug.
// No D1, no Hono — these compose into saveForm / the route, exercised by the
// outer loop in form-publish-api.test.ts. See SPEC.md §16.2、§16.3、§16.5.

// A representative valid publish body: meta + a couple of fields covering a
// plain text field and a checkbox field with options (§16.2 example shape).
const VALID_INPUT: PublishFormInput = {
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

describe("parsePublishInput (workers/features/form-publish.feature)", () => {
  it("accepts a well-formed publish body and returns meta + fields", () => {
    const parsed = parsePublishInput(structuredClone(VALID_INPUT));
    // meta.title preserved; fields透传 (整体透传，不做字段级语义校验，§16.5).
    expect(parsed.meta.title).toBe("活动报名表");
    expect(parsed.meta.description).toBe("请填写你的报名信息");
    expect(parsed.fields).toHaveLength(2);
    expect(parsed.fields[0]).toMatchObject({ id: "f_name", type: "text", label: "姓名" });
    expect(parsed.fields[1].options).toEqual([
      { label: "阅读", value: "read" },
      { label: "运动", value: "sport" },
    ]);
  });

  it("accepts an empty fields array (空表单的发布约定，§16.5)", () => {
    const parsed = parsePublishInput({ meta: { title: "空表单" }, fields: [] });
    expect(parsed.meta.title).toBe("空表单");
    expect(parsed.fields).toEqual([]);
  });

  it("rejects when meta.title is missing", () => {
    expect(() => parsePublishInput({ meta: { description: "无标题" }, fields: [] })).toThrow(
      FormValidationError,
    );
  });

  it("rejects when meta.title is empty", () => {
    expect(() => parsePublishInput({ meta: { title: "" }, fields: [] })).toThrow(
      FormValidationError,
    );
  });

  it("rejects when meta itself is missing", () => {
    expect(() => parsePublishInput({ fields: [] })).toThrow(FormValidationError);
  });

  it("rejects when fields is not an array", () => {
    expect(() => parsePublishInput({ meta: { title: "x" }, fields: { id: "f1" } })).toThrow(
      FormValidationError,
    );
  });

  it("rejects when fields is missing", () => {
    expect(() => parsePublishInput({ meta: { title: "x" } })).toThrow(FormValidationError);
  });

  it("rejects a field that is missing id / type / label", () => {
    expect(() =>
      parsePublishInput({ meta: { title: "x" }, fields: [{ type: "text", label: "无 id" }] }),
    ).toThrow(FormValidationError);
  });

  it("rejects a field whose type is not a valid FieldType", () => {
    expect(() =>
      parsePublishInput({
        meta: { title: "x" },
        fields: [{ id: "f1", type: "bogus", label: "非法类型" }],
      }),
    ).toThrow(FormValidationError);
  });

  it("rejects a non-object body", () => {
    expect(() => parsePublishInput(null)).toThrow(FormValidationError);
    expect(() => parsePublishInput("not an object")).toThrow(FormValidationError);
    expect(() => parsePublishInput([])).toThrow(FormValidationError);
  });
});

describe("generateSlug (workers/features/form-publish.feature, §16.3)", () => {
  it("returns a non-empty string", () => {
    const slug = generateSlug();
    expect(slug).toBeTypeOf("string");
    expect(slug.length).toBeGreaterThan(0);
  });

  it("uses only URL-safe characters (no枚举 / 不可猜 random串)", () => {
    // URL-safe: unreserved chars only — alnum plus '-' / '_' (base32/base36/base64url).
    // Notably NO '/', '+', '=', whitespace, or '%' that would need escaping in a path.
    const URL_SAFE = /^[A-Za-z0-9_-]+$/;
    for (let i = 0; i < 50; i++) {
      expect(generateSlug()).toMatch(URL_SAFE);
    }
  });

  it("does not produce a trivially short / low-entropy slug", () => {
    // Enough entropy that slugs are not guessable / enumerable (§16.3). A
    // crypto-random base32/36 串 is comfortably longer than this floor.
    expect(generateSlug().length).toBeGreaterThanOrEqual(8);
  });

  it("produces distinct slugs across many calls (high entropy, no collisions)", () => {
    const n = 1000;
    const slugs = new Set<string>();
    for (let i = 0; i < n; i++) {
      slugs.add(generateSlug());
    }
    // All distinct: a low-entropy / sequential generator would collide here.
    expect(slugs.size).toBe(n);
  });
});
