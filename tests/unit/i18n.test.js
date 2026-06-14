// Inner-loop unit specs for src/core/i18n.ts — the minimal bilingual layer (中文 / English).
//
// Design (mirrors the Claude Design prototype's i18n.js, adapted to an ES module):
// translations live at the CALL SITE via `L("中文", "English")` — no key dictionary to
// drift. The locale is read once from localStorage at module load (so L() is a cheap,
// stable branch within a page session) and `setLocale` reloads the page to apply a switch
// cleanly. Default is "zh"; only an exact "en" flips. This keeps every existing zh string
// byte-identical by default, so threading L() through the app is non-breaking.
//
// This vitest/jsdom config provides NO `localStorage` global (it's undefined — which is
// why i18n wraps every access in try/catch). So, like chatSessionClient.test.js, each
// case installs its OWN fake `localStorage` BEFORE the dynamic import (the module reads
// the locale at load) and uses `vi.resetModules()` to re-probe the load-time read.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const KEY = "agentaily.locale.v1";

/** An in-memory fake `localStorage`; optionally seed the stored locale. */
function installFakeLocalStorage(seed) {
  const store = new Map();
  if (seed !== undefined) store.set(KEY, seed);
  const fake = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => void store.clear(),
  };
  vi.stubGlobal("localStorage", fake);
  return fake;
}

beforeEach(() => {
  vi.resetModules();
  document.documentElement.lang = "";
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("i18n · L(zh, en) at the call site", () => {
  it("returns the 中文 value by default (no stored locale)", async () => {
    installFakeLocalStorage();
    const { L, getLocale } = await import("../../src/core/i18n.ts");
    expect(getLocale()).toBe("zh");
    expect(L("保存", "Save")).toBe("保存");
  });

  it("returns the English value when the stored locale is en", async () => {
    installFakeLocalStorage("en");
    const { L, getLocale } = await import("../../src/core/i18n.ts");
    expect(getLocale()).toBe("en");
    expect(L("保存", "Save")).toBe("Save");
  });

  it("falls back to the 中文 value in en when no English is supplied", async () => {
    installFakeLocalStorage("en");
    const { L } = await import("../../src/core/i18n.ts");
    expect(L("Agentaily")).toBe("Agentaily");
  });

  it("passes through React nodes (not just strings), per active locale", async () => {
    installFakeLocalStorage("en");
    const { L } = await import("../../src/core/i18n.ts");
    const zh = { tag: "zh" };
    const en = { tag: "en" };
    expect(L(zh, en)).toBe(en);
  });

  it("treats any non-'en' stored value as zh (fail-safe)", async () => {
    installFakeLocalStorage("fr");
    const { getLocale, L } = await import("../../src/core/i18n.ts");
    expect(getLocale()).toBe("zh");
    expect(L("是", "yes")).toBe("是");
  });

  it("defaults to zh when localStorage is entirely unavailable", async () => {
    // No fake installed → bare `localStorage` is undefined → the try/catch falls to zh.
    const { getLocale } = await import("../../src/core/i18n.ts");
    expect(getLocale()).toBe("zh");
  });
});

describe("i18n · <html lang> reflection (a11y / autofill)", () => {
  it("reflects the active locale on document.documentElement.lang at load", async () => {
    installFakeLocalStorage("en");
    await import("../../src/core/i18n.ts");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("i18n · setLocale", () => {
  it("persists the new locale to localStorage", async () => {
    const fake = installFakeLocalStorage();
    const { setLocale } = await import("../../src/core/i18n.ts");
    setLocale("en");
    expect(fake.getItem(KEY)).toBe("en");
  });

  it("normalises an unknown locale to zh when persisting", async () => {
    const fake = installFakeLocalStorage("en");
    const { setLocale } = await import("../../src/core/i18n.ts");
    setLocale("fr");
    expect(fake.getItem(KEY)).toBe("zh");
  });

  it("is a no-op (no storage write) when the locale is unchanged", async () => {
    // Default load locale is zh; setting zh again must not touch storage.
    const fake = installFakeLocalStorage();
    const spy = vi.spyOn(fake, "setItem");
    const { setLocale } = await import("../../src/core/i18n.ts");
    setLocale("zh");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not throw when the environment cannot reload (jsdom)", async () => {
    installFakeLocalStorage();
    const { setLocale } = await import("../../src/core/i18n.ts");
    expect(() => setLocale("en")).not.toThrow();
  });
});
