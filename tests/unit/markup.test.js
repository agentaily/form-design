import { describe, it, expect } from "vitest";
import {
  fieldKindLabel,
  mkLabel,
  formatMarkupMessage,
  formatMarkupMessageForTarget,
  FIELD_KIND_LABEL,
  FIELD_KIND_FALLBACK,
} from "../../src/core/markup";

describe("markup · fieldKindLabel", () => {
  it("maps every known field type to its Chinese kind", () => {
    expect(fieldKindLabel("text")).toBe("输入框");
    expect(fieldKindLabel("tel")).toBe("输入框");
    expect(fieldKindLabel("email")).toBe("输入框");
    expect(fieldKindLabel("textarea")).toBe("多行文本");
    expect(fieldKindLabel("radio")).toBe("单选");
    expect(fieldKindLabel("checks")).toBe("多选");
    expect(fieldKindLabel("select")).toBe("下拉选择");
    expect(fieldKindLabel("consent")).toBe("勾选项");
  });

  it("stays in sync with the FIELD_KIND_LABEL table", () => {
    for (const [type, kind] of Object.entries(FIELD_KIND_LABEL)) {
      expect(fieldKindLabel(type)).toBe(kind);
    }
  });

  it("falls back to 「字段」 for an unknown / unmapped type", () => {
    expect(fieldKindLabel("slider")).toBe(FIELD_KIND_FALLBACK);
    expect(fieldKindLabel("slider")).toBe("字段");
    expect(fieldKindLabel("")).toBe("字段");
  });
});

describe("markup · mkLabel", () => {
  it("strips a trailing required-star with surrounding whitespace", () => {
    expect(mkLabel("手机号 *")).toBe("手机号");
    expect(mkLabel("手机号*")).toBe("手机号");
    expect(mkLabel("手机号 * ")).toBe("手机号");
  });

  it("leaves a label without a trailing star untouched (trimmed)", () => {
    expect(mkLabel("姓名")).toBe("姓名");
    expect(mkLabel("  姓名  ")).toBe("姓名");
  });

  it("falls back to 「字段」 for empty / blank input", () => {
    expect(mkLabel("")).toBe("字段");
    expect(mkLabel("   ")).toBe("字段");
    expect(mkLabel(" * ")).toBe("字段");
  });
});

describe("markup · formatMarkupMessage", () => {
  it("tags label · kind when a kind is present", () => {
    expect(formatMarkupMessage("提交按钮", "按钮", "改成立即报名")).toBe(
      "〔提交按钮 · 按钮〕改成立即报名",
    );
  });

  it("tags only the label when kind is missing", () => {
    expect(formatMarkupMessage("封面", undefined, "换个图")).toBe("〔封面〕换个图");
  });

  it("treats an empty-string kind the same as no kind", () => {
    expect(formatMarkupMessage("封面", "", "换个图")).toBe("〔封面〕换个图");
  });

  it("trims the note before composing", () => {
    expect(formatMarkupMessage("姓名", "输入框", "  改一下  ")).toBe("〔姓名 · 输入框〕改一下");
  });
});

describe("markup · formatMarkupMessageForTarget", () => {
  it("formats from a resolved target with a kind", () => {
    expect(formatMarkupMessageForTarget({ label: "提交按钮", kind: "按钮" }, "改成立即报名")).toBe(
      "〔提交按钮 · 按钮〕改成立即报名",
    );
  });

  it("formats from a target with only a label", () => {
    expect(formatMarkupMessageForTarget({ label: "封面" }, "换个图")).toBe("〔封面〕换个图");
  });

  it("trims the note like the underlying formatter", () => {
    expect(formatMarkupMessageForTarget({ label: "封面" }, "  换个图 ")).toBe("〔封面〕换个图");
  });
});
