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

/** Drop the session token (stateless logout — §17.5 keeps no server-side blacklist). */
export function logout(): void {
  clearToken();
}

/** Whether an owner session token is currently held (presence-only, token stays opaque). */
export function isLoggedIn(): boolean {
  return !!getToken();
}
