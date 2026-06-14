// Unit specs for src/core/configClient.ts — the owner integration-settings seam
// (SPEC §12 owner config + §14 connection test). These bind the wire contract of
// the three calls (path / method / `auth:true` / payload construction), in
// particular the "don't re-submit the mask" rule (§12.4) and the "测不通 is a 200,
// not an HTTP error" rule (§14.3).
//
// We mock the lowest seam (global `fetch`, the same level apiClient.test.js mocks)
// rather than apiClient itself, so these tests also pin that configClient routes
// through apiFetch with Bearer injection and the typed ApiError surface.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getConfig,
  saveConfig,
  testConnections,
  testConnection,
} from "../../src/core/configClient";
import { setToken, clearToken, ApiError } from "../../src/core/apiClient";

function jsonResponse(body, init = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

// A fully-configured masked view as the backend would return it (secrets masked).
// 账户级飞书凭据只剩 appId + appSecret——app_token / table_id 已退场（§16.9），不再 echo。
const MASKED = {
  deepseek: { apiKey: "sk-…wxyz", model: "deepseek-chat" },
  feishu: {
    appId: "cli_abc",
    appSecret: "yy…yy",
  },
  updatedAt: "2026-06-11T00:00:00.000Z",
};

beforeEach(() => {
  clearToken();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearToken();
});

describe("configClient · getConfig", () => {
  it("GETs /api/config as the owner (Bearer) and returns the masked view", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse(MASKED));
    vi.stubGlobal("fetch", fetchMock);

    const out = await getConfig();

    expect(out).toEqual(MASKED);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/config");
    expect(init.method).toBe("GET");
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
    // GET carries no body.
    expect(init.body).toBeUndefined();
  });

  it("returns the all-null skeleton (never-configured) without erroring", async () => {
    const skeleton = {
      deepseek: { apiKey: null, model: null },
      feishu: { appId: null, appSecret: null },
      updatedAt: null,
    };
    const fetchMock = vi.fn(async () => jsonResponse(skeleton));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getConfig()).resolves.toEqual(skeleton);
  });

  it("rejects with a 401 ApiError so the caller can route into login (§17)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getConfig()).rejects.toMatchObject({ name: "ApiError", status: 401 });
  });
});

describe("configClient · saveConfig", () => {
  it("POSTs /api/config as the owner and returns the masked view of what was saved", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse(MASKED));
    vi.stubGlobal("fetch", fetchMock);

    const input = {
      deepseek: { apiKey: "sk-realnewkey", model: "deepseek-chat" },
      feishu: {
        appId: "cli_abc",
        appSecret: "real-secret",
      },
    };
    const out = await saveConfig(input);

    expect(out).toEqual(MASKED);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/config");
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
    expect(init.headers["content-type"]).toBe("application/json");
    // The plaintext secrets the owner DID enter are sent through verbatim.
    expect(JSON.parse(init.body)).toEqual(input);
  });

  it("sends the new plaintext secrets when the owner changed them", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(MASKED));
    vi.stubGlobal("fetch", fetchMock);

    await saveConfig({ deepseek: { apiKey: "sk-brand-new" } });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.deepseek.apiKey).toBe("sk-brand-new");
  });

  it("omits an untouched secret subfield so the mask is never stored back (§12.4)", async () => {
    // The owner re-saves having only edited `model`; apiKey was left at its masked
    // echo and must be OMITTED (undefined) — never sent, and never sent as the mask.
    const fetchMock = vi.fn(async () => jsonResponse(MASKED));
    vi.stubGlobal("fetch", fetchMock);

    await saveConfig({ deepseek: { model: "deepseek-reasoner" } });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // JSON.stringify drops `undefined`, so the key must simply be absent…
    expect("apiKey" in body.deepseek).toBe(false);
    // …and the masked echo must NOT have leaked into the wire body anywhere.
    expect(JSON.stringify(body)).not.toContain("sk-…wxyz");
    expect(JSON.stringify(body)).not.toContain("yy…yy");
  });

  it("can omit the whole 飞书 block (暂不配置飞书) — DeepSeek-only save", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(MASKED));
    vi.stubGlobal("fetch", fetchMock);

    await saveConfig({ deepseek: { apiKey: "sk-only" } });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.feishu).toBeUndefined();
  });

  it("rejects with a 400 ApiError carrying the backend message (missing key / half-filled)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "DeepSeek key 必填" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveConfig({ deepseek: {} })).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "DeepSeek key 必填",
    });
  });
});

