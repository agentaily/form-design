// Shared e2e helper: intercept the streaming chat proxy (POST /api/chat) with a
// canned OpenAI/DeepSeek SSE stream so the designer build is deterministic and
// needs no live backend. Turn 1 sets the cover + adds the fields via tool calls;
// turn 2 (and any later send) closes with prose so the agent loop stops.

export const META = {
  kicker: "ACTIVITY · REGISTRATION",
  title: "Agentaily 开发者沙龙 · 上海站",
  desc: "6 月 28 日 · 西岸 AI 汇 · 一个下午的现场动手与交流。",
  meta: ["2026.06.28 SAT", "13:30–18:00", "上海 · 西岸艺术中心"],
};

export const FIELDS = [
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

/** Install the canned /api/chat route on a Playwright page. Call before navigation. */
export async function mockChat(page, { meta = META, fields = FIELDS } = {}) {
  let n = 0;
  await page.route("**/api/chat", async (route) => {
    n += 1;
    const body =
      n === 1
        ? sseToolCalls([
            { name: "set_form_meta", args: meta },
            ...fields.map((f) => ({ name: "add_field", args: f })),
          ])
        : sseText("搭好了 ✦ 共 9 个字段。你可以试填，或继续告诉我怎么改。");
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
  });
}

/**
 * Install the canned POST /api/forms route (SPEC §16.2 publish) on a Playwright page.
 * Returns 200 with a PublishResult `{ slug }` so the direct 发布 action succeeds without a
 * backend: it pops the ShareDialog with the public fill link /f/:slug and flips the header
 * badge to LIVE (the just-published form becomes the active edit target).
 * Only intercepts the POST; other methods (the §21 list/patch/delete) fall through.
 * Call before navigation (or at least before clicking 发布).
 */
export async function mockPublish(page, { slug = "f8Kq2pXa" } = {}) {
  await page.route("**/api/forms", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
  });
}
