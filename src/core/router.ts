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

/** 找回密码 reset landing page (SPEC §24.5). The email link lands here at /reset-password?token=. */
export const RESET_PASSWORD_PATH = "/reset-password";

/** 邮箱验证 result landing page (SPEC §23.6). The backend confirm endpoint 302s here at /verify-email?status=. */
export const VERIFY_EMAIL_PATH = "/verify-email";

/** 独立登录页 (SPEC §17). Gated actions send a signed-out owner here at /signin?return=&reason=. */
export const SIGNIN_PATH = "/signin";

/** 集成设置页 (SPEC §12 + §14). The owner connects DeepSeek + 飞书 here at /settings. */
export const SETTINGS_PATH = "/settings";

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

/** A recognised /reset-password route, carrying the reset token read off the query. */
export interface ResetPasswordRoute {
  /** The plaintext one-time reset token from `?token=` ("" when missing — the page shows a hint). */
  token: string;
}

/** A recognised /verify-email route, carrying the backend-supplied result status. */
export interface VerifyEmailRoute {
  /** "ok" only when `?status=ok`; anything else (missing/unknown) normalises to "invalid" (fail-closed). */
  status: "ok" | "invalid";
}

/**
 * Is `pathname` exactly `target` (tolerating one trailing slash)? Shared by the two
 * auth landing matchers so "/reset-password" and "/reset-password/" both hit but
 * "/reset-password/extra" / "/reset" do not.
 */
function isExactPath(pathname: string, target: string): boolean {
  if (typeof pathname !== "string") return false;
  return pathname === target || pathname === target + "/";
}

/**
 * Match the 找回密码 reset landing route (SPEC §24.5). Pure: given the pathname and the
 * query string (e.g. window.location.search), return `{ token }` when the path is
 * `/reset-password` (one trailing slash tolerated), else `null` (the designer/public).
 * The token is read off `?token=` and URL-decoded; a missing/blank token yields
 * `{ token: "" }` so the landing page still mounts and renders its「链接无效」hint
 * (rather than falling through to the designer). The token is read from the URL only —
 * never persisted, never logged.
 */
export function matchResetPassword(pathname: string, search: string): ResetPasswordRoute | null {
  if (!isExactPath(pathname, RESET_PASSWORD_PATH)) return null;
  return { token: readQueryParam(search, "token") };
}

/**
 * Match the 邮箱验证 result landing route (SPEC §23.6). Pure: given the pathname and the
 * query string, return `{ status }` when the path is `/verify-email` (one trailing
 * slash tolerated), else `null`. `status` is "ok" ONLY when `?status=ok`; every other
 * value (missing / unknown) normalises to "invalid" — fail-closed, so the page never
 * claims 邮箱已验证 without an explicit `status=ok` from the backend redirect.
 */
export function matchVerifyEmail(pathname: string, search: string): VerifyEmailRoute | null {
  if (!isExactPath(pathname, VERIFY_EMAIL_PATH)) return null;
  return { status: readQueryParam(search, "status") === "ok" ? "ok" : "invalid" };
}

/** A recognised /signin route. The 「登录后续跑」 intent + return target are read off
 *  the query by the page itself (`reason` / `return`), so the match carries no params. */
export type SignInRoute = Record<string, never>;

/**
 * Match the 独立登录页 route (SPEC §17). Pure: return `{}` when the path is `/signin`
 * (one trailing slash tolerated), else `null` (the designer/public). The standalone
 * sign-in page mounts <SignInScreen>, which reads `?return=` / `?reason=` itself.
 */
export function matchSignIn(pathname: string): SignInRoute | null {
  return isExactPath(pathname, SIGNIN_PATH) ? {} : null;
}

/** The two settings tabs reflected into the URL (`/settings/:tab`, PR #76). */
export type SettingsSection = "account" | "integrations";

/** A recognised /settings route, carrying the active tab parsed from `/settings/:tab` (PR #76). */
export interface SettingsRoute {
  /** The active tab; bare `/settings` (no tab segment) defaults to "integrations". */
  section: SettingsSection;
}

