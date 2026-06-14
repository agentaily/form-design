import { test, expect } from "@playwright/test";
import { mockChat, mockPublish, META } from "./chatMock.js";

// End-to-end realization of URL 状态持久化 (PR #76, features/url-state-persistence.feature) in a
// real browser. Two promises the feature makes that a unit/integration test can't fully cover:
//   1. 设计会话进 URL + 刷新【完整】恢复对话 + 工作区: an owner chats → a form is built → the URL
//      carries ?s=<id> → a full page reload re-fetches the session AND rebuilds BOTH the chat
//      thread and the right-pane form PREVIEW (the workspace), not just the conversation.
//   2. 设置 tab 进 URL: opening settings reflects /settings/:tab; switching tabs updates the path;
//      a deep-link / reload lands on the right tab.
//
// Builds on e2e/chat-session-persistence.spec.js: same login seed + same in-memory chat-session
// store backing GET/PUT so writes and reads share state across the reload. The workspace snapshot
// rides inside the opaque turns_json (PR #76), so the same store round-trips it for free.
const TOKEN = "fake.jwt.token";

async function seedSession(page) {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", emailVerified: true }),
    });
  });
  // settings 集成 tab fetches the masked config; keep it empty + deterministic.
  await page.route("**/api/config", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deepseek: {}, feishu: {}, updatedAt: null }),
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
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: store.session }),
    });
  });
  return store;
}

test.describe("Agentaily Forms · URL 状态持久化 (PR #76)", () => {
  test.beforeEach(async ({ page }) => {
    await mockChat(page);
    await mockPublish(page);
  });

  test("聊一回合 → 地址栏带 ?s= → 刷新【完整】恢复对话 + 工作区预览", async ({ page }) => {
    await seedSession(page);
    const store = await mockChatSession(page);
    await page.goto("/");

    // 设计会话进 URL:进入设计器即把会话规整进 ?s=（可分享/可书签）。
    await expect.poll(() => new URL(page.url()).searchParams.get("s")).toBeTruthy();
    const sid = new URL(page.url()).searchParams.get("s");

    // 一回合:Agent 建表 + 收尾 prose；回合结束后右侧预览出现表单封面标题（工作区已生成）。
    await page.getByText("做一个线下活动报名表").click();
    await expect(page.getByRole("button", { name: "发布", exact: true })).toBeEnabled({
      timeout: 20_000,
    });
    await expect(page.locator(".pv-hero__title")).toHaveText(META.title);
    // 回合结束批量写入后端（含工作区快照）。
    await expect.poll(() => store.session, { timeout: 10_000 }).not.toBeNull();

    // —— 刷新页面（同一 ?s= URL）——
    await page.reload();

    // 对话恢复:收尾 prose 还在、空态不在。
    await expect(page.getByText("搭好了", { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("描述你想要的表单")).toHaveCount(0);
    // 工作区恢复:右侧预览的表单封面标题重新出现（只有预览渲染 .pv-hero__title，不是对话卡片）。
    await expect(page.locator(".pv-hero__title")).toHaveText(META.title);
    // 字段也回来了（预览里至少一个字段块）。
    await expect(page.locator(".pv-fieldwrap").first()).toBeVisible();
    // 地址栏仍是同一段会话。
    expect(new URL(page.url()).searchParams.get("s")).toBe(sid);
  });

  test("设置 tab 进 URL:打开/切换反映进路径，刷新落回对应 tab", async ({ page }) => {
    await seedSession(page);
    await mockChatSession(page);
    await page.goto("/");
    await expect.poll(() => new URL(page.url()).searchParams.get("s")).toBeTruthy();

    // 打开「集成设置」→ /settings/integrations。
    await page.locator(".am-acct").click();
    await page.getByRole("menuitem", { name: /集成设置/ }).click();
    await expect(page.getByRole("button", { name: "保存" })).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/integrations");

    // 切到「账户」tab → /settings/account（nav 项是 exact「账户」，区别于头部「账户菜单」触发器）。
    await page.getByRole("button", { name: "账户", exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/account");

    // 刷新 /settings/account → 直接落在账户 tab（可编辑「显示名称」是账户 tab 专属）。
    await page.reload();
    await expect(page.getByText("显示名称")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/account");
  });
});
