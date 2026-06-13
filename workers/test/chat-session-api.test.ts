import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applySchema, resetChatSessions, resetUsers, registerOwner, authHeader } from "./helpers";

// Outer-loop acceptance specs for 设计对话持久化 + 刷新恢复 (owner-only, §26), driven
// through the real Hono app in workerd via SELF.fetch against a local miniflare D1.
// Realizes the backend slice of features/chat-session-persistence.feature:
//   * owner-only 鉴权门: 缺 token → 401 on both GET and PUT (§26.1)
//   * (owner_id, session_id) 隔离: A 存 B 读不到 → { session: null } (§26.8)
//   * upsert last-write-wins: 二次 PUT 整段替换 (§26.3)
//   * 空态: 从未持久化的 id → { session: null }，非 404 (§26.3)
//   * PUT → GET round-trip: turns + history + formSlug 原样回 (§26.3)
//   * formSlug 缺省不清空已关联的 slug (§26.3)
//
// Contract: SPEC.md §26 + §17.1 (鉴权矩阵).

const BASE = "https://api.local";

const SESSION_ID = "b3f1aaaa-2222-3333-4444-555566667777";

// A §26.6 conversation snapshot: a UI transcript (turns) + the LLM wire history
// (incl. the leading system message). Distinctive strings so a cross-owner leak,
// were one to ever happen, would be unmistakable.
const TURNS = [
  { id: "msg-1", role: "user", text: "做一个活动报名表-OWNER-A" },
  {
    id: "msg-2",
    role: "assistant",
    kind: "tool",
    name: "add_field",
    args: { type: "text", label: "姓名" },
    result: "ok",
    status: "done",
  },
  { id: "msg-3", role: "assistant", kind: "text", text: "已加上姓名字段", suggestions: ["加邮箱"] },
];
const HISTORY = [
  { role: "system", content: "你是设计助手-SYSTEM-PROMPT" },
  { role: "user", content: "做一个活动报名表-OWNER-A" },
  { role: "assistant", content: "已加上姓名字段" },
];

function path(sessionId: string): string {
  return `${BASE}/api/chat/session/${encodeURIComponent(sessionId)}`;
}

async function putSession(
  token: string,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return SELF.fetch(path(sessionId), {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
}

async function getSession(token: string, sessionId: string): Promise<Response> {
  return SELF.fetch(path(sessionId), { headers: authHeader(token) });
}

beforeAll(async () => {
  await applySchema();
});
beforeEach(async () => {
  await resetChatSessions();
  await resetUsers();
});

describe("chat-session API · owner-only auth gate (§26.1 / §17.1)", () => {
  it("GET without a token → 401 (no session leaks to anonymous)", async () => {
    const res = await SELF.fetch(path(SESSION_ID));
    expect(res.status).toBe(401);
  });

  it("PUT without a token → 401 (anonymous cannot persist)", async () => {
    const res = await SELF.fetch(path(SESSION_ID), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turns: TURNS, history: HISTORY }),
    });
    expect(res.status).toBe(401);
  });

  it("GET with a bad/garbage token → 401", async () => {
    const res = await SELF.fetch(path(SESSION_ID), {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    expect(res.status).toBe(401);
  });
});

describe("chat-session API · empty state (§26.3)", () => {
  it("GET a never-persisted id → 200 { session: null } (not a 404)", async () => {
    const { token } = await registerOwner();
    const res = await getSession(token, "never-persisted-id");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session: null });
  });
});

