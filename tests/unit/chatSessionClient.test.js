// Unit specs for src/core/chatSessionClient.ts — the frontend seam for chat-session
// persistence (SPEC §26; auth §17). Realizes the unit-altitude slice of
// features/chat-session-persistence.feature:
//   * a stable, localStorage-backed design session id (minted once, reused after)
//   * loadChatSession GET — owner-only, carries Bearer; { session } hit / { session: null } empty
//   * saveChatTurns PUT — owner-only, carries Bearer; sends { turns, history(, formSlug) }
//
// CONTRACT — OWNER-ONLY, CARRIES BEARER (like submissionsClient, opposite of
// publicClient): both calls go through apiFetch with `auth:true`. We mock the lowest
// seam (global `fetch`) to pin path / method / the request+response shape and the
// typed ApiError surface (401 → caller routes into /signin). The session-id helper is
// pinned against a fake localStorage (and its unavailable fallback).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DESIGN_SESSION_ID_KEY,
  CHAT_SESSION_PATH,
  getOrCreateDesignSessionId,
  loadChatSession,
  saveChatTurns,
  toPersistedTurns,
} from "../../src/core/chatSessionClient";
import { setToken, clearToken, ApiError } from "../../src/core/apiClient";

function jsonResponse(body, init = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

// A §26.6 persisted session: a UI transcript (turns) + the LLM wire history
// (history, incl. the leading system message) + the associated slug + stamps.
const SESSION = {
  sessionId: "b3f1aaaa-uuid",
  turns: [
    { id: "msg-1", role: "user", text: "做一个报名表" },
    {
      id: "msg-2",
      role: "assistant",
      kind: "tool",
      name: "add_field",
      args: { type: "text", label: "姓名" },
      result: "ok",
      status: "done",
    },
    {
      id: "msg-3",
      role: "assistant",
      kind: "text",
      text: "已加上姓名字段",
      suggestions: ["加邮箱"],
    },
  ],
  history: [
    { role: "system", content: "你是设计助手" },
    { role: "user", content: "做一个报名表" },
    { role: "assistant", content: "已加上姓名字段" },
  ],
  formSlug: null,
  createdAt: "2026-06-13T08:00:00.000Z",
  updatedAt: "2026-06-13T08:05:00.000Z",
};

// This vitest/jsdom config does NOT provide a `localStorage` global (it's undefined,
// which is exactly why apiClient wraps every access in try/catch). So these specs
// install their OWN fake `localStorage` per test: a working in-memory store for the
// persist/reuse cases, and a throwing store for the unavailable-storage fallback.
function installFakeLocalStorage() {
  const store = new Map();
  const fake = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => void store.clear(),
  };
  vi.stubGlobal("localStorage", fake);
  return fake;
}

beforeEach(() => {
  clearToken();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearToken();
});

describe("chatSessionClient · getOrCreateDesignSessionId", () => {
  it("mints a fresh id on first call and persists it to localStorage", () => {
    const store = installFakeLocalStorage();
    expect(store.getItem(DESIGN_SESSION_ID_KEY)).toBeNull();

    const id = getOrCreateDesignSessionId();

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    // The minted id is written back so a reload reads the same one (§26.2).
    expect(store.getItem(DESIGN_SESSION_ID_KEY)).toBe(id);
  });

  it("reuses the same id on the second call (stable across reloads)", () => {
    installFakeLocalStorage();
    const first = getOrCreateDesignSessionId();
    const second = getOrCreateDesignSessionId();
    expect(second).toBe(first);
  });

  it("returns a pre-existing localStorage id verbatim (resume the same conversation)", () => {
    const store = installFakeLocalStorage();
    store.setItem(DESIGN_SESSION_ID_KEY, "preexisting-id-123");
    expect(getOrCreateDesignSessionId()).toBe("preexisting-id-123");
  });

  it("falls back to an in-memory id when localStorage is unavailable (mirrors memToken)", () => {
    // Simulate private-mode / sandboxed storage (and this jsdom config's no-storage
    // default): every access throws.
    const throwing = {
      getItem() {
        throw new Error("storage unavailable");
      },
      setItem() {
        throw new Error("storage unavailable");
      },
      removeItem() {
        throw new Error("storage unavailable");
      },
      clear() {
        throw new Error("storage unavailable");
      },
    };
    vi.stubGlobal("localStorage", throwing);

    const first = getOrCreateDesignSessionId();
    expect(typeof first).toBe("string");
    expect(first.length).toBeGreaterThan(0);
    // Even without storage, the id coheres within the page (in-memory mirror).
    const second = getOrCreateDesignSessionId();
    expect(second).toBe(first);
  });
});

