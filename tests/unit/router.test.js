// Unit specs for src/core/router.ts — the app's ONE routing seam (第 6 步, SPEC
// §16.4.1). matchPublicForm is a PURE pathname matcher: /f/:slug → { slug }, every
// other path → null (the designer). currentPathname is the one impure read of
// window.location.pathname, isolated so App can inject a pathname prop.
//
// These bind the contract the stub's docblock fixes:
//   - "/f/f8Kq2pXa"      → { slug: "f8Kq2pXa" }
//   - "/f/f8Kq2pXa/"     → { slug: "f8Kq2pXa" }   (a single trailing slash tolerated)
//   - "/f/"  / "/f"      → null                    (no slug → not a public route)
//   - "/f/a/b"           → null                    (slug is a single segment)
//   - "/"  / "/anything" → null                    (the designer)
//   - the slug is URL-decoded before being returned.
// The route-split BEHAVIOR (App renders PublicFormPage vs the designer) is pinned at
// the integration level in tests/integration/public-fill.spec.jsx.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  matchPublicForm,
  matchResetPassword,
  matchVerifyEmail,
  matchSettings,
  settingsPath,
  readSessionId,
  withSessionId,
  readProjectId,
  projectBasePath,
  currentPathname,
  currentSearch,
  PUBLIC_FORM_PREFIX,
  PROJECT_PREFIX,
  RESET_PASSWORD_PATH,
  VERIFY_EMAIL_PATH,
  SETTINGS_PATH,
  SESSION_PARAM,
} from "../../src/core/router";

describe("router · PUBLIC_FORM_PREFIX", () => {
  it("is the contract-fixed /f/ prefix (SPEC §16.4.1)", () => {
    expect(PUBLIC_FORM_PREFIX).toBe("/f/");
  });
});

describe("router · matchPublicForm — recognises /f/:slug", () => {
  it("pulls the slug out of /f/:slug", () => {
    expect(matchPublicForm("/f/f8Kq2pXa")).toEqual({ slug: "f8Kq2pXa" });
  });

  it("tolerates a single trailing slash (/f/:slug/)", () => {
    expect(matchPublicForm("/f/f8Kq2pXa/")).toEqual({ slug: "f8Kq2pXa" });
  });

  it("URL-decodes the slug (decodeURIComponent) before returning it", () => {
    // A slug carrying a percent-encoded byte must come back decoded, never raw.
    expect(matchPublicForm("/f/a%20b")).toEqual({ slug: "a b" });
    expect(matchPublicForm("/f/%E6%B4%BB%E5%8A%A8")).toEqual({ slug: "活动" });
  });
});

describe("router · matchPublicForm — the designer (null) cases", () => {
  it("returns null for the root path", () => {
    expect(matchPublicForm("/")).toBeNull();
  });

  it("returns null for any other top-level path", () => {
    expect(matchPublicForm("/anything")).toBeNull();
    expect(matchPublicForm("/forms")).toBeNull();
  });

  it("returns null for the bare prefix with no slug (/f/ and /f)", () => {
    expect(matchPublicForm("/f/")).toBeNull();
    expect(matchPublicForm("/f")).toBeNull();
  });

  it("returns null for a deeper, multi-segment path under /f/ (slug is one segment)", () => {
    // "/f/a/b" is NOT the single-segment fill route — it must not be treated as a form.
    expect(matchPublicForm("/f/a/b")).toBeNull();
  });

  it("does not treat a path that merely starts with /f as a form route", () => {
    // "/foo" shares the "/f" character prefix but is a different segment → the designer.
    expect(matchPublicForm("/foo")).toBeNull();
    expect(matchPublicForm("/features")).toBeNull();
  });
});

describe("router · auth landing paths (SPEC §23.6 / §24.5)", () => {
  it("exposes the contract-fixed landing paths", () => {
    expect(RESET_PASSWORD_PATH).toBe("/reset-password");
    expect(VERIFY_EMAIL_PATH).toBe("/verify-email");
  });
});

describe("router · matchResetPassword — recognises /reset-password?token=", () => {
  it("matches the reset path and pulls the token from the search string", () => {
    expect(matchResetPassword("/reset-password", "?token=abc123")).toEqual({ token: "abc123" });
  });

  it("URL-decodes the token", () => {
    expect(matchResetPassword("/reset-password", "?token=a%20b")).toEqual({ token: "a b" });
  });

  it("tolerates a single trailing slash", () => {
    expect(matchResetPassword("/reset-password/", "?token=abc")).toEqual({ token: "abc" });
  });

  it("returns a match with an empty token when the token query is missing (page shows a readable hint)", () => {
    // A missing/blank token still resolves to the reset landing page (not the
    // designer); the page itself renders the「链接无效」hint. The match carries "".
    expect(matchResetPassword("/reset-password", "")).toEqual({ token: "" });
    expect(matchResetPassword("/reset-password", "?foo=bar")).toEqual({ token: "" });
  });

  it("returns null for any other path (the designer / public form)", () => {
    expect(matchResetPassword("/", "?token=abc")).toBeNull();
    expect(matchResetPassword("/reset", "?token=abc")).toBeNull();
    expect(matchResetPassword("/reset-password/extra", "?token=abc")).toBeNull();
    expect(matchResetPassword("/f/abc", "")).toBeNull();
  });
});

