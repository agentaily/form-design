import { test, expect } from "@playwright/test";
import { mockChat } from "./chatMock.js";

// End-to-end realization of features/chat-multi-session.feature (§26.9 多会话列表/新建/切换/
// 删除 + §13.6 对话级模型芯片) in a REAL browser — the same scenarios the App-level
// integration spec (tests/integration/chat-multi-session.spec.jsx) drives via injected
// seams, but here exercised through the actual network layer: the SessionMenu's
// listChatSessions / deleteChatSession / loadChatSession ride GET /api/chat/sessions,
// DELETE+GET /api/chat/session/:id, and the model chip rides the per-request `model` on
// POST /api/chat. No live backend — every endpoint is a page.route mock.
//
// 多会话 is owner-only (§26.5): seed a token + mock GET /api/auth/me so the designer mounts
// logged-in (otherwise the list never loads + the chat 401s). The SessionMenu lives in the
// ConversationThread header `actions` slot; its trigger is a DS IconButton labelled 会话.
//
// ROUTE DISJOINTNESS (load-bearing): glob `**/api/chat` (mockChat) matches a URL ending
// exactly in /api/chat, so it does NOT capture /api/chat/sessions nor /api/chat/session/:id —
// those get their own handlers below. The persistence spec's `**/api/chat/session/**` (note
// the trailing slash) is likewise disjoint from /api/chat/sessions.
const TOKEN = "fake.jwt.token";

// A logged-in owner: mock GET /api/auth/me + seed the bearer token into localStorage before
// navigation (mirrors designer.spec.js / chat-session-persistence.spec.js).
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

// The owner's other design conversations, most-recent-first (the order GET /api/chat/sessions
// promises, §26.9). Distinct title / turnCount / updatedAt so the list rows are distinguishable.
const SESSIONS = [
  {
    sessionId: "ds-events",
    title: "线下活动报名表",
    turnCount: 7,
    formSlug: null,
    updatedAt: "2026-06-13T10:00:00.000Z",
  },
  {
    sessionId: "ds-survey",
    title: "客户满意度问卷",
    turnCount: 3,
    formSlug: null,
    updatedAt: "2026-06-13T08:00:00.000Z",
  },
];

// Mock the multi-session backend (GET /api/chat/sessions + per-session GET/DELETE) over a
// tiny in-memory store, so list → delete → re-list reflects the removal exactly as the real
// backend would. The active design session id (client-minted into localStorage) is unknown to
// the test, so /api/chat/session/:id GET returns the canned transcript for the ids we know and
// { session: null } (empty restore) for anything else (incl. the mount-time active id).
//
// Returns the store so a test can assert on what the server saw (e.g. the deleted id).
async function mockSessions(page, { sessions = SESSIONS, transcripts = {} } = {}) {
  const store = { sessions: sessions.map((s) => ({ ...s })) };

  // GET /api/chat/sessions — the owner's list, most-recent-first.
  await page.route("**/api/chat/sessions", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: store.sessions }),
    });
  });

  // GET (restore) / DELETE one session — /api/chat/session/:id (note: no trailing list).
  await page.route("**/api/chat/session/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const id = decodeURIComponent(url.pathname.split("/").pop() || "");
    if (req.method() === "DELETE") {
      const before = store.sessions.length;
      store.sessions = store.sessions.filter((s) => s.sessionId !== id);
      store.deleted = id;
      if (store.sessions.length === before) {
        // foreign / never-existed id → 404 「会话不存在」 (§26.8/§26.9).
        await route.fulfill({
          status: 404,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "会话不存在" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleted: true }),
      });
      return;
    }
    // GET (restore): the canned transcript for a known id, else empty (null = 初始空态).
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: transcripts[id] || null }),
    });
  });

  return store;
}

// Open the SessionMenu (the 会话 IconButton in the ConversationThread header → DS Popover).
async function openSessionMenu(page) {
  await page.getByRole("button", { name: "会话" }).click();
}

