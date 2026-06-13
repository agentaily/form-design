import { test, expect } from "@playwright/test";
import { mockChat, mockPublish } from "./chatMock.js";

// End-to-end realization of 设计对话持久化 + 刷新恢复 (§26) in a real browser: an owner
// chats, the turn flushes to PUT /api/chat/session/:id (batch at turn end), then a full
// page reload re-fetches via GET and the conversation thread comes back — exactly the
// 「聊天 → 刷新 → 历史还在」path the feature promises (features/chat-session-persistence.feature).
//
// No live backend: mockChat 给一段确定的 SSE 流(turn1 工具调用建表、turn2 收尾 prose);
// the chat-session endpoint is backed by an in-memory store on the Node side, so PUT writes
// and GET reads share state across the reload. The design session id is client-minted into
// localStorage and survives the reload, so the post-reload GET keys the same session.
//
// 设计对话是 owner-only (§26.5):seed 一个 token + mock GET /api/auth/me 进入登录态,否则
// 既不持久化也不恢复。RESTORE 只重建对话线(messages + LLM history),不重建表单预览模型——
// 所以刷新后断言的是【对话区】里的回合,不是预览字段。
const TOKEN = "fake.jwt.token";

async function seedSession(page) {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", emailVerified: true }),
    });
  });
  await page.addInitScript((token) => {
    try {
      localStorage.setItem("agentaily_forms_token", token);
    } catch {
      /* private mode — token mirror still set in-app */
    }
  }, TOKEN);
}

// In-memory chat-session store backing GET/PUT /api/chat/session/:id for one owner across
// the reload. PUT 整段替换 (last-write-wins, §26.3);GET 命中回 { session },未写过回
// { session: null }(空态非 404)。
async function mockChatSession(page) {
  const store = { session: null };
  await page.route("**/api/chat/session/**", async (route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      const body = JSON.parse(req.postData() || "{}");
      const url = new URL(req.url());
      const sessionId = decodeURIComponent(url.pathname.split("/").pop() || "");
      store.session = {
        sessionId,
        turns: body.turns || [],
        history: body.history || [],
        formSlug: body.formSlug ?? null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      };
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, updatedAt: store.session.updatedAt }),
      });
      return;
    }
    // GET (and anything else read-shaped): 命中回存的会话,否则空态。
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: store.session }),
    });
  });
  return store;
}

test.describe("Agentaily Forms · 设计对话持久化 + 刷新恢复 (§26)", () => {
  test.beforeEach(async ({ page }) => {
    await mockChat(page);
    await mockPublish(page);
  });

  test("聊天一回合 → 刷新页面 → 对话历史还在", async ({ page }) => {
    await seedSession(page);
    const store = await mockChatSession(page);
    await page.goto("/");

    // 一回合:起步提示发出 → Agent 建表 + 收尾 prose。回合结束(发布按钮可点)即已 flush PUT。
    await page.getByText("做一个线下活动报名表").click();
    await expect(page.getByRole("button", { name: "发布", exact: true })).toBeEnabled({
      timeout: 20_000,
    });
    // 收尾的助手 prose 出现在对话区(这一回合已 settle)。
    await expect(page.getByText("搭好了", { exact: false })).toBeVisible();

    // 回合结束批量写入后端(§26.4):等 PUT 真的落到 store(不是每 token 写)。
    await expect.poll(() => store.session, { timeout: 10_000 }).not.toBeNull();
    expect(store.session.turns.length).toBeGreaterThan(0);

    // —— 刷新页面 —— 整页重载,React 全新挂载;登录态 → restore useEffect 走 GET 拉回会话。
    await page.reload();

    // Then 之前的对话回合重新出现在对话区(刷新后历史还在)。
    await expect(page.getByText("搭好了", { exact: false })).toBeVisible({ timeout: 20_000 });
    // 恢复出来的是【对话】而非空态:起步提示空态已不在。
    await expect(page.getByText("描述你想要的表单")).toHaveCount(0);
  });
});
