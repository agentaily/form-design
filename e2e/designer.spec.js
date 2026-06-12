import { test, expect } from "@playwright/test";
import { mockChat, mockPublish } from "./chatMock.js";

// End-to-end against the real designer in a real browser. The chat designer
// streams from POST /api/chat (OpenAI/DeepSeek tool-calling); mockChat intercepts
// it with a canned SSE stream so the build is deterministic and needs no backend.
// mockPublish intercepts POST /api/forms (§16.2) so 发布 succeeds without a backend.
//
// Since the UI refactor 发布 is a gated action (signed-out → routes to /signin), so the
// publish test seeds a token before navigation (a logged-in owner) and mocks
// GET /api/auth/me, letting the header 发布 open PublishFeedback directly.
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

test.describe("Agentaily Forms · 设计器", () => {
  test.beforeEach(async ({ page }) => {
    await mockChat(page);
    await mockPublish(page);
  });

  test("empty state offers starter prompts", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("描述你想要的表单")).toBeVisible();
    await expect(page.getByText("做一个线下活动报名表")).toBeVisible();
  });

  test("builds a form via the agent, blocks empty submit, then publishes", async ({ page }) => {
    await seedSession(page);
    await page.goto("/");

    // build — driven by the starter prompt. The build settles when the turn ends:
    // the header 发布 button is `disabled={building || fieldCount === 0}`, so it
    // becoming enabled means the form is built AND the agent turn closed.
    await page.getByText("做一个线下活动报名表").click();
    await expect(page.getByRole("button", { name: "发布", exact: true })).toBeEnabled({
      timeout: 20_000,
    });
    await expect(page.locator(".pv-hero__title")).toHaveText("Agentaily 开发者沙龙 · 上海站");
    await expect(page.locator(".pv-fields > div")).toHaveCount(9);

    // required validation blocks an empty submit
    await page.getByRole("button", { name: "提交报名" }).click();
    await expect(page.getByText("此项必填").first()).toBeVisible();

    // publish from the header — logged in, so 发布 opens PublishFeedback, which
    // auto-publishes via POST /api/forms (mockPublish → { slug }) and renders the
    // public /f/:slug fill link; on success onPublished flips the badge DRAFT → LIVE.
    await page.getByRole("button", { name: "发布", exact: true }).click();
    await expect(page.locator(".d-publish__url")).toHaveText("/f/f8Kq2pXa");
    await expect(page.getByText("LIVE")).toBeVisible();
  });
});
