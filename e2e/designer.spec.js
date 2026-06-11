import { test, expect } from "@playwright/test";

// End-to-end against the real designer in a real browser. The chat designer
// streams from POST /api/chat (OpenAI/DeepSeek tool-calling); we intercept it with
// a canned SSE stream so the build is deterministic and needs no live backend:
// turn 1 sets the cover + adds 9 fields via tool calls, turn 2 closes with prose.
const META = {
  kicker: "ACTIVITY · REGISTRATION",
  title: "Agentaily 开发者沙龙 · 上海站",
  desc: "6 月 28 日 · 西岸 AI 汇 · 一个下午的现场动手与交流。",
  meta: ["2026.06.28 SAT", "13:30–18:00", "上海 · 西岸艺术中心"],
};
const FIELDS = [
  { type: "text", label: "姓名", required: true },
  { type: "tel", label: "手机号", required: true },
  { type: "email", label: "邮箱", required: true },
  { type: "text", label: "公司 / 团队" },
  { type: "radio", label: "票种", required: true, options: ["普通票", "Workshop 票", "学生票"] },
  { type: "checks", label: "想参加的环节", options: ["主题演讲", "动手工作坊", "项目展示"] },
  { type: "select", label: "技术方向", options: ["前端", "后端", "AI"] },
  { type: "textarea", label: "想和讲者聊点什么？" },
  { type: "consent", label: "我已阅读并同意活动须知与隐私条款", required: true },
];

const sseToolCalls = (calls) =>
  calls
    .map(
      (c, i) =>
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: i,
                    id: `c${i}`,
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
    )
    .join("") + "data: [DONE]\n\n";

const sseText = (text) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` + "data: [DONE]\n\n";

test.describe("Agentaily Forms · 设计器", () => {
  test.beforeEach(async ({ page }) => {
    // Mock the streaming chat proxy: turn 1 → tool calls; turn 2+ → closing prose.
    let n = 0;
    await page.route("**/api/chat", async (route) => {
      n += 1;
      const body =
        n === 1
          ? sseToolCalls([
              { name: "set_form_meta", args: META },
              ...FIELDS.map((f) => ({ name: "add_field", args: f })),
            ])
          : sseText("搭好了 ✦ 共 9 个字段。你可以试填，或继续告诉我怎么改。");
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body,
      });
    });
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