describe("configClient · testConnections", () => {
  it("POSTs /api/config/test as the owner with no probe body", async () => {
    setToken("jwt-owner");
    const result = {
      deepseek: { ok: true },
      feishu: { ok: false, message: "凭据无效" },
    };
    const fetchMock = vi.fn(async () => jsonResponse(result));
    vi.stubGlobal("fetch", fetchMock);

    const out = await testConnections();

    expect(out).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/config/test");
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
    // Probes the STORED config — takes no request body.
    expect(init.body).toBeUndefined();
  });

  it("resolves (not rejects) a 200 where both blocks are ok:false — 测不通 is normal", async () => {
    const result = {
      deepseek: { ok: false, message: "未配置" },
      feishu: { ok: false, message: "未配置" },
    };
    const fetchMock = vi.fn(async () => jsonResponse(result));
    vi.stubGlobal("fetch", fetchMock);

    await expect(testConnections()).resolves.toEqual(result);
  });

  it("resolves a mixed 200 (one ok, one not) without treating ok:false as an error", async () => {
    const result = {
      deepseek: { ok: true, message: "可连通" },
      feishu: { ok: false, message: "凭据无效" },
    };
    const fetchMock = vi.fn(async () => jsonResponse(result));
    vi.stubGlobal("fetch", fetchMock);

    const out = await testConnections();
    expect(out.deepseek.ok).toBe(true);
    expect(out.feishu.ok).toBe(false);
    expect(out.feishu.message).toBe("凭据无效");
  });

  it("rejects only on a 401 (session expired → route into login)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(testConnections()).rejects.toMatchObject({ name: "ApiError", status: 401 });
  });

  it("rejects on a network/infra failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(testConnections()).rejects.toBeTruthy();
  });
});

// Per-card single-service probe (§14, PR #72): testConnection(service, creds) sends
// `{ service, [service]: creds }` (only the keys the owner typed — never the mask), and
// resolves to JUST that block's ConnProbe.
describe("configClient · testConnection (single-service)", () => {
  it("POSTs only the DeepSeek block with the supplied candidate key and returns its probe", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ deepseek: { ok: true, message: "可连通" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await testConnection("deepseek", { apiKey: "sk-candidate" });

    // Returns the single block's probe, not the whole result object.
    expect(out).toEqual({ ok: true, message: "可连通" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/config/test");
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ service: "deepseek", deepseek: { apiKey: "sk-candidate" } });
    // 飞书 is NOT in the payload — only the targeted service.
    expect(body.feishu).toBeUndefined();
  });

  it("OMITS the apiKey when the owner didn't edit it (mask fallback → test stored)", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ deepseek: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    // No creds → backend falls back to the stored key; the mask is never sent.
    await testConnection("deepseek");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ service: "deepseek" });
    expect(body.deepseek).toBeUndefined();
  });

  it("sends 飞书 appId + appSecret and returns the 飞书 probe", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ feishu: { ok: false, message: "凭据无效" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await testConnection("feishu", { appId: "cli_x", appSecret: "secret-y" });

    expect(out).toEqual({ ok: false, message: "凭据无效" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ service: "feishu", feishu: { appId: "cli_x", appSecret: "secret-y" } });
  });

  it("sends 飞书 appId alone (secret unchanged) so the backend keeps the stored secret", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ feishu: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await testConnection("feishu", { appId: "cli_x" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ service: "feishu", feishu: { appId: "cli_x" } });
    expect(body.feishu.appSecret).toBeUndefined();
  });

  it("resolves (not rejects) a 200 ok:false — 测不通 is a normal single-card result", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ deepseek: { ok: false, message: "未配置" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(testConnection("deepseek")).resolves.toEqual({ ok: false, message: "未配置" });
  });

  it("degrades a missing block in the response to a normal 未配置 probe (never throws)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(testConnection("deepseek")).resolves.toEqual({ ok: false, message: "未配置" });
  });

  it("rejects only on a 401 (session expired → route into login)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(testConnection("deepseek")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });
});

// Sanity: ApiError is the surface these calls reject with (keeps the import meaningful).
describe("configClient · error surface", () => {
  it("non-2xx rejections are ApiError instances", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getConfig()).rejects.toBeInstanceOf(ApiError);
  });
});
