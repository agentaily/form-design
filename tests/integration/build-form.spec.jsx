import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each step as its own test,
// so cleanup must happen per scenario (AfterEachScenario), not per step.
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { setToken, clearToken } from "../../src/core/apiClient";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/build-form.feature"));

// The designer talks to POST /api/chat (streamed OpenAI/DeepSeek tool-calling).
// We inject a fake `chat` so the build is deterministic: turn 1 sets the cover +
// adds 9 fields via tool calls, turn 2 closes with prose (no tools → loop stops).
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

function makeFakeChat() {
  let call = 0;
  return vi.fn(async ({ onText }) => {
    call += 1;
    if (call === 1) {
      return {
        text: "",
        toolCalls: [
          { id: "meta", name: "set_form_meta", argsRaw: JSON.stringify(META) },
          ...FIELDS.map((f, i) => ({
            id: `f${i}`,
            name: "add_field",
            argsRaw: JSON.stringify(f),
          })),
        ],
      };
    }
    // The closing turn: prose + LLM-driven follow-up modification suggestions. Since the
    // DS migration the fixed FOLLOWUP chips below the composer are gone; suggestions are
    // now a per-message kind (text + suggestions) rendered by renderChatTurn via the DS
    // <Suggestions>. So the agent's closing turn carries them.
    const text = "搭好了 ✦ 共 9 个字段。你可以直接试填，或继续告诉我怎么改。";
    onText?.(text);
    return {
      text,
      toolCalls: [],
      suggestions: ["加一个备注字段", "把手机号设为必填", "换个封面文案"],
    };
  });
}

// Drive the agent turn to completion. The build settles when the turn ends
// (building → false): the 发布 button is `disabled={building || fieldCount === 0}`,
// so its becoming enabled means the form is built AND the turn closed. (We no longer
// gate on a suggestion chip — those moved from a fixed footer affordance to a
// per-message kind, and gating the whole flow on them would mask the cover/fields
// assertions if the suggestions wiring regresses.)
async function awaitBuilt() {
  await waitFor(() => expect(screen.getByRole("button", { name: "发布" })).toBeEnabled());
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => {
    cleanup();
    clearToken();
  });

  Scenario("从提示词搭出活动报名表", ({ Given, When, Then, And }) => {
    Given("设计器处于空状态", () => {
      render(<App chat={makeFakeChat()} />);
      expect(screen.getByText("描述你想要的表单")).toBeInTheDocument();
    });
    When("作者选择「做一个线下活动报名表」起步提示", async () => {
      fireEvent.click(screen.getByText("做一个线下活动报名表"));
      await awaitBuilt();
    });
    Then("Agent 把表单封面渲染到预览", () => {
      // scope to the preview hero — the set_form_meta tool-call card echoes the
      // same title in its args, so a bare getByText would match multiple nodes.
      expect(document.querySelector(".pv-hero__title")).toHaveTextContent(
        "Agentaily 开发者沙龙 · 上海站",
      );
    });
    And("预览里挂载了 9 个字段", () => {
      expect(document.querySelectorAll(".pv-fields > div")).toHaveLength(9);
    });
    And("对话给出后续修改建议", async () => {
      // The closing assistant turn carries follow-up modification suggestions, rendered
      // as DS suggestion chips under the prose (the message model's text+suggestions kind).
      await screen.findByText("加一个备注字段");
      expect(screen.getByText("加一个备注字段")).toBeInTheDocument();
    });
  });

  Scenario("搭好后发布表单", ({ Given, When, Then, And }) => {
    // Real publish (§16): clicking 发布 opens <PublishFeedback>, which calls the
    // injected publishForm(meta, fields) → { slug } and renders the public fill link
    // /f/:slug for that slug. We inject publishForm + publicFormUrl as the App-level
    // seam (same pattern as chat/login) so the flow is deterministic without a backend.
    //
    // Since the UI refactor 发布 is a gated action: signed-out it routes to /signin
    // (guard), so the publish itself only runs for a logged-in owner. We seed a token to
    // put the App in a logged-in session so 发布 opens PublishFeedback directly.
    const publishForm = vi.fn(async () => ({ slug: "f8Kq2pXa" }));
    const publicFormUrl = vi.fn((slug) => `/f/${slug}`);
    Given("设计器处于空状态", () => {
      setToken("owner-jwt");
      render(
        <App
          chat={makeFakeChat()}
          publishForm={publishForm}
          publicFormUrl={publicFormUrl}
          getCurrentUser={async () => ({ email: "owner@example.com", emailVerified: true })}
        />,
      );
      expect(screen.getByText("描述你想要的表单")).toBeInTheDocument();
    });
    When("作者选择「做一个线下活动报名表」起步提示", async () => {
      fireEvent.click(screen.getByText("做一个线下活动报名表"));
      await awaitBuilt();
    });
    And("作者点击顶栏「发布」", async () => {
      const publish = screen.getByRole("button", { name: "发布" });
      await waitFor(() => expect(publish).toBeEnabled());
      fireEvent.click(publish);
    });
    Then("调用发布接口把当前表单发布出去", async () => {
      await waitFor(() => expect(publishForm).toHaveBeenCalled());
    });
    And("展示该表单的公开填写链接", async () => {
      // The real publish surface renders the /f/:slug public fill link for the
      // returned slug — not the old static forms.agentaily.dev placeholder.
      await screen.findByText("/f/f8Kq2pXa", { exact: false });
    });
  });
});
