// router.ts — the app's ONE routing seam (第 6 步). Deliberately NOT react-router:
// the only split this app has is "public fill page vs the designer", so a pure
// pathname matcher is enough and adds zero deps. (package.json has no react-router;
// per the brief we stay lightweight and don't pull in a router library for a single
// /f/:slug branch.)
//
// Two concerns, both pure (no window/DOM/I/O) so they are trivially unit-testable and
// App can branch deterministically by injecting a pathname:
//   1. matchPublicForm(pathname) — recognise the public fill route /f/:slug and pull
//      out the slug. Everything else is the designer (returns null).
//   2. currentPathname() — the one impure read of window.location.pathname, isolated
//      here so App takes `pathname` as an injectable prop defaulting to this. Tests
//      pass an explicit pathname; production reads the real location once at mount.
//
// 路由分流约定 (App.jsx): at mount App resolves a `pathname` (prop, default
// currentPathname()). If matchPublicForm(pathname) returns a match → render ONLY
// <PublicFormPage slug=...> (the bare answerer view: no chat / preview / login /
// settings / publish chrome). Otherwise → render the existing designer App. The
// public page never mounts the designer surface and never holds an owner token.

/** The public fill-page path prefix (SPEC §16.4.1). A published form lives at /f/:slug. */
export const PUBLIC_FORM_PREFIX = "/f/";

/** A recognised public-fill route, carrying the slug parsed out of /f/:slug. */
export interface PublicFormRoute {
  slug: string;
}

/**
 * Match the public fill route (SPEC §16.4.1). Pure: given a pathname, return
 * `{ slug }` when it is `/f/:slug` with a non-empty single-segment slug, else `null`
 * (the designer route). Stub — see features/public-fill.feature「路由分流」.
 *
 * Contract the body must honour:
 *   - "/f/f8Kq2pXa"      → { slug: "f8Kq2pXa" }
 *   - "/f/f8Kq2pXa/"     → { slug: "f8Kq2pXa" }   (a single trailing slash is tolerated)
 *   - "/f/"  / "/f"      → null                    (no slug → not a public route)
 *   - "/f/a/b"           → null                    (slug is a single segment; deeper paths
 *                                                    are not the fill route)
 *   - "/"  / "/anything" → null                    (the designer)
 *   - the slug must be URL-decoded (decodeURIComponent) before being returned.
 */
export function matchPublicForm(pathname: string): PublicFormRoute | null {
  if (typeof pathname !== "string" || !pathname.startsWith(PUBLIC_FORM_PREFIX)) return null;
  // Strip the "/f/" prefix, then tolerate exactly one trailing slash.
  let rest = pathname.slice(PUBLIC_FORM_PREFIX.length);
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  // A slug is a single, non-empty path segment: no further "/" allowed, and not empty
  // ("/f/" / "/f/a/b" → not the fill route).
  if (rest === "" || rest.includes("/")) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(rest);
  } catch {
    // A malformed percent-encoding is not a usable slug → treat as the designer route.
    return null;
  }
  return { slug };
}

/**
 * The single impure read of the current path (window.location.pathname), isolated so
 * App can take an injectable `pathname` prop that defaults to this. In a non-browser /
 * test environment with no `window.location`, returns "/" (the designer) so render
 * never throws. Stub.
 */
export function currentPathname(): string {
  if (
    typeof window !== "undefined" &&
    window.location &&
    typeof window.location.pathname === "string"
  ) {
    return window.location.pathname;
  }
  return "/";
}
