import { test, expect } from "@playwright/test";

// End-to-end of the owner register / login flow (SPEC §17, open-registration
// multi-user) in a real browser. Since the UI refactor login is a standalone /signin
// page (DS SignInPage, 登录 / 注册 双模) reached from the header AccountControl 登录
// button — not an in-app modal. We intercept POST /api/auth/register, /api/auth/login
// and GET /api/auth/me so the flow is deterministic and needs no backend:
//   - register: a fresh email → 201 { token }; an already-"taken" email → 409.
//   - login:    the registered email + password → 200 { token }; anything else
//               → a UNIFIED 401 (the backend never reveals 邮箱不存在 vs 密码错, §17.3).
//   - me:       once a token is held, the designer reads it → { email, emailVerified }.
const KNOWN_EMAIL = "owner@example.com";
const KNOWN_PASSWORD = "open-sesame-8chars";
const TAKEN_EMAIL = "taken@example.com";

async function mockAuth(page) {
  await page.route("**/api/auth/register", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.email === TAKEN_EMAIL) {
      await route.fulfill({
        status: 409,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "email already registered" }),
      });
      return;
    }
    await route.fulfill({
      status: 201,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "fake.jwt.token" }),
    });
  });

  await page.route("**/api/auth/login", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.email === KNOWN_EMAIL && body.password === KNOWN_PASSWORD) {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "fake.jwt.token" }),
      });
    } else {
      // Unified 401 — same response for 邮箱不存在 AND 密码错 (anti-enumeration, §17.3).
      await route.fulfill({
        status: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "未授权" }),
      });
    }
  });

  // Once logged in the designer reads GET /api/auth/me to fill the account control.
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: KNOWN_EMAIL, emailVerified: true }),
    });
  });
}

test.describe("Agentaily Forms · owner 注册 / 登录", () => {
  test.beforeEach(async ({ page }) => {
    await mockAuth(page);
    await page.goto("/");
  });

  test("wrong credentials error, correct credentials log in, then logout", async ({ page }) => {
    // From the designer, the header AccountControl 登录 button routes to the /signin page.
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/signin/);
    // SignInPage in 登录 mode by default.
    await expect(page.getByRole("heading", { name: "登录 Agentaily Forms" })).toBeVisible();

    // Wrong email/password → the unified, anti-enumeration error, still on /signin.
    await page.locator('input[type="email"]').fill(KNOWN_EMAIL);
    await page.getByPlaceholder("输入登录密码").fill("definitely-wrong");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    // SignInPage's own danger banner (0.5.0 `error` seam) above the submit button.
    await expect(page.getByRole("alert")).toContainText("账号或密码错误，请重试。");
    await expect(page).toHaveURL(/\/signin/);

    // Correct email + password → token persisted → navigate back to the designer, where
    // the AccountControl now shows the signed-in avatar menu.
    await page.locator('input[type="email"]').fill(KNOWN_EMAIL);
    await page.getByPlaceholder("输入登录密码").fill(KNOWN_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("button", { name: "账户菜单" })).toBeVisible();

    // Logout: open the avatar menu → 退出登录 → the signed-out 登录 button returns.
    await page.getByRole("button", { name: "账户菜单" }).click();
    await page.getByRole("menuitem", { name: /退出登录/ }).click();
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "账户菜单" })).toHaveCount(0);
  });

  test("new email self-registers (注册即登录); a taken email errors", async ({ page }) => {
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/signin/);

    // Switch to 注册 (signup) mode via the SignInPage footer link.
    await page.getByRole("button", { name: "注册一个" }).click();
    await expect(page.getByRole("heading", { name: "创建 owner 账户" })).toBeVisible();

    // A taken email → 409 readable error, still on /signin.
    await page.locator('input[type="email"]').fill(TAKEN_EMAIL);
    await page.getByPlaceholder("设置一个至少 8 位的密码").fill(KNOWN_PASSWORD);
    await page.getByPlaceholder("再次输入密码").fill(KNOWN_PASSWORD);
    await page.getByRole("button", { name: "注册并继续" }).click();
    await expect(page.getByRole("alert")).toContainText("该邮箱已注册，请直接登录。");
    await expect(page).toHaveURL(/\/signin/);

    // A fresh email + ≥ 8-char password → 201 注册即登录 → navigate back to the designer,
    // where the AccountControl now shows the signed-in avatar menu.
    await page.locator('input[type="email"]').fill("brand-new@example.com");
    await page.getByPlaceholder("设置一个至少 8 位的密码").fill(KNOWN_PASSWORD);
    await page.getByPlaceholder("再次输入密码").fill(KNOWN_PASSWORD);
    await page.getByRole("button", { name: "注册并继续" }).click();
    await expect(page.getByRole("button", { name: "账户菜单" })).toBeVisible();
  });
});
