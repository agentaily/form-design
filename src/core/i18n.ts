// i18n.ts — the minimal bilingual layer (中文 / English) for the whole app.
//
// Ported from the Claude Design handoff prototype's `i18n.js` (a plain global script),
// re-cast here as a framework-agnostic ES module so both the React app (.jsx) and the
// strict-TS core can consume it.
//
// Design — translations live at the CALL SITE, no key dictionary to drift:
//     L("中文", "English")
// returns the value for the active locale (a string, or any React node). The locale is
// read ONCE from localStorage at module load, so L() is a cheap, stable branch within a
// page session; `setLocale` writes the choice and reloads so the switch applies cleanly
// (no half-translated mid-page state). Default is "zh"; only an exact "en" flips — every
// existing 中文 string therefore stays byte-identical by default, making it safe to thread
// L() through the app without changing current behaviour.
//
// Exposes: `L`, `getLocale`, `setLocale`, `LOCALE`.

export type Locale = "zh" | "en";

const LOCALE_KEY = "agentaily.locale.v1";

/** Read the persisted locale, fail-safe to "zh" for anything that isn't exactly "en". */
function read(): Locale {
  try {
    return localStorage.getItem(LOCALE_KEY) === "en" ? "en" : "zh";
  } catch {
    // No storage (SSR / locked-down env) → the safe default.
    return "zh";
  }
}

// Cached at load: the active locale is stable for the life of this page (a switch reloads).
const CUR: Locale = read();

/** The active locale, captured at module load. */
export const LOCALE: Locale = CUR;

/**
 * The translation primitive. `L(zh, en)` returns the value for the active locale; `en`
 * falls back to `zh` when omitted. Generic so it carries strings AND React nodes through
 * unchanged — the call site decides the type.
 */
export function L<T>(zh: T, en?: T): T {
  if (CUR === "en") return en === undefined ? zh : en;
  return zh;
}

/** The active locale (function form, for call sites that prefer a getter). */
export function getLocale(): Locale {
  return CUR;
}

/**
 * Switch the locale: persist the choice and reload so it applies cleanly. A no-op when the
 * target equals the active locale (no storage write, no reload). Any value other than "en"
 * normalises to "zh". The reload is best-effort — it's swallowed where the host can't
 * navigate (e.g. jsdom under test), leaving the persisted choice to take effect on next load.
 */
export function setLocale(next: Locale | string): void {
  const v: Locale = next === "en" ? "en" : "zh";
  if (v === CUR) return;
  try {
    localStorage.setItem(LOCALE_KEY, v);
  } catch {
    // Storage unavailable — nothing more we can durably do.
  }
  reload();
}

/** Reflect the active locale on <html lang> for a11y / form autofill. Best-effort. */
function reflectLang(): void {
  try {
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = CUR;
    }
  } catch {
    // ignore — purely cosmetic.
  }
}

/** Best-effort full-page reload (swallowed where navigation is unimplemented). */
function reload(): void {
  try {
    if (typeof window !== "undefined" && window.location) window.location.reload();
  } catch {
    // jsdom: "Not implemented: navigation" — the persisted choice applies on next load.
  }
}

reflectLang();
