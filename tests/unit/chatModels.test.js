// Unit specs for src/core/chatModels.ts — the conversation-level 模型(型号)选择器
// (SPEC §13.6 / §26.9, PR #65). Realizes the unit-altitude slice of
// features/chat-multi-session.feature 「对话级模型芯片」:
//   * isValidChatModel — sanitize an untrusted value (localStorage / chip) before it is
//     forwarded as POST /api/chat's per-request `model` (an unknown value would 400).
//   * chatModelPill — the collapsed pill text for a model value, with a default fallback
//     so a stale localStorage value never renders a blank chip.
import { describe, it, expect } from "vitest";
import {
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  isValidChatModel,
  chatModelPill,
} from "../../src/core/chatModels";

describe("chatModels · isValidChatModel", () => {
  it("returns true for every selectable model value (in lockstep with the backend whitelist)", () => {
    for (const m of CHAT_MODELS) {
      expect(isValidChatModel(m.value)).toBe(true);
    }
  });

  it("accepts the current shipping model ids — the lowercase API ids (deepseek-v4-flash / -pro)", () => {
    // The wire value is the case-sensitive lowercase API id (the camelCase 显示名 lives only on
    // label/pill); these are what the backend whitelist expects.
    expect(isValidChatModel("deepseek-v4-flash")).toBe(true);
    expect(isValidChatModel("deepseek-v4-pro")).toBe(true);
  });

  it("rejects the camelCase DISPLAY names — they 400 upstream, must never be forwarded", () => {
    // The original bug: the camelCase display name was sent as the wire `model` and 400'd.
    // It is NOT a valid wire value — only the lowercase id is.
    expect(isValidChatModel("DeepSeek-V4-Flash")).toBe(false);
    expect(isValidChatModel("DeepSeek-V4-Pro")).toBe(false);
  });

  it("returns false for an unknown / retired value (must NOT be forwarded — backend 400s)", () => {
    // the old retired ids and any junk are rejected.
    expect(isValidChatModel("deepseek-chat")).toBe(false);
    expect(isValidChatModel("deepseek-reasoner")).toBe(false);
    expect(isValidChatModel("gpt-4")).toBe(false);
    expect(isValidChatModel("")).toBe(false);
  });

  it("returns false for non-string candidates (untrusted localStorage / JSON noise)", () => {
    expect(isValidChatModel(null)).toBe(false);
    expect(isValidChatModel(undefined)).toBe(false);
    expect(isValidChatModel(42)).toBe(false);
    expect(isValidChatModel({})).toBe(false);
  });
});

describe("chatModels · chatModelPill", () => {
  it("returns the matching option's pill for a known value (looked up by the lowercase id)", () => {
    expect(chatModelPill("deepseek-v4-flash")).toBe("DeepSeek · V4-Flash");
    expect(chatModelPill("deepseek-v4-pro")).toBe("DeepSeek · V4-Pro");
  });

  it("falls back to the default model's pill for an unknown value (no blank chip on stale storage)", () => {
    const defaultPill = CHAT_MODELS.find((m) => m.value === DEFAULT_CHAT_MODEL).pill;
    expect(chatModelPill("deepseek-chat")).toBe(defaultPill);
    expect(chatModelPill("")).toBe(defaultPill);
    expect(chatModelPill(null)).toBe(defaultPill);
    expect(chatModelPill(undefined)).toBe(defaultPill);
    expect(chatModelPill(123)).toBe(defaultPill);
  });
});