describe("router · matchVerifyEmail — recognises /verify-email?status=", () => {
  it("matches the verify path and pulls the status (ok / invalid)", () => {
    expect(matchVerifyEmail("/verify-email", "?status=ok")).toEqual({ status: "ok" });
    expect(matchVerifyEmail("/verify-email", "?status=invalid")).toEqual({ status: "invalid" });
  });

  it("tolerates a single trailing slash", () => {
    expect(matchVerifyEmail("/verify-email/", "?status=ok")).toEqual({ status: "ok" });
  });

  it("normalises a missing/unknown status to 'invalid' (fail-closed)", () => {
    // The page only knows two outcomes; anything that is not the literal 'ok' is
    // treated as the failure copy — never claim 已验证 without a 'status=ok'.
    expect(matchVerifyEmail("/verify-email", "")).toEqual({ status: "invalid" });
    expect(matchVerifyEmail("/verify-email", "?status=weird")).toEqual({ status: "invalid" });
  });

  it("returns null for any other path", () => {
    expect(matchVerifyEmail("/", "?status=ok")).toBeNull();
    expect(matchVerifyEmail("/verify", "?status=ok")).toBeNull();
    expect(matchVerifyEmail("/verify-email/extra", "")).toBeNull();
  });
});

describe("router · matchSettings — recognises /settings/:tab (SPEC §12 + §14, tab per PR #76)", () => {
  it("exposes the contract-fixed settings path", () => {
    expect(SETTINGS_PATH).toBe("/settings");
  });

  it("matches bare /settings, defaulting to the 集成 tab", () => {
    // 裸 /settings 退化为默认 tab（集成），与 App 的默认 section 一致。
    expect(matchSettings("/settings")).toEqual({ section: "integrations" });
  });

  it("parses the active tab out of /settings/:tab", () => {
    expect(matchSettings("/settings/account")).toEqual({ section: "account" });
    expect(matchSettings("/settings/integrations")).toEqual({ section: "integrations" });
  });

  it("tolerates a single trailing slash on bare /settings and on /settings/:tab", () => {
    expect(matchSettings("/settings/")).toEqual({ section: "integrations" });
    expect(matchSettings("/settings/account/")).toEqual({ section: "account" });
  });

  it("returns null for an unknown tab segment or a deeper path (degrade to the designer)", () => {
    // 未知 tab 段或更深路径不是设置路由 → null（退化到设计器，不半开浮层）。
    expect(matchSettings("/settings/extra")).toBeNull();
    expect(matchSettings("/settings/account/extra")).toBeNull();
  });

  it("returns null for any other path (the designer / public / other routes)", () => {
    expect(matchSettings("/")).toBeNull();
    expect(matchSettings("/setting")).toBeNull();
    expect(matchSettings("/signin")).toBeNull();
    expect(matchSettings("/f/abc")).toBeNull();
  });
});

describe("router · PROJECT_PREFIX / readProjectId / projectBasePath (A' §26.10)", () => {
  it("PROJECT_PREFIX is the contract-fixed /p/ prefix", () => {
    expect(PROJECT_PREFIX).toBe("/p/");
  });

  it("reads the project id out of /p/:id", () => {
    expect(readProjectId("/p/pj-1aaaa-uuid")).toBe("pj-1aaaa-uuid");
  });

  it("reads the project id even when the settings overlay nests under it (/p/:id/settings/:tab)", () => {
    expect(readProjectId("/p/pj-x/settings/account")).toBe("pj-x");
    expect(readProjectId("/p/pj-x/settings")).toBe("pj-x");
  });

  it("URL-decodes the project-id segment", () => {
    expect(readProjectId("/p/a%2Fb")).toBe("a/b");
  });

  it("returns '' for non-project paths (bare /, legacy /settings, public, malformed)", () => {
    expect(readProjectId("/")).toBe("");
    expect(readProjectId("/settings/account")).toBe("");
    expect(readProjectId("/f/abc")).toBe("");
    expect(readProjectId("/p/")).toBe("");
    expect(readProjectId("/p/%")).toBe(""); // malformed percent-encoding → degrade to ""
  });

  it("projectBasePath builds /p/:id and round-trips through readProjectId", () => {
    expect(projectBasePath("pj-1")).toBe("/p/pj-1");
    expect(readProjectId(projectBasePath("pj-1aaaa-uuid"))).toBe("pj-1aaaa-uuid");
    // an id needing encoding round-trips too.
    expect(readProjectId(projectBasePath("a/b"))).toBe("a/b");
  });
});

