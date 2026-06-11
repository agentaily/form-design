import { test, expect } from "@playwright/test";

// End-to-end of the owner login flow (SPEC §17) in a real browser. We intercept
// POST /api/auth/login so the flow is deterministic and needs no backend: a
// matching password returns a token (→ "已登录"), anything else 401s (→ error).
async function mockLogin(page, { password = "open-sesame" } = {}) {
  await page.route("**/api/auth/login", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.password === password) {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "fake.jwt.token" }),
      });
    } else {
      await route.fulfill({
        status: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "未授权" }),
      });
    }
  });
}

test.describe("Agentaily Forms · owner 登录", () => {
  test.beforeEach(async ({ page }) => {
    await mockLogin(page);
    await page.goto("/");
  });

  test("wrong password errors, correct password logs in", async ({ page }) => {
    // open the account dialog from the header
    await page.getByRole("button", { name: "登录账户" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // wrong password → readable error, still logged out
    await page.getByPlaceholder("输入 owner 登录密码").fill("nope");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByText("密码错误，请重试。")).toBeVisible();

    // correct password → logged-in panel + header marked logged in
    await page.getByPlaceholder("输入 owner 登录密码").fill("open-sesame");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByText("已登录")).toBeVisible();
    await expect(page.getByRole("button", { name: "账户已登录" })).toBeVisible();

    // logout returns to the password form
    await page.getByRole("button", { name: "登出" }).click();
    await expect(page.getByPlaceholder("输入 owner 登录密码")).toBeVisible();
    await expect(page.getByRole("button", { name: "登录账户" })).toBeVisible();
  });
});
