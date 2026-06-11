import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { login, logout, isLoggedIn } from "../../src/core/auth";
import { getToken, setToken, clearToken } from "../../src/core/apiClient";

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
  it("POSTs the password to /api/auth/login and stores the returned token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ token: "jwt-xyz" }));
    vi.stubGlobal("fetch", fetchMock);

    await login("hunter2");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ password: "hunter2" });
    expect(getToken()).toBe("jwt-xyz");
  });

  it("does not attach a Bearer header (login is the public auth entry)", async () => {
    setToken("stale-token");
    const fetchMock = vi.fn(async () => jsonResponse({ token: "fresh" }));
    vi.stubGlobal("fetch", fetchMock);

    await login("pw");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBeUndefined();
  });

  it("propagates a 401 ApiError on a wrong password and leaves no token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(login("wrong")).rejects.toMatchObject({ name: "ApiError", status: 401 });
    expect(getToken()).toBeNull();
  });

  it("throws (and stores nothing) when the response carries no token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(login("pw")).rejects.toThrow();
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