describe("router · matchSettings nests under the project (/p/:id/settings/:tab, A')", () => {
  it("recognises settings nested under a project path", () => {
    expect(matchSettings("/p/pj-1/settings")).toEqual({ section: "integrations" });
    expect(matchSettings("/p/pj-1/settings/account")).toEqual({ section: "account" });
    expect(matchSettings("/p/pj-1/settings/integrations")).toEqual({ section: "integrations" });
  });

  it("a bare /p/:id (no settings sub-path) is the designer, NOT a settings route", () => {
    expect(matchSettings("/p/pj-1")).toBeNull();
    expect(matchSettings("/p/pj-1/")).toBeNull();
  });

  it("still recognises the legacy bare /settings/:tab (backward-compatible)", () => {
    expect(matchSettings("/settings")).toEqual({ section: "integrations" });
    expect(matchSettings("/settings/account")).toEqual({ section: "account" });
  });

  it("an unknown sub-segment under the project is not a settings route", () => {
    expect(matchSettings("/p/pj-1/settings/extra")).toBeNull();
    expect(matchSettings("/p/pj-1/foo")).toBeNull();
  });
});

describe("router · settingsPath — build the settings path for a tab (PR #76 + A')", () => {
  it("builds the bare /settings/:tab when no project is given (legacy fallback)", () => {
    expect(settingsPath("account")).toBe("/settings/account");
    expect(settingsPath("integrations")).toBe("/settings/integrations");
  });

  it("nests under the project when a projectId is given (A': /p/:id/settings/:tab)", () => {
    expect(settingsPath("account", "pj-1")).toBe("/p/pj-1/settings/account");
    expect(settingsPath("integrations", "pj-1")).toBe("/p/pj-1/settings/integrations");
  });

  it("round-trips through matchSettings (both bare and project-nested)", () => {
    expect(matchSettings(settingsPath("account"))).toEqual({ section: "account" });
    expect(matchSettings(settingsPath("integrations"))).toEqual({ section: "integrations" });
    expect(matchSettings(settingsPath("account", "pj-1"))).toEqual({ section: "account" });
    expect(matchSettings(settingsPath("integrations", "pj-1"))).toEqual({
      section: "integrations",
    });
  });
});

describe("router · readSessionId / withSessionId — design session in ?s= (PR #76, §26.2)", () => {
  it("exposes the contract-fixed session query param", () => {
    expect(SESSION_PARAM).toBe("s");
  });

  it("reads the session id off ?s=<id>", () => {
    expect(readSessionId("?s=ds-abc123")).toBe("ds-abc123");
  });

  it("URL-decodes the session id and preserves other params", () => {
    expect(readSessionId("?foo=1&s=a%20b&bar=2")).toBe("a b");
  });

  it("returns '' when ?s= is absent, blank, or the search is empty", () => {
    expect(readSessionId("")).toBe("");
    expect(readSessionId("?foo=bar")).toBe("");
    expect(readSessionId("?s=")).toBe("");
    expect(readSessionId("?s=%20%20")).toBe(""); // whitespace-only → blank
  });

  it("sets ?s=<id> while preserving every other query param", () => {
    expect(withSessionId("?foo=1&bar=2", "ds-new")).toBe("?foo=1&bar=2&s=ds-new");
  });

  it("replaces an existing ?s= value in place", () => {
    expect(withSessionId("?s=old&foo=1", "new")).toBe("?s=new&foo=1");
  });

  it("adds ?s= to an empty search", () => {
    expect(withSessionId("", "ds-x")).toBe("?s=ds-x");
  });

  it("removes the param (and may yield '') when the id is blank", () => {
    expect(withSessionId("?s=old&foo=1", "")).toBe("?foo=1");
    expect(withSessionId("?s=old", "")).toBe("");
  });

  it("round-trips: readSessionId(withSessionId(search, id)) === id", () => {
    expect(readSessionId(withSessionId("?foo=1", "ds-rt"))).toBe("ds-rt");
  });
});

describe("router · currentSearch — the one impure read of the query string", () => {
  const realLocation = window.location;
  afterEach(() => {
    Object.defineProperty(window, "location", { value: realLocation, configurable: true });
  });

  it("reads window.location.search when present", () => {
    Object.defineProperty(window, "location", {
      value: { pathname: "/reset-password", search: "?token=xyz" },
      configurable: true,
    });
    expect(currentSearch()).toBe("?token=xyz");
    expect(matchResetPassword(currentPathname(), currentSearch())).toEqual({ token: "xyz" });
  });
});

describe("router · currentPathname — the one impure read", () => {
  const realLocation = window.location;
  afterEach(() => {
    // restore window.location after any per-test override
    Object.defineProperty(window, "location", { value: realLocation, configurable: true });
    vi.unstubAllGlobals();
  });

  it("reads window.location.pathname when a browser location is present", () => {
    Object.defineProperty(window, "location", {
      value: { pathname: "/f/f8Kq2pXa" },
      configurable: true,
    });
    expect(currentPathname()).toBe("/f/f8Kq2pXa");
  });

  it("rounds-trips through matchPublicForm: a /f/:slug location resolves to that slug", () => {
    Object.defineProperty(window, "location", {
      value: { pathname: "/f/abc123" },
      configurable: true,
    });
    expect(matchPublicForm(currentPathname())).toEqual({ slug: "abc123" });
  });
});
