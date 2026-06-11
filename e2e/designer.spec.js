import { test, expect } from "@playwright/test";
import { mockChat } from "./chatMock.js";

// End-to-end against the real designer in a real browser. The chat designer
// streams from POST /api/chat (OpenAI/DeepSeek tool-calling); mockChat intercepts
// it with a canned SSE stream so the build is deterministic and needs no backend.
test.describe("Agentaily Forms · 设计器", () => {
  test.beforeEach(async ({ page }) => {
    await mockChat(page);
    await page.goto("/");
  });

  test("empty state offers starter prompts", async ({ page }) => {
    await expect(page.getByText("描述你想要的表单")).toBeVisible();
    await expect(page.getByText("做一个线下活动报名表")).toBeVisible();
  });

  test("builds a form via the agent, blocks empty submit, then publishes", async ({ page }) => {
    // build — the follow-up suggestion chip appears once the turn settles
    await page.getByText("做一个线下活动报名表").click();
    await expect(page.getByText("加一个备注字段")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".pv-hero__title")).toHaveText("Agentaily 开发者沙龙 · 上海站");
    await expect(page.locator(".pv-fields > div")).toHaveCount(9);

    // required validation blocks an empty submit
    await page.getByRole("button", { name: "提交报名" }).click();
    await expect(page.getByText("此项必填").first()).toBeVisible();

    // publish from the header → LIVE + share dialog with the public link
    await page.getByRole("button", { name: "发布", exact: true }).click();
    await expect(page.getByText("LIVE")).toBeVisible();
    await expect(page.locator(".d-share__url")).toHaveText(
      "forms.agentaily.dev/agentaily-salon-sh",
    );
  });
});
