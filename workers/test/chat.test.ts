// Inner-loop unit specs for the pure model helpers in chat.ts — the case-sensitive
// DeepSeek model id contract (SPEC.md §13.6). The OpenAI-compatible /chat/completions
// endpoint 400s on a camelCase display name or an unknown/wrong-cased id, so:
//   - DEEPSEEK_MODELS / DEFAULT_DEEPSEEK_MODEL MUST be the lowercase API ids.
//   - normalizeDeepSeekModel coerces any stored/forwarded value into a valid lowercase id
//     before it reaches upstream — the backstop for dirty owner config persisted as the old
//     camelCase display name (D1 may hold `deepseek_model = "DeepSeek-V4-Flash"`).
// The API-altitude behavior (proxy actually sends the normalized id upstream) is realized
// in chat-api.test.ts; here we pin the pure logic in isolation.
import { describe, it, expect } from "vitest";
import {
  DEEPSEEK_MODELS,
  DEFAULT_DEEPSEEK_MODEL,
  isDeepSeekModel,
  normalizeDeepSeekModel,
} from "../src/chat";

describe("chat · model id contract is lowercase (case-sensitive upstream)", () => {
  it("DEEPSEEK_MODELS are the lowercase API ids", () => {
    expect([...DEEPSEEK_MODELS]).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  it("DEFAULT_DEEPSEEK_MODEL is the lowercase flash id and is itself whitelisted", () => {
    expect(DEFAULT_DEEPSEEK_MODEL).toBe("deepseek-v4-flash");
    expect(isDeepSeekModel(DEFAULT_DEEPSEEK_MODEL)).toBe(true);
  });

  it("isDeepSeekModel accepts only the lowercase ids — NOT the camelCase display names", () => {
    expect(isDeepSeekModel("deepseek-v4-flash")).toBe(true);
    expect(isDeepSeekModel("deepseek-v4-pro")).toBe(true);
    // The camelCase display name is what 400'd — it is not a valid wire id.
    expect(isDeepSeekModel("DeepSeek-V4-Flash")).toBe(false);
    expect(isDeepSeekModel("DeepSeek-V4-Pro")).toBe(false);
  });
});

describe("chat · normalizeDeepSeekModel — coerce to a valid lowercase id before upstream", () => {
  it("passes a valid lowercase id through unchanged", () => {
    expect(normalizeDeepSeekModel("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(normalizeDeepSeekModel("deepseek-v4-pro")).toBe("deepseek-v4-pro");
  });

  it("maps the old camelCase DISPLAY names to their lowercase id (dirty D1 config backstop)", () => {
    // The whole point: an owner who saved "DeepSeek-V4-Pro" before the casing fix still works,
    // without re-saving config — the proxy lowercases it onto the whitelist.
    expect(normalizeDeepSeekModel("DeepSeek-V4-Flash")).toBe("deepseek-v4-flash");
    expect(normalizeDeepSeekModel("DeepSeek-V4-Pro")).toBe("deepseek-v4-pro");
    // any wrong casing lands on the id too.
    expect(normalizeDeepSeekModel("DEEPSEEK-V4-FLASH")).toBe("deepseek-v4-flash");
  });

  it("falls back to the default for retired ids / junk / non-strings", () => {
    expect(normalizeDeepSeekModel("deepseek-chat")).toBe(DEFAULT_DEEPSEEK_MODEL);
    expect(normalizeDeepSeekModel("deepseek-reasoner")).toBe(DEFAULT_DEEPSEEK_MODEL);
    expect(normalizeDeepSeekModel("gpt-4")).toBe(DEFAULT_DEEPSEEK_MODEL);
    expect(normalizeDeepSeekModel("")).toBe(DEFAULT_DEEPSEEK_MODEL);
    expect(normalizeDeepSeekModel(undefined)).toBe(DEFAULT_DEEPSEEK_MODEL);
    expect(normalizeDeepSeekModel(null)).toBe(DEFAULT_DEEPSEEK_MODEL);
    expect(normalizeDeepSeekModel(42)).toBe(DEFAULT_DEEPSEEK_MODEL);
  });
});
