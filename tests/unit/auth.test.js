import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { login, register, logout, isLoggedIn } from "../../src/core/auth";
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
