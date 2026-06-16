import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  login,
  register,
  logout,
  isLoggedIn,
  requestPasswordReset,
  confirmPasswordReset,
  requestEmailVerification,
  getCurrentUser,
  validateSession,
  updateProfile,
} from "../../src/core/auth";
import { getToken, setToken, clearToken } from "../../src/core/apiClient";

// Inner-loop unit specs for src/core/auth — the frontend session seam (SPEC §17,
// multi-user). login / register both POST { email, password } and stash the
// returned token; logout drops it. A 409 (register, 邮箱已注册) / a unified 401
// (login, 账号或密码错) propagate as ApiError for LoginDialog to map to a message.

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  clearToken();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearToken();
});

describe("auth · login", () => {
  it("POSTs { email, password } to /api/auth/login and stores the returned token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ token: "jwt-xyz" }));
    vi.stubGlobal("fetch", fetchMock);

    await login("owner@example.com", "hunter2pw");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ email: "owner@example.com", password: "hunter2pw" });
    expect(getToken()).toBe("jwt-xyz");
  });

  it("does not attach a Bearer header (login is the public auth entry)", async () => {
    setToken("stale-token");
    const fetchMock = vi.fn(async () => jsonResponse({ token: "fresh" }));
    vi.stubGlobal("fetch", fetchMock);

    await login("owner@example.com", "pw12345678");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBeUndefined();
  });

  it("propagates a unified 401 ApiError on a wrong email/password and leaves no token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(login("owner@example.com", "wrong")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
    expect(getToken()).toBeNull();
  });

  it("throws (and stores nothing) when the response carries no token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(login("owner@example.com", "pw12345678")).rejects.toThrow();
    expect(getToken()).toBeNull();
  });
});

describe("auth · register", () => {
  it("POSTs { email, password } to /api/auth/register and stores the returned token (注册即登录)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ token: "jwt-new" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await register("new@example.com", "strong-password");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/register");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      email: "new@example.com",
      password: "strong-password",
    });
    // 注册即登录: the token is stored just like login.
    expect(getToken()).toBe("jwt-new");
  });

  it("propagates a 409 ApiError (邮箱已注册) and leaves no token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "邮箱已注册" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(register("taken@example.com", "strong-password")).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
    });
    expect(getToken()).toBeNull();
  });

  it("propagates a 400 ApiError (弱密码 / 非法邮箱) and leaves no token", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "password too weak" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(register("new@example.com", "short")).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
    });
    expect(getToken()).toBeNull();
  });

  it("throws (and stores nothing) when the 2xx response carries no token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(register("new@example.com", "strong-password")).rejects.toThrow();
    expect(getToken()).toBeNull();
  });
});

describe("auth · requestPasswordReset (§24.1 — 公开发起，防枚举)", () => {
  it("POSTs { email } to /api/auth/password-reset/request and resolves on 200", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await requestPasswordReset("owner@example.com");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/password-reset/request");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ email: "owner@example.com" });
  });

  it("does not attach a Bearer header (the request entry is public, even if a stale token exists)", async () => {
    setToken("stale-token");
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await requestPasswordReset("owner@example.com");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBeUndefined();
  });

  it("resolves (never rejects) so the neutral copy is shown even on a backend hiccup (anti-enumeration)", async () => {
    // The backend contract is 永远 200; but if the network/backend misbehaves the
    // UI must still show the SAME neutral copy and never leak a different outcome.
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestPasswordReset("owner@example.com")).resolves.toBeUndefined();
  });

  it("resolves even when fetch itself rejects (offline)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestPasswordReset("owner@example.com")).resolves.toBeUndefined();
  });
});

describe("auth · confirmPasswordReset (§24.3 — 凭一次性 reset token 改密)", () => {
  it("POSTs { token, password } to /api/auth/password-reset/confirm and resolves on 200", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await confirmPasswordReset("reset-token-abc", "brand-new-pass");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/password-reset/confirm");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      token: "reset-token-abc",
      password: "brand-new-pass",
    });
  });

  it("does not store any token on success (reset ≠ login; the user re-logs in)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await confirmPasswordReset("reset-token-abc", "brand-new-pass");
    expect(getToken()).toBeNull();
  });

  it("propagates a 400 ApiError (链接失效 / 过期 / 已用 / 弱密码) for the UI to map", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "invalid or expired token" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(confirmPasswordReset("dead-token", "brand-new-pass")).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
    });
  });
});

describe("auth · requestEmailVerification (§23.3 — owner-only 重发)", () => {
  it("POSTs to /api/auth/verify-email/request WITH a Bearer header (owner-only)", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await requestEmailVerification();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/verify-email/request");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer owner-jwt");
  });

  it("resolves on an empty 204 (already verified → no-op, §23.3)", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestEmailVerification()).resolves.toBeUndefined();
  });

  it("propagates a 401 ApiError (会话失效 → 引导先登录, §23.3)", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestEmailVerification()).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });
});

