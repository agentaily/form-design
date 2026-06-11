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
import { matchPublicForm, currentPathname, PUBLIC_FORM_PREFIX } from "../../src/core/router";

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
