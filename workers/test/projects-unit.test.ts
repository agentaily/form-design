import { describe, it, expect } from "vitest";
import { deriveProjectTitle, PROJECT_TITLE_FALLBACK } from "../src/projects";

// Pure-function inner-loop unit for the 项目列表 标题推导 (§26.10, A' 项目↔对话, PR-A). No SELF /
// no D1 — `deriveProjectTitle` is framework-agnostic, so we TDD it directly. It is defensive:
// a corrupt / empty / non-object meta_json must never throw (same discipline as the existing
// `deriveSessionTitle`), it falls back to "未命名表单" instead.

const metaOf = (meta: unknown): string => JSON.stringify(meta);

describe("deriveProjectTitle (§26.10)", () => {
  it("takes meta.title, trimmed", () => {
    expect(deriveProjectTitle(metaOf({ title: "  活动报名表  " }))).toBe("活动报名表");
  });

  it("returns the title verbatim when there is no surrounding whitespace", () => {
    expect(deriveProjectTitle(metaOf({ title: "客户满意度调查" }))).toBe("客户满意度调查");
  });

  it("ignores other meta fields and only reads title", () => {
    expect(
      deriveProjectTitle(metaOf({ title: "我的表单", description: "一段描述", extra: 42 })),
    ).toBe("我的表单");
  });

  it("falls back when meta has no title field", () => {
    expect(deriveProjectTitle(metaOf({ description: "无标题的 meta" }))).toBe(
      PROJECT_TITLE_FALLBACK,
    );
  });

  it("falls back when title is empty / whitespace-only", () => {
    expect(deriveProjectTitle(metaOf({ title: "   " }))).toBe(PROJECT_TITLE_FALLBACK);
    expect(deriveProjectTitle(metaOf({ title: "" }))).toBe(PROJECT_TITLE_FALLBACK);
  });

  it("falls back when title is not a string", () => {
    expect(deriveProjectTitle(metaOf({ title: 123 }))).toBe(PROJECT_TITLE_FALLBACK);
    expect(deriveProjectTitle(metaOf({ title: null }))).toBe(PROJECT_TITLE_FALLBACK);
    expect(deriveProjectTitle(metaOf({ title: { nested: "object" } }))).toBe(
      PROJECT_TITLE_FALLBACK,
    );
  });

  it("falls back on a non-object meta (array / scalar / null JSON) without throwing", () => {
    expect(deriveProjectTitle(metaOf([{ title: "数组不是合法 meta" }]))).toBe(
      PROJECT_TITLE_FALLBACK,
    );
    expect(deriveProjectTitle(metaOf("just a string"))).toBe(PROJECT_TITLE_FALLBACK);
    expect(deriveProjectTitle(metaOf(42))).toBe(PROJECT_TITLE_FALLBACK);
    expect(deriveProjectTitle("null")).toBe(PROJECT_TITLE_FALLBACK);
  });

  it("falls back on corrupt JSON / empty / null / undefined without throwing", () => {
    expect(deriveProjectTitle("not json{{{")).toBe(PROJECT_TITLE_FALLBACK);
    expect(deriveProjectTitle("{}")).toBe(PROJECT_TITLE_FALLBACK);
    expect(deriveProjectTitle("")).toBe(PROJECT_TITLE_FALLBACK);
    expect(deriveProjectTitle(null)).toBe(PROJECT_TITLE_FALLBACK);
    expect(deriveProjectTitle(undefined)).toBe(PROJECT_TITLE_FALLBACK);
  });
});