describe("auth · getCurrentUser (§23.6 — 读真实验证状态)", () => {
  it("GETs /api/auth/me WITH a Bearer header (owner-only) and returns { email, emailVerified }", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ email: "owner@example.com", emailVerified: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const me = await getCurrentUser();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/me");
    expect(init.method).toBe("GET");
    expect(init.headers.authorization).toBe("Bearer owner-jwt");
    // displayName defaults to null when the backend omits it (account never named).
    expect(me).toEqual({ email: "owner@example.com", emailVerified: false, displayName: null });
  });

  it("returns emailVerified=true when the backend says the email is verified", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ email: "owner@example.com", emailVerified: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentUser()).resolves.toEqual({
      email: "owner@example.com",
      emailVerified: true,
      displayName: null,
    });
  });

  it("surfaces the owner's displayName when the backend returns one (§17 个人资料)", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ email: "owner@example.com", emailVerified: true, displayName: "陈伟" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentUser()).resolves.toEqual({
      email: "owner@example.com",
      emailVerified: true,
      displayName: "陈伟",
    });
  });

  it("coerces emailVerified to a strict boolean (backend may send 0/1, §23 schema)", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ email: "owner@example.com", emailVerified: 0 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const me = await getCurrentUser();
    expect(me).toEqual({ email: "owner@example.com", emailVerified: false, displayName: null });
    expect(me.emailVerified).toBe(false);
  });

  it("resolves to null on a 401 (会话失效 / 无 token) instead of throwing — banner just stays off", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("resolves to null on a network failure (offline) instead of throwing", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("resolves to null on any non-2xx (5xx hiccup) so a transient backend error never crashes the shell", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentUser()).resolves.toBeNull();
  });
});

describe("auth · validateSession (入口守卫 AuthGate 的判别式裁决, §17/§23.6)", () => {
  // Unlike getCurrentUser (fail-soft to null for BOTH 401 and errors), validateSession
  // returns a discriminated state so the entry guard can route distinctly:
  //   authed   → 进设计器(带 emailVerified → 软提醒条)
  //   unauthed → 登录视图(401 / 无 token)
  //   error    → 中性「重试」占位(5xx / 网络异常)
  it("short-circuits to unauthed WITHOUT fetching when no token is held (无凭证必未登录)", async () => {
    clearToken();
    const fetchMock = vi.fn(async () => jsonResponse({ email: "owner@example.com" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateSession()).resolves.toEqual({ status: "unauthed" });
    // no round-trip — a missing credential is definitively not authenticated.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns authed + the user (with emailVerified) on a 200 (token present)", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ email: "owner@example.com", emailVerified: false, displayName: "陈伟" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const r = await validateSession();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/me");
    expect(init.headers.authorization).toBe("Bearer owner-jwt");
    expect(r).toEqual({
      status: "authed",
      user: { email: "owner@example.com", emailVerified: false, displayName: "陈伟" },
    });
  });

  it("coerces emailVerified to a strict boolean (backend may send 0/1)", async () => {
    setToken("owner-jwt");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ email: "o@e.com", emailVerified: 1 })),
    );
    const r = await validateSession();
    expect(r).toEqual({
      status: "authed",
      user: { email: "o@e.com", emailVerified: true, displayName: null },
    });
  });

  it("returns unauthed on a 401 (会话失效 → 登录视图)", async () => {
    setToken("stale-jwt");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 })),
    );
    await expect(validateSession()).resolves.toEqual({ status: "unauthed" });
  });

  it("returns error on a 5xx (校验服务异常 → 重试占位, NOT login)", async () => {
    setToken("owner-jwt");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "boom" }, { status: 500 })),
    );
    await expect(validateSession()).resolves.toEqual({ status: "error" });
  });

  it("returns error on a network failure (offline → 重试占位, NOT login)", async () => {
    setToken("owner-jwt");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(validateSession()).resolves.toEqual({ status: "error" });
  });

  it("returns unauthed on a malformed 2xx (no email → degrade to login, never throw)", async () => {
    setToken("owner-jwt");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({})),
    );
    await expect(validateSession()).resolves.toEqual({ status: "unauthed" });
  });
});

describe("auth · updateProfile (§17 个人资料 — 写显示名,owner-only)", () => {
  it("PUTs { displayName } to /api/auth/profile WITH a Bearer header and returns the updated profile", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ email: "owner@example.com", emailVerified: true, displayName: "陈伟" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const me = await updateProfile("陈伟");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/profile");
    expect(init.method).toBe("PUT");
    expect(init.headers.authorization).toBe("Bearer owner-jwt");
    expect(JSON.parse(init.body)).toEqual({ displayName: "陈伟" });
    expect(me).toEqual({ email: "owner@example.com", emailVerified: true, displayName: "陈伟" });
  });

  it("returns displayName=null when cleared (backend echoes null)", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ email: "owner@example.com", emailVerified: true, displayName: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const me = await updateProfile("");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ displayName: "" });
    expect(me).toEqual({ email: "owner@example.com", emailVerified: true, displayName: null });
  });

  it("propagates a 401 ApiError (会话失效 → 引导先登录) — unlike getCurrentUser this is a user action", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateProfile("陈伟")).rejects.toMatchObject({ name: "ApiError", status: 401 });
  });

  it("propagates a 400 ApiError (显示名称过长) for the UI to surface", async () => {
    setToken("owner-jwt");
    const fetchMock = vi.fn(async () => jsonResponse({ error: "显示名称过长" }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateProfile("x".repeat(99))).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
    });
  });
});

describe("auth · logout / isLoggedIn", () => {
  it("isLoggedIn reflects token presence", () => {
    expect(isLoggedIn()).toBe(false);
    setToken("t");
    expect(isLoggedIn()).toBe(true);
  });

  it("logout clears the stored token", () => {
    setToken("t");
    logout();
    expect(isLoggedIn()).toBe(false);
    expect(getToken()).toBeNull();
  });
});
