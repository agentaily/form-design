import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  apiBase,
  apiFetch,
  apiStream,
  getToken,
  setToken,
  clearToken,
  ApiError,
} from "../../src/core/apiClient";

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

describe("apiClient · apiBase", () => {
  it("defaults to empty (same-origin) when VITE_API_BASE is unset", () => {
    vi.stubEnv("VITE_API_BASE", "");
    expect(apiBase()).toBe("");
  });
  it("trims a trailing slash so path joins don't double up", () => {
    vi.stubEnv("VITE_API_BASE", "https://api.example.com/");
    expect(apiBase()).toBe("https://api.example.com");
  });
});

describe("apiClient · token store", () => {
  it("round-trips and clears the session token", () => {
    expect(getToken()).toBeNull();
    setToken("jwt-123");
    expect(getToken()).toBe("jwt-123");
    clearToken();
    expect(getToken()).toBeNull();
  });
});

describe("apiClient · apiFetch", () => {
  it("GETs by default and parses the JSON body", async () => {
    vi.stubEnv("VITE_API_BASE", "https://api.example.com");
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await apiFetch("/api/config");
    expect(out).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/api/config");
    expect(init.method).toBe("GET");
  });

  it("POSTs a JSON body with a content-type header", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/forms", { body: { slug: "x" } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ slug: "x" });
  });

  it("injects Authorization: Bearer when auth is requested and a token exists", async () => {
    setToken("jwt-abc");
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/config", { auth: true });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["authorization"]).toBe("Bearer jwt-abc");
  });

  it("omits Authorization when auth is requested but no token is stored", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/config", { auth: true });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["authorization"]).toBeUndefined();
  });

  it("throws ApiError carrying status and the backend {error} message on non-2xx", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "owner 未配置 DeepSeek" }, { status: 409 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/api/chat", { body: {} })).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      message: "owner 未配置 DeepSeek",
    });
  });

  it("resolves undefined for an empty 2xx body", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      apiFetch("/api/forms/x", { method: "DELETE", auth: true }),
    ).resolves.toBeUndefined();
  });
});

describe("apiClient · apiStream", () => {
  it("returns the raw Response (default POST) for SSE consumption on 2xx", async () => {
    const res = new Response("data: hi\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fetchMock = vi.fn(async () => res);
    vi.stubGlobal("fetch", fetchMock);

    const out = await apiStream("/api/chat", { body: { messages: [] } });
    expect(out).toBe(res);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  });

  it("throws ApiError (not a stream) when the proxy returns a JSON error", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "messages is required" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiStream("/api/chat", { body: {} })).rejects.toMatchObject({
      status: 400,
      message: "messages is required",
    });
  });
});
