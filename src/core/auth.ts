// auth.ts — owner session, frontend side of SPEC §17. One public endpoint
// (`POST /api/auth/login`, the auth entry that carries NO Bearer itself): owner
// password → session JWT, stashed in apiClient's token store so every owner-only
// request (§17.1) can attach `Authorization: Bearer <jwt>`. Logout just drops the
// token (stateless — no server-side revocation per §17.3). The token is opaque to
// the frontend: we never decode it, only present/absent → logged-in/out.

import { apiFetch, setToken, clearToken, getToken } from "./apiClient";

interface LoginResponse {
  token: string;
}

/**
 * Log in with the owner password (§17.2). On success persists the session token
 * via {@link setToken} so subsequent owner-only calls authenticate. A wrong/missing
 * password surfaces as a 401 {@link ApiError} (the backend returns a unified 401,
 * §17.7) — rethrown untouched for the caller to show. A 2xx without a usable token
 * is treated as a protocol error (nothing is stored).
 */
export async function login(password: string): Promise<void> {
  const res = await apiFetch<LoginResponse>("/api/auth/login", { body: { password } });
  if (!res || typeof res.token !== "string" || !res.token) {
    throw new Error("登录响应缺少 token");
  }
  setToken(res.token);
}

/** Drop the session token (stateless logout — §17.3 keeps no server-side blacklist). */
export function logout(): void {
  clearToken();
}

/** Whether an owner session token is currently held (presence-only, token stays opaque). */
export function isLoggedIn(): boolean {
  return !!getToken();
}