describe("chatSessionClient · toPersistedTurns", () => {
  it("strips the transient `streaming` flag and keeps the serializable turn fields (§26.6)", () => {
    const live = [
      { id: "msg-1", role: "user", text: "做一个报名表" },
      {
        id: "msg-2",
        role: "assistant",
        kind: "tool",
        name: "add_field",
        args: { type: "text", label: "姓名" },
        result: "ok",
        status: "done",
      },
      // A still-streaming assistant bubble: the streaming flag must NOT be persisted.
      {
        id: "msg-3",
        role: "assistant",
        kind: "text",
        text: "已加上姓名字段",
        streaming: false,
        suggestions: ["加邮箱"],
      },
    ];

    const turns = toPersistedTurns(live);

    // No `streaming` key survives on any turn.
    turns.forEach((t) => expect("streaming" in t).toBe(false));
    // The substantive fields are preserved verbatim.
    expect(turns).toEqual([
      { id: "msg-1", role: "user", text: "做一个报名表" },
      {
        id: "msg-2",
        role: "assistant",
        kind: "tool",
        name: "add_field",
        args: { type: "text", label: "姓名" },
        result: "ok",
        status: "done",
      },
      {
        id: "msg-3",
        role: "assistant",
        kind: "text",
        text: "已加上姓名字段",
        suggestions: ["加邮箱"],
      },
    ]);
  });

  it("round-trips through JSON unchanged (no live handles / non-serializable values)", () => {
    const turns = toPersistedTurns([
      { id: "msg-1", role: "user", text: "hi", streaming: true },
      { id: "msg-2", role: "assistant", kind: "reasoning", steps: ["想一想"], duration: 3 },
    ]);
    expect(JSON.parse(JSON.stringify(turns))).toEqual(turns);
  });
});

describe("chatSessionClient · loadChatSession", () => {
  it("GETs /api/chat/session/:sessionId as the owner (Bearer) and resolves { session }", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ session: SESSION }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await loadChatSession("b3f1aaaa-uuid");

    expect(out).toEqual({ session: SESSION });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`${CHAT_SESSION_PATH}/b3f1aaaa-uuid`);
    expect((init.method ?? "GET").toUpperCase()).toBe("GET");
    // OWNER-ONLY: the Bearer token rides along (§17).
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
    expect(init.body).toBeUndefined();
  });

  it("resolves the empty state { session: null } for a never-persisted id (not a 404)", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ session: null }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadChatSession("never-seen")).resolves.toEqual({ session: null });
  });

  it("rejects with a 401 ApiError when the session expired (caller routes into /signin)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadChatSession("b3f1aaaa-uuid")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });
});

describe("chatSessionClient · saveChatTurns", () => {
  it("PUTs the batch snapshot as the owner (Bearer) and resolves { sessionId, updatedAt }", async () => {
    setToken("jwt-owner");
    const result = { sessionId: "b3f1aaaa-uuid", updatedAt: "2026-06-13T08:05:00.000Z" };
    const fetchMock = vi.fn(async () => jsonResponse(result));
    vi.stubGlobal("fetch", fetchMock);

    const input = { turns: SESSION.turns, history: SESSION.history };
    const out = await saveChatTurns("b3f1aaaa-uuid", input);

    expect(out).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`${CHAT_SESSION_PATH}/b3f1aaaa-uuid`);
    expect(init.method.toUpperCase()).toBe("PUT");
    // OWNER-ONLY: the Bearer token rides along (§17).
    expect(init.headers["authorization"]).toBe("Bearer jwt-owner");
    expect(init.headers["content-type"]).toBe("application/json");
    // The body is the exact batch snapshot — turns + history (§26.3/§26.4).
    expect(JSON.parse(init.body)).toEqual(input);
  });

  it("forwards an optional formSlug to associate the published form (§26.2)", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ sessionId: "b3f1aaaa-uuid", updatedAt: "2026-06-13T09:00:00.000Z" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await saveChatTurns("b3f1aaaa-uuid", {
      turns: SESSION.turns,
      history: SESSION.history,
      formSlug: "f8Kq2pXa",
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).formSlug).toBe("f8Kq2pXa");
  });

  it("rejects with a 401 ApiError when the session expired (caller routes into /signin)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "未授权" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveChatTurns("b3f1aaaa-uuid", { turns: [], history: [] })).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });

  it("rejects with an ApiError on a non-2xx save (caller decides best-effort handling)", async () => {
    setToken("jwt-owner");
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveChatTurns("b3f1aaaa-uuid", { turns: [], history: [] })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