describe("chat-session API · PUT → GET round-trip (§26.3)", () => {
  it("persists turns + history + formSlug and reads them back verbatim", async () => {
    const { token } = await registerOwner();

    const put = await putSession(token, SESSION_ID, {
      turns: TURNS,
      history: HISTORY,
      formSlug: "f8Kq2pXa",
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { sessionId: string; updatedAt: string };
    expect(putBody.sessionId).toBe(SESSION_ID);
    expect(typeof putBody.updatedAt).toBe("string");

    const get = await getSession(token, SESSION_ID);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { session: Record<string, unknown> };
    expect(body.session).not.toBeNull();
    expect(body.session.sessionId).toBe(SESSION_ID);
    expect(body.session.turns).toEqual(TURNS);
    expect(body.session.history).toEqual(HISTORY);
    expect(body.session.formSlug).toBe("f8Kq2pXa");
    expect(typeof body.session.createdAt).toBe("string");
    expect(typeof body.session.updatedAt).toBe("string");
    // 凭据不出网 (§26.8): no owner_id surfaces in the response projection.
    expect(JSON.stringify(body)).not.toContain("owner_id");
  });

  it("formSlug is null before publish and the row reads back null", async () => {
    const { token } = await registerOwner();
    await putSession(token, SESSION_ID, { turns: TURNS, history: HISTORY });
    const get = await getSession(token, SESSION_ID);
    const body = (await get.json()) as { session: { formSlug: unknown } };
    expect(body.session.formSlug).toBeNull();
  });
});

describe("chat-session API · upsert last-write-wins (§26.3)", () => {
  it("a second PUT replaces the whole transcript for the same (owner, session)", async () => {
    const { token } = await registerOwner();
    await putSession(token, SESSION_ID, { turns: TURNS, history: HISTORY });

    const NEW_TURNS = [{ id: "msg-9", role: "user", text: "全新的对话内容" }];
    const NEW_HISTORY = [
      { role: "system", content: "你是设计助手-SYSTEM-PROMPT" },
      { role: "user", content: "全新的对话内容" },
    ];
    await putSession(token, SESSION_ID, { turns: NEW_TURNS, history: NEW_HISTORY });

    const get = await getSession(token, SESSION_ID);
    const body = (await get.json()) as { session: Record<string, unknown> };
    expect(body.session.turns).toEqual(NEW_TURNS);
    expect(body.session.history).toEqual(NEW_HISTORY);
  });

  it("a PUT omitting formSlug does NOT clear an already-associated slug (§26.3)", async () => {
    const { token } = await registerOwner();
    // First PUT associates a slug.
    await putSession(token, SESSION_ID, { turns: TURNS, history: HISTORY, formSlug: "f8Kq2pXa" });
    // A later ordinary turn write omits formSlug — the association must survive.
    await putSession(token, SESSION_ID, { turns: TURNS, history: HISTORY });

    const get = await getSession(token, SESSION_ID);
    const body = (await get.json()) as { session: { formSlug: unknown } };
    expect(body.session.formSlug).toBe("f8Kq2pXa");
  });
});

describe("chat-session API · cross-owner isolation (§26.8)", () => {
  it("owner B cannot read owner A's session at the same session id → { session: null }", async () => {
    const ownerA = await registerOwner();
    const ownerB = await registerOwner();

    // A persists a conversation under SESSION_ID.
    const put = await putSession(ownerA.token, SESSION_ID, { turns: TURNS, history: HISTORY });
    expect(put.status).toBe(200);

    // B, logged in with their own account, reads the SAME session id → sees nothing
    // (the row is keyed (owner_id, session_id); B's owner_id doesn't match A's row).
    const getB = await getSession(ownerB.token, SESSION_ID);
    expect(getB.status).toBe(200);
    expect(await getB.json()).toEqual({ session: null });

    // Sanity: A still reads their own.
    const getA = await getSession(ownerA.token, SESSION_ID);
    const bodyA = (await getA.json()) as { session: Record<string, unknown> | null };
    expect(bodyA.session).not.toBeNull();
    expect(bodyA.session!.turns).toEqual(TURNS);
  });

  it("B's PUT at the same id writes B's OWN row and does not clobber A's (§26.8)", async () => {
    const ownerA = await registerOwner();
    const ownerB = await registerOwner();

    await putSession(ownerA.token, SESSION_ID, { turns: TURNS, history: HISTORY });
    const B_TURNS = [{ id: "msg-b", role: "user", text: "B 的对话内容-DISTINCT" }];
    await putSession(ownerB.token, SESSION_ID, { turns: B_TURNS, history: [] });

    // A's row is untouched; B's row holds B's content — two rows, same session_id.
    const getA = (await (await getSession(ownerA.token, SESSION_ID)).json()) as {
      session: { turns: unknown };
    };
    const getB = (await (await getSession(ownerB.token, SESSION_ID)).json()) as {
      session: { turns: unknown };
    };
    expect(getA.session.turns).toEqual(TURNS);
    expect(getB.session.turns).toEqual(B_TURNS);
  });
});

describe("chat-session API · bad request (§26.3)", () => {
  it("PUT with a non-JSON body → 400, nothing persisted", async () => {
    const { token } = await registerOwner();
    const res = await SELF.fetch(path(SESSION_ID), {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeader(token) },
      body: "not json{{{",
    });
    expect(res.status).toBe(400);
    // Nothing was written → GET is still empty.
    const get = await getSession(token, SESSION_ID);
    expect(await get.json()).toEqual({ session: null });
  });

  it("PUT with turns/history not arrays → 400, nothing persisted", async () => {
    const { token } = await registerOwner();
    const res = await putSession(token, SESSION_ID, { turns: "nope", history: 42 });
    expect(res.status).toBe(400);
    const get = await getSession(token, SESSION_ID);
    expect(await get.json()).toEqual({ session: null });
  });
});
