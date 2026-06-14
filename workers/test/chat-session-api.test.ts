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
// 多会话列表 + 删除 (§26.9, PR #65) — realizes features/chat-multi-session.feature 的后端切片:
//   * GET /api/chat/sessions 无 token → 401；owner 列出自己全部会话 (updatedAt DESC、title/turnCount 推导)
//   * 列表只含本 owner (跨 owner 隔离)；零会话 → { sessions: [] }
//   * DELETE 自己的 → 200 { deleted:true } 且之后列表/单条都不含它
//   * DELETE 别人的 / 不存在的 → 404 「会话不存在」且对方行不动
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

async function listSessions(token: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/chat/sessions`, { headers: authHeader(token) });
}

async function deleteSession(token: string, sessionId: string): Promise<Response> {
  return SELF.fetch(path(sessionId), { method: "DELETE", headers: authHeader(token) });
}

/** A turns transcript whose first user message is `firstUserText`, with `userTurns` user turns. */
function turnsWith(firstUserText: string, userTurns = 1): Array<Record<string, unknown>> {
  const turns: Array<Record<string, unknown>> = [
    { id: "a-0", role: "assistant", kind: "text", text: "你好" },
    { id: "u-0", role: "user", text: firstUserText },
  ];
  for (let i = 1; i < userTurns; i += 1) {
    turns.push({ id: `u-${i}`, role: "user", text: `后续用户消息 ${i}` });
  }
  return turns;
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

// --- 多会话列表 GET /api/chat/sessions (§26.9, PR #65) -----------------------

interface SessionSummary {
  sessionId: string;
  title: string;
  turnCount: number;
  formSlug: string | null;
  updatedAt: string;
}

describe("chat-session API · sessions list owner-only auth gate (§26.1 / §17.1)", () => {
  it("GET /api/chat/sessions without a token → 401 (no list leaks to anonymous)", async () => {
    const res = await listSessions("");
    expect(res.status).toBe(401);
  });
});

describe("chat-session API · list owner's sessions (§26.9)", () => {
  it("returns all of the owner's sessions, newest-updated first, with derived title + turnCount", async () => {
    const { token } = await registerOwner();

    // Three sessions persisted oldest → newest. updated_at is millisecond-resolution and the
    // route stamps it at write time, so three back-to-back PUTs can land in the SAME ms → tie →
    // SQLite's order for equal keys is undefined. Space them a few ms apart so updated_at strictly
    // increases and the expected DESC order (reverse of insertion) is deterministic — independent
    // of the secondary session_id tiebreak the query also carries for production stability.
    const tick = () => new Promise((r) => setTimeout(r, 5));
    await putSession(token, "sess-old", { turns: turnsWith("最早的会话", 1), history: [] });
    await tick();
    await putSession(token, "sess-mid", { turns: turnsWith("中间的会话", 2), history: [] });
    await tick();
    await putSession(token, "sess-new", { turns: turnsWith("最新的会话", 3), history: [] });

    const res = await listSessions(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: SessionSummary[] };
    expect(body.sessions).toHaveLength(3);

    // ORDER BY updated_at DESC — newest write first.
    expect(body.sessions.map((s) => s.sessionId)).toEqual(["sess-new", "sess-mid", "sess-old"]);

    // title 取自首条 user 消息，turnCount = user 回合数（§26.9）。
    const byId = Object.fromEntries(body.sessions.map((s) => [s.sessionId, s]));
    expect(byId["sess-old"]).toMatchObject({ title: "最早的会话", turnCount: 1 });
    expect(byId["sess-mid"]).toMatchObject({ title: "中间的会话", turnCount: 2 });
    expect(byId["sess-new"]).toMatchObject({ title: "最新的会话", turnCount: 3 });

    // 凭据不出网 (§26.8)：列表里不暴露 owner_id；且不带完整 history 转写（省带宽，§26.9）。
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("owner_id");
    expect(raw).not.toContain("history");
  });

  it("projects formSlug (null before publish, the slug after) per item", async () => {
    const { token } = await registerOwner();
    await putSession(token, "sess-draft", { turns: turnsWith("草稿"), history: [] });
    await putSession(token, "sess-pub", {
      turns: turnsWith("已发布"),
      history: [],
      formSlug: "f8Kq2pXa",
    });

    const body = (await (await listSessions(token)).json()) as { sessions: SessionSummary[] };
    const byId = Object.fromEntries(body.sessions.map((s) => [s.sessionId, s]));
    expect(byId["sess-draft"].formSlug).toBeNull();
    expect(byId["sess-pub"].formSlug).toBe("f8Kq2pXa");
  });

  it("returns { sessions: [] } when the owner has no sessions (empty state, not an error)", async () => {
    const { token } = await registerOwner();
    const res = await listSessions(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
  });
});

describe("chat-session API · list cross-owner isolation (§26.8)", () => {
  it("each owner's list contains only their own sessions", async () => {
    const ownerA = await registerOwner();
    const ownerB = await registerOwner();

    await putSession(ownerA.token, "a-1", { turns: turnsWith("A 的会话一-DISTINCT"), history: [] });
    await putSession(ownerA.token, "a-2", { turns: turnsWith("A 的会话二-DISTINCT"), history: [] });
    await putSession(ownerB.token, "b-1", { turns: turnsWith("B 的会话-DISTINCT"), history: [] });

    const listA = (await (await listSessions(ownerA.token)).json()) as {
      sessions: SessionSummary[];
    };
    const listB = (await (await listSessions(ownerB.token)).json()) as {
      sessions: SessionSummary[];
    };

    expect(listA.sessions.map((s) => s.sessionId).sort()).toEqual(["a-1", "a-2"]);
    // A 的列表绝不含 B 的任何会话（§26.8）。
    expect(JSON.stringify(listA.sessions)).not.toContain("DISTINCT-b");
    expect(listA.sessions.map((s) => s.sessionId)).not.toContain("b-1");

    expect(listB.sessions.map((s) => s.sessionId)).toEqual(["b-1"]);
    expect(JSON.stringify(listB.sessions)).not.toContain("A 的会话");
  });
});

// --- 删除 DELETE /api/chat/session/:sessionId (§26.9, PR #65) ----------------

describe("chat-session API · delete a session (§26.9)", () => {
  it("owner deletes their own session → 200 { deleted: true }, gone from list + single GET", async () => {
    const { token } = await registerOwner();
    await putSession(token, "keep-me", { turns: turnsWith("保留这段"), history: [] });
    await putSession(token, SESSION_ID, { turns: TURNS, history: HISTORY });

    const del = await deleteSession(token, SESSION_ID);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });

    // Single GET of the deleted session → empty state (not a 404, same as never-persisted).
    const get = await getSession(token, SESSION_ID);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ session: null });

    // List no longer contains it, but the untouched session survives.
    const body = (await (await listSessions(token)).json()) as { sessions: SessionSummary[] };
    expect(body.sessions.map((s) => s.sessionId)).toEqual(["keep-me"]);
  });

  it("DELETE another owner's sessionId → 404 「会话不存在」 and the victim's row is untouched", async () => {
    const ownerA = await registerOwner();
    const ownerB = await registerOwner();

    await putSession(ownerB.token, SESSION_ID, {
      turns: turnsWith("B 的会话-VICTIM"),
      history: [],
    });

    // A tries to delete B's session id — A has no such row → 404, B's row must survive.
    const del = await deleteSession(ownerA.token, SESSION_ID);
    expect(del.status).toBe(404);
    const body = (await del.json()) as { error: string };
    expect(body.error).toContain("会话不存在");

    // B's session is untouched — still readable + listed by B.
    const getB = await getSession(ownerB.token, SESSION_ID);
    const gb = (await getB.json()) as { session: { turns: unknown } | null };
    expect(gb.session).not.toBeNull();
    const listB = (await (await listSessions(ownerB.token)).json()) as {
      sessions: SessionSummary[];
    };
    expect(listB.sessions.map((s) => s.sessionId)).toEqual([SESSION_ID]);
  });

  it("DELETE a never-existed session id → 404 「会话不存在」", async () => {
    const { token } = await registerOwner();
    const del = await deleteSession(token, "never-existed-id");
    expect(del.status).toBe(404);
    const body = (await del.json()) as { error: string };
    expect(body.error).toContain("会话不存在");
  });

  it("DELETE without a token → 401", async () => {
    const res = await SELF.fetch(path(SESSION_ID), { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});
