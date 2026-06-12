// auth.ts — owner session, frontend side of SPEC §17 (multi-user). Two public
// endpoints (the auth entries, which carry NO Bearer themselves):
//   - POST /api/auth/register — 注册即登录（§17.2）
//   - POST /api/auth/login    — 邮箱 + 密码 → token（§17.3）
// Both return `{ token }` whose `sub` is the owner's real user id; we stash it in
// apiClient's token store so every owner-only request (§17.1) can attach
// `Authorization: Bearer <jwt>` and the backend filters data by that owner (§17.9).
// Logout just drops the token (stateless — no server-side revocation per §17.5).
// The token is opaque to the frontend: we never decode it, only present/absent →
// logged-in/out. A 409 (register) means 邮箱已注册; a 401 (login) means 账号或密码错
// (the backend returns a unified 401 that does NOT distinguish 邮箱不存在 vs 密码错,
// §17.3) — both surface as the {@link ApiError} thrown by apiFetch for the caller
// (LoginDialog) to map to a readable message.

import { apiFetch, setToken, clearToken, getToken } from "./apiClient";

/** Success body of register (201) / login (200): only the session token (§17.2 / §17.3). */
interface AuthResponse {
  token: string;
}

/** The authoritative current-owner snapshot from `GET /api/auth/me` (§23.6). */
export interface CurrentUser {
  /** The owner's email (informational; the frontend never decodes the token for it). */
  email: string;
  /** Whether the owner has confirmed their email — the SOLE source of the 未验证 banner. */
  emailVerified: boolean;
}

/**
 * Register a new owner with email + password (§17.2). Open registration: any
 * valid email + password (≥ 8 chars) self-registers and is **immediately logged
 * in** — on success persists the returned session token via {@link setToken} (same
 * as login). A taken email surfaces as a 409 {@link ApiError}; an invalid email /
 * weak password (< 8) surfaces as a 400 {@link ApiError} — both rethrown untouched
 * for the caller (LoginDialog) to show. A 2xx without a usable token is a protocol
 * error (nothing is stored).
 *
 * Request body: `{ email, password }`. Plaintext password only ever leaves the
 * browser to this register call; it is never stored client-side.
 */
export async function register(email: string, password: string): Promise<void> {
  const res = await apiFetch<AuthResponse>("/api/auth/register", {
    body: { email, password },
  });
  if (!res || typeof res.token !== "string" || !res.token) {
    throw new Error("注册响应缺少 token");
  }
  setToken(res.token);
}

/**
 * Log in with email + password (§17.3). On success persists the session token via
 * {@link setToken} so subsequent owner-only calls authenticate as this owner. A
 * wrong email/password surfaces as a **unified 401** {@link ApiError} (the backend
 * does NOT distinguish 邮箱不存在 vs 密码错, §17.3) — rethrown untouched for the
 * caller to show as 账号或密码错. A 2xx without a usable token is a protocol error
 * (nothing is stored).
 *
 * Request body: `{ email, password }`.
 */
export async function login(email: string, password: string): Promise<void> {
  const res = await apiFetch<AuthResponse>("/api/auth/login", {
    body: { email, password },
  });
  if (!res || typeof res.token !== "string" || !res.token) {
    throw new Error("登录响应缺少 token");
  }
  setToken(res.token);
}

/**
 * Start the 找回密码 flow (§24.1, public): POST `{ email }` to
 * `/api/auth/password-reset/request`. The backend **always** answers 200 with a
 * neutral body — whether or not the email is registered — so the UI can never
 * enumerate accounts. This wrapper goes one step further and **always resolves**:
 * even a network failure or a non-200 hiccup is swallowed, so the caller shows the
 * SAME neutral copy「若该邮箱已注册，我们已发送重置链接」in every case and never
 * leaks a different outcome. No Bearer (the user is logged out by definition).
 */
export async function requestPasswordReset(email: string): Promise<void> {
  try {
    await apiFetch("/api/auth/password-reset/request", { body: { email } });
  } catch {
    // Anti-enumeration: swallow everything so the caller's neutral copy is uniform.
  }
}

/**
 * Finish 找回密码 (§24.3, public): POST `{ token, password }` to
 * `/api/auth/password-reset/confirm`. On 200 the password is reset (the reset token
 * is consumed) — this stores **no** session token; the user re-logs in afterwards.
 * A 400 {@link ApiError} means the link is 失效 / 过期 / 已用 **or** the new password
 * is 过弱 (the backend returns a unified 400 that does not distinguish them, §24.3) —
 * rethrown untouched for the caller (the reset landing page) to show. No Bearer.
 *
 * The plaintext `password` only ever leaves the browser to this confirm call; it is
 * never stored client-side.
 */
export async function confirmPasswordReset(token: string, password: string): Promise<void> {
  await apiFetch("/api/auth/password-reset/confirm", { body: { token, password } });
}

/**
 * Resend the verification email for the **current** logged-in owner (§23.3,
 * owner-only): POST `/api/auth/verify-email/request` with the owner's Bearer. The
 * backend addresses the email by the session `sub` (never a body email), so this
 * call carries no payload. It **always succeeds** when authenticated (already
 * verified → no-op 200/204; unverified → sends; send failure is swallowed
 * server-side) — so a resolve means「已重新发送」for the UI's neutral feedback. A
 * missing / expired session surfaces as a 401 {@link ApiError} for the caller to
 * route into login (§23.3).
 */
export async function requestEmailVerification(): Promise<void> {
  await apiFetch("/api/auth/verify-email/request", { method: "POST", auth: true });
}

/**
 * Read the **authoritative** current-owner snapshot (§23.6, owner-only): GET
 * `/api/auth/me` with the owner's Bearer → `{ email, emailVerified }`. This is the
 * single source of truth for the 邮箱未验证 banner — it makes the banner correct
 * across reloads and on a plain 登录 (not just a fresh 注册), where the login
 * response carries no verified bit.
 *
 * Degradation is **fail-soft to null**: a missing/expired session (401), any other
 * non-2xx hiccup, or a network failure all resolve to `null` rather than throw, so a
 * transient backend problem never crashes the shell and merely leaves the banner in
 * its (optimistic) default state. `emailVerified` is coerced to a strict boolean so a
 * 0/1 from the backend's SQLite-backed schema can't leak a truthy-number into the UI.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  let res: { email?: unknown; emailVerified?: unknown } | undefined;
  try {
    res = await apiFetch("/api/auth/me", { auth: true });
  } catch {
    // 401 (会话失效 / 无 token) and any network/backend hiccup → null; the banner
    // simply keeps its optimistic default rather than surfacing an error.
    return null;
  }
  if (!res || typeof res.email !== "string") return null;
  return { email: res.email, emailVerified: !!res.emailVerified };
}

/** Drop the session token (stateless logout — §17.5 keeps no server-side blacklist). */
export function logout(): void {
  clearToken();
}

/** Whether an owner session token is currently held (presence-only, token stays opaque). */
export function isLoggedIn(): boolean {
  return !!getToken();
}
