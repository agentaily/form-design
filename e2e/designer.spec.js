import { test, expect } from "@playwright/test";

// End-to-end against the real designer (real browser, real scripted timeline).
test.describe("Agentaily Forms · 设计器", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("empty state offers starter prompts", async ({ page }) => {
    await expect(page.getByText("描述你想要的表单")).toBeVisible();
    await expect(page.getByText("做一个线下活动报名表")).toBeVisible();
  });

  test("builds a form, blocks empty submit, then publishes", async ({ page }) => {
    // build
    await page.getByText("做一个线下活动报名表").click();
    await expect(page.getByText(/Agentaily 开发者沙龙/)).toBeVisible({ timeout: 40_000 });
    await expect(page.locator(".pv-fields > div")).toHaveCount(9, { timeout: 40_000 });

    // required validation blocks an empty submit
    await page.getByRole("button", { name: "提交报名" }).click();
    await expect(page.getByText("此项必填").first()).toBeVisible();

    // publish from the header → LIVE + share dialog with the public link
    await page.getByRole("button", { name: "发布", exact: true }).click();
    await expect(page.getByText("LIVE")).toBeVisible({ timeout: 20_000 });
    // the share dialog shows the public link (scope to the dialog — the tool-call
    // result echoes the same URL elsewhere in the thread)
    await expect(page.locator(".d-share__url")).toHaveText(
      "forms.agentaily.dev/agentaily-salon-sh",
    );
  });
});