/**
 * Match the 设置 route (SPEC §12 + §14 + §17, tab reflected per PR #76). Pure: return
 * `{ section }` for `/settings` (→ default "integrations"), `/settings/account`, or
 * `/settings/integrations` (one trailing slash tolerated on each), else `null`. An unknown
 * sub-segment (`/settings/foo`) or a deeper path is NOT a settings route → `null`, so a
 * typo'd deep-link degrades to the designer rather than a half-open overlay.
 *
 * Since DS 0.8.0 设置 is a floating overlay (<SettingsOverlay>) DesignerApp opens over itself,
 * reflecting a `/settings/:tab` URL via history WITHOUT unmounting the designer. So App does NOT
 * branch its route split on this; DesignerApp uses the match only to pick the overlay's initial
 * open state + tab (deep-link) and to keep the overlay's tab in sync with Back/Forward.
 */
export function matchSettings(pathname: string): SettingsRoute | null {
  if (typeof pathname !== "string") return null;
  // Normalise exactly one trailing slash (but never the root "/settings" itself away).
  let p = pathname;
  if (p.length > SETTINGS_PATH.length && p.endsWith("/")) p = p.slice(0, -1);
  if (p === SETTINGS_PATH) return { section: "integrations" };
  if (p === `${SETTINGS_PATH}/account`) return { section: "account" };
  if (p === `${SETTINGS_PATH}/integrations`) return { section: "integrations" };
  return null;
}

/**
 * Build the `/settings/:tab` path reflecting a tab (PR #76): `/settings/account` or
 * `/settings/integrations`. Pure; round-trips through {@link matchSettings}. App pushes/
 * replaces this (preserving any `?s=` session query) when opening settings or switching tabs.
 */
export function settingsPath(section: SettingsSection): string {
  return section === "account" ? `${SETTINGS_PATH}/account` : `${SETTINGS_PATH}/integrations`;
}

/**
 * Query param carrying the active design-session id on the designer route (PR #76). The value
 * is the §26.2 client-minted stable session id, so a refresh / deep-link / shared link restores
 * the same conversation + workspace. `?s=` is orthogonal to the `/settings/:tab` path (both can
 * coexist, e.g. `/settings/integrations?s=<id>`).
 */
export const SESSION_PARAM = "s";

/**
 * Read the active design-session id off a search string (`?s=<id>`), URL-decoded and trimmed;
 * "" when absent / blank / whitespace-only / malformed (the caller then falls back to the
 * getOrCreate session id, §26.2). Pure.
 */
export function readSessionId(search: string): string {
  return readQueryParam(search, SESSION_PARAM).trim();
}

/**
 * Return a new search string (leading "?", or "" when empty) that reflects `sessionId` in the
 * `s` param while PRESERVING every other param already in `search`. A blank `sessionId` removes
 * the param (and may yield ""). Pure — App uses it to build the URL it push/replaces so the rest
 * of the query (if any) survives.
 */
export function withSessionId(search: string, sessionId: string): string {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(
      typeof search === "string" && search.startsWith("?") ? search.slice(1) : search || "",
    );
  } catch {
    params = new URLSearchParams();
  }
  if (sessionId) params.set(SESSION_PARAM, sessionId);
  else params.delete(SESSION_PARAM);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Read a single query parameter (URL-decoded) out of a search string like
 * "?token=abc&x=1", returning "" when absent or malformed. Uses URLSearchParams so
 * decoding + multi-param parsing is correct without hand-rolling it.
 */
function readQueryParam(search: string, key: string): string {
  if (typeof search !== "string" || search === "") return "";
  try {
    return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get(key) ?? "";
  } catch {
    return "";
  }
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

/**
 * The single impure read of the current query string (window.location.search,
 * including the leading "?"), isolated next to {@link currentPathname} so App can take
 * an injectable `search` prop that defaults to this. In a non-browser / test
 * environment with no `window.location`, returns "" so render never throws.
 */
export function currentSearch(): string {
  if (
    typeof window !== "undefined" &&
    window.location &&
    typeof window.location.search === "string"
  ) {
    return window.location.search;
  }
  return "";
}