test.describe("Agentaily Forms · 多会话管理 + 对话级模型 (§26.9 / §13.6)", () => {
  test.beforeEach(async ({ page }) => {
    await mockChat(page);
    await seedSession(page);
  });

  // Scenario: owner 列出自己的全部会话(最近更新在前)— the SessionMenu lists them.
  test("会话菜单列出 owner 的会话(标题 + N 轮 + 当前打勾)", async ({ page }) => {
    await mockSessions(page);
    await page.goto("/");

    await openSessionMenu(page);

    // 「新会话」入口 + 每段会话的标题 + 「N 轮」meta 都出现在面板里。
    await expect(page.getByRole("menu").getByText("新会话")).toBeVisible();
    await expect(page.getByText("线下活动报名表", { exact: true })).toBeVisible();
    await expect(page.getByText("客户满意度问卷", { exact: true })).toBeVisible();
    await expect(page.getByText("7 轮", { exact: false })).toBeVisible();
    await expect(page.getByText("3 轮", { exact: false })).toBeVisible();

    // 当前活跃会话(mount 时 client-minted 的 id,不在 SESSIONS 里)→ 这两行都是非当前,
    // 都该有删除按钮、都不打勾。打勾(check)只出现在当前项,这里没有当前项命中列表 → 0 个勾、2 个删除按钮。
    await expect(page.getByRole("button", { name: "删除会话" })).toHaveCount(2);
  });

  // Scenario: 新建会话清空当前对话工作区并开新 session.
  test("新会话清空工作区(对话区回空态、预览字段清空)", async ({ page }) => {
    await mockSessions(page);
    await page.goto("/");

    // 先建一份表单:对话区非空(空态标题消失)+ 预览有 9 个字段。
    await page.getByText("做一个线下活动报名表").click();
    await expect(page.getByRole("button", { name: "发布", exact: true })).toBeEnabled({
      timeout: 20_000,
    });
    await expect(page.locator(".pv-fields > div")).toHaveCount(9);
    await expect(page.getByText("描述你想要的表单")).toHaveCount(0);

    // When 新会话。
    await openSessionMenu(page);
    await page.getByRole("menu").getByText("新会话").click();

    // Then 对话线程回初始空态(emptyTitle 重新可见)+ 预览字段清空。
    await expect(page.getByText("描述你想要的表单")).toBeVisible();
    await expect(page.locator(".pv-fields > div")).toHaveCount(0);
  });

  // Scenario: 切换到另一段会话载回该会话的转写.
  test("切换到另一段会话载回其转写", async ({ page }) => {
    // ds-survey 的 GET 返回一段带 user/assistant 文本的历史。
    await mockSessions(page, {
      transcripts: {
        "ds-survey": {
          sessionId: "ds-survey",
          turns: [
            { id: "s1", role: "user", text: "切换载回的历史·唯一标记" },
            { id: "s2", role: "assistant", kind: "text", text: "这是另一段会话的助手回复" },
          ],
          history: [{ role: "system", content: "你是设计助手" }],
          formSlug: null,
        },
      },
    });
    await page.goto("/");

    await openSessionMenu(page);
    // 切到客户满意度问卷(ds-survey)。
    await page.getByText("客户满意度问卷", { exact: true }).click();

    // Then 该会话的转写按原顺序渲染回对话区。
    await expect(page.getByText("切换载回的历史·唯一标记")).toBeVisible();
    await expect(page.getByText("这是另一段会话的助手回复")).toBeVisible();
  });

  // Scenario: owner 删除自己的一段会话 — 该会话不再出现在列表里.
  test("删除一段会话后该行从列表消失", async ({ page }) => {
    const store = await mockSessions(page);
    await page.goto("/");

    await openSessionMenu(page);
    await expect(page.getByText("客户满意度问卷", { exact: true })).toBeVisible();

    // 直接点该行的删除按钮(不必真悬停;按钮始终在 DOM 里,只是悬停才显形)。用 data-session-id 定位行。
    const row = page.locator('[data-session-id="ds-survey"]');
    await row.getByRole("button", { name: "删除会话" }).click();

    // DELETE 命中 → 服务端记下删除 + 列表刷新后该行消失。
    await expect.poll(() => store.deleted).toBe("ds-survey");
    await expect(page.getByText("客户满意度问卷", { exact: true })).toHaveCount(0);
    // 另一段会话不受影响,依旧在列表里。
    await expect(page.getByText("线下活动报名表", { exact: true })).toBeVisible();
  });

  // Scenario Outline: 对话级选用模型后请求带上该 per-request 模型 (DeepSeek-V4-Pro)
  // —— 选 V4-Pro → pill 变文案 → 此后发的 POST /api/chat 请求体带 model: "DeepSeek-V4-Pro"。
  test("选 V4-Pro:芯片改文案 + 后续请求带 per-request model", async ({ page }) => {
    await mockSessions(page, { sessions: [] });

    // 截 POST /api/chat 读 postData 验证 per-request model。LIFO:这条比 beforeEach 的 mockChat
    // 后注册,先命中;读完 model 后 fallback 到 mockChat 的 canned SSE 流。
    const sentModels = [];
    await page.route("**/api/chat", async (route) => {
      try {
        sentModels.push(JSON.parse(route.request().postData() || "{}").model);
      } catch {
        sentModels.push(undefined);
      }
      await route.fallback(); // mockChat 出 SSE
    });

    await page.goto("/");

    // 点 composer 上的模型 pill(DS 0.11.0 起它是个真实 button,点它触发 DS 透传的 onModelClick
    // 开下拉 —— App 不再截点击)。.ax-composer__model 仍是 DS 内部类,这里仅用它在测试里定位 pill
    // (语义角色不可达,可接受用此内部类定位)。
    const chip = page.locator(".ax-composer__model");
    await expect(chip).toBeVisible();
    // 默认 pill 是 V4-Flash。
    await expect(chip).toContainText("DeepSeek · V4-Flash");
    await chip.click();

    // 弹层两项 + 描述(通用·快 / 更强·深度推理)。
    const popup = page.locator(".cm-menu");
    await expect(popup.getByText("DeepSeek-V4-Flash", { exact: true })).toBeVisible();
    await expect(popup.getByText("DeepSeek-V4-Pro", { exact: true })).toBeVisible();
    await expect(popup.getByText("通用 · 快")).toBeVisible();
    await expect(popup.getByText("更强 · 深度推理")).toBeVisible();

    // 选 V4-Pro → pill 文案变。
    await popup.getByText("DeepSeek-V4-Pro", { exact: true }).click();
    await expect(chip).toContainText("DeepSeek · V4-Pro");

    // 此后发一条消息 → POST /api/chat 请求体带 model = V4-Pro 的小写 wire id（显示名 DeepSeek-V4-Pro，
    // 发上游的是 deepseek-v4-pro —— 大小写敏感,驼峰会 400)。
    await page.getByText("做一个线下活动报名表").click();
    await expect(page.getByRole("button", { name: "发布", exact: true })).toBeEnabled({
      timeout: 20_000,
    });
    expect(sentModels.length).toBeGreaterThan(0);
    expect(sentModels[0]).toBe("deepseek-v4-pro");
  });
});
