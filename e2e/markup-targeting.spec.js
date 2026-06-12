import { test, expect } from "@playwright/test";
import { mockChat } from "./chatMock.js";

// End-to-end of the preview "指向修改 / element targeting" flow in a real browser,
// where real layout + elementFromPoint hit-testing actually work (unlike jsdom).
// Build a form (via the mocked /api/chat agent) → enter targeting mode → hover a
// field (highlight + identity tag) → click → type → send → the tagged user message
// lands in the LEFT chat → targeting mode auto-exits.
test.describe("Agentaily Forms · 指向修改", () => {
  test.beforeEach(async ({ page }) => {
    await mockChat(page);
    await page.goto("/");
  });

  test("点击预览元素，描述修改并发送，带身份的消息进入左侧对话且退出模式", async ({ page }) => {
    // build the seeded form (hero + 9 fields + submit). Scope the hero to
    // .pv-hero__title — the set_form_meta tool-call card also echoes the title.
    await page.getByText("做一个线下活动报名表").click();
    await expect(page.locator(".pv-hero__title")).toHaveText("Agentaily 开发者沙龙 · 上海站", {
      timeout: 40_000,
    });
    await expect(page.locator(".pv-fields > div")).toHaveCount(9, { timeout: 40_000 });
    // The build streams a trailing assistant message after the 9th field, and
    // setBuilding(false) only fires once that finishes. Until then App.onSend drops
    // sends (the same `building` guard the composer uses). Wait on the 指向修改 entry:
    // it gates on `building` too, so it's enabled exactly when the build is done.
    await expect(page.getByRole("button", { name: "指向修改" })).toBeEnabled({ timeout: 40_000 });

    // the preview marks targetable elements with data-mk-* (hero / fields / submit)
    await expect(page.locator('.pv-hero[data-mk-label="表单标题与介绍"]')).toBeAttached();
    await expect(page.locator('[data-mk-label="姓名"][data-mk-kind="输入框"]')).toBeAttached();
    await expect(
      page.locator('.pv-footer[data-mk-label="提交按钮"][data-mk-kind="按钮"]'),
    ).toBeAttached();

    // enter targeting mode from the preview toolbar
    await page.getByRole("button", { name: "指向修改" }).click();
    await expect(page.locator(".ax-markup")).toBeVisible();
    await expect(page.getByText("移到要改的地方，点击它再描述修改")).toBeVisible();

    // hover the 提交按钮 region → highlight box + identity tag appear.
    // The markup canvas sits over the preview; hover at the submit button's center
    // so elementFromPoint resolves the .pv-footer[data-mk-label] ancestor.
    const submit = page.locator('.pv-footer[data-mk-label="提交按钮"]');
    await submit.scrollIntoViewIfNeeded();
    const box = await submit.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await expect(page.locator(".ax-markup__box")).toBeVisible();
    await expect(page.locator(".ax-markup__tag")).toContainText("提交按钮");
    await expect(page.locator(".ax-markup__tag")).toContainText("按钮");

    // click to select → composer pops below, frozen highlight, identity echoed
    await page.mouse.click(cx, cy);
    await expect(page.locator(".ax-markup__box.is-selected")).toBeVisible();
    await expect(page.locator(".ax-markup__pop")).toBeVisible();
    await expect(page.locator(".ax-markup__poptag")).toContainText("提交按钮 · 按钮");
    await expect(page.getByText("输入修改要求，发送到左侧对话")).toBeVisible();

    // empty note keeps the send button disabled
    await expect(page.locator(".ax-markup__done")).toBeDisabled();

    // type the modification and send to the conversation
    await page.locator(".ax-markup__ta").fill("改成『立即报名』");
    await expect(page.locator(".ax-markup__done")).toBeEnabled();
    await page.locator(".ax-markup__done").click();

    // the tagged user message lands in the LEFT chat, and targeting mode exits
    // .last() — the first .ax-msg--user is the starter brief; the markup send is the latest.
    await expect(page.locator(".ax-msg--user").last()).toContainText(
      "〔提交按钮 · 按钮〕改成『立即报名』",
    );
    await expect(page.locator(".ax-markup")).toHaveCount(0);
  });

  test("空表单时「指向修改」入口禁用", async ({ page }) => {
    // fresh designer, no fields yet → the entry is present on the preview tab but disabled
    await expect(page.getByRole("button", { name: "指向修改" })).toBeDisabled();
  });
});
