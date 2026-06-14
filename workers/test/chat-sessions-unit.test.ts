import { describe, it, expect } from "vitest";
import {
  deriveSessionTitle,
  countUserTurns,
  SESSION_TITLE_MAX_LEN,
  SESSION_TITLE_FALLBACK,
} from "../src/chatSessions";

// Pure-function inner-loop units for the 多会话列表 投影 (§26.9, PR #65). No SELF /
// no D1 — `deriveSessionTitle` / `countUserTurns` are framework-agnostic, so we TDD
// them directly. Both are defensive: a corrupt / empty turns_json must never throw
// (same discipline as the existing parseJsonArray), it falls back instead.

const jsonOf = (turns: unknown): string => JSON.stringify(turns);

describe("deriveSessionTitle (§26.9)", () => {
  it("takes the first user turn's text, trimmed", () => {
    const turns = [
      { role: "assistant", text: "你好，我能帮你设计表单" },
      { role: "user", text: "  帮我做一个活动报名表  " },
      { role: "user", text: "再加个邮箱字段" },
    ];
    expect(deriveSessionTitle(jsonOf(turns))).toBe("帮我做一个活动报名表");
  });

  it("uses the FIRST user turn even when an assistant turn precedes it", () => {
    const turns = [
      { role: "assistant", text: "AAA" },
      { role: "user", text: "第一条用户消息" },
      { role: "user", text: "第二条用户消息" },
    ];
    expect(deriveSessionTitle(jsonOf(turns))).toBe("第一条用户消息");
  });

  it("keeps a title that is exactly SESSION_TITLE_MAX_LEN chars unchanged (no ellipsis)", () => {
    const exact = "字".repeat(SESSION_TITLE_MAX_LEN);
    const out = deriveSessionTitle(jsonOf([{ role: "user", text: exact }]));
    expect(out).toBe(exact);
    expect(out).not.toContain("…");
    expect([...out].length).toBe(SESSION_TITLE_MAX_LEN);
  });

  it("truncates a too-long title to SESSION_TITLE_MAX_LEN chars + a single ellipsis", () => {
    const long = "字".repeat(SESSION_TITLE_MAX_LEN + 5);
    const out = deriveSessionTitle(jsonOf([{ role: "user", text: long }]));
    // 40 kept chars + one "…" appended (ellipsis NOT counted toward the 40).
    expect(out).toBe("字".repeat(SESSION_TITLE_MAX_LEN) + "…");
    expect([...out].length).toBe(SESSION_TITLE_MAX_LEN + 1);
  });

  it("counts by code points, not UTF-16 units, when truncating", () => {
    // Emoji are surrogate pairs; truncating by .slice would split them. Use code points.
    const emoji = "🎉".repeat(SESSION_TITLE_MAX_LEN + 3);
    const out = deriveSessionTitle(jsonOf([{ role: "user", text: emoji }]));
    expect(out).toBe("🎉".repeat(SESSION_TITLE_MAX_LEN) + "…");
    expect([...out].length).toBe(SESSION_TITLE_MAX_LEN + 1);
  });

  it("falls back when there is no user turn at all", () => {
    const turns = [
      { role: "assistant", text: "AAA" },
      { role: "assistant", text: "BBB" },
    ];
    expect(deriveSessionTitle(jsonOf(turns))).toBe(SESSION_TITLE_FALLBACK);
  });

  it("falls back when the first user turn's text is empty / whitespace-only", () => {
    expect(deriveSessionTitle(jsonOf([{ role: "user", text: "   " }]))).toBe(
      SESSION_TITLE_FALLBACK,
    );
    expect(deriveSessionTitle(jsonOf([{ role: "user", text: "" }]))).toBe(SESSION_TITLE_FALLBACK);
  });

  it("falls back when the first user turn has no text field", () => {
    expect(deriveSessionTitle(jsonOf([{ role: "user", kind: "tool" }]))).toBe(
      SESSION_TITLE_FALLBACK,
    );
  });

  it("falls back on corrupt JSON / non-array / empty / null without throwing", () => {
    expect(deriveSessionTitle("not json{{{")).toBe(SESSION_TITLE_FALLBACK);
    expect(deriveSessionTitle("{}")).toBe(SESSION_TITLE_FALLBACK);
    expect(deriveSessionTitle("[]")).toBe(SESSION_TITLE_FALLBACK);
    expect(deriveSessionTitle("")).toBe(SESSION_TITLE_FALLBACK);
    expect(deriveSessionTitle(null)).toBe(SESSION_TITLE_FALLBACK);
    expect(deriveSessionTitle(undefined)).toBe(SESSION_TITLE_FALLBACK);
  });
});

describe("countUserTurns (§26.9)", () => {
  it("counts only role === 'user' turns", () => {
    const turns = [
      { role: "system", content: "..." },
      { role: "user", text: "一" },
      { role: "assistant", text: "回应" },
      { role: "user", text: "二" },
      { role: "user", text: "三" },
    ];
    expect(countUserTurns(jsonOf(turns))).toBe(3);
  });

  it("is 0 when there are no user turns", () => {
    expect(countUserTurns(jsonOf([{ role: "assistant", text: "x" }]))).toBe(0);
  });

  it("is 0 on corrupt JSON / non-array / empty / null without throwing", () => {
    expect(countUserTurns("not json{{{")).toBe(0);
    expect(countUserTurns("{}")).toBe(0);
    expect(countUserTurns("[]")).toBe(0);
    expect(countUserTurns("")).toBe(0);
    expect(countUserTurns(null)).toBe(0);
    expect(countUserTurns(undefined)).toBe(0);
  });
});
