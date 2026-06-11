import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each step as its own test,
// so cleanup must happen per scenario (AfterEachScenario), not per step.
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";

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
    const text = "搭好了 ✦ 共 9 个字段。你可以直接试填，或继续告诉我怎么改。";
    onText?.(text);
    return { text, toolCalls: [] };
  });
}

// Drive the agent turn to completion: the follow-up suggestion chip only renders
// once the turn ends (building → false), so awaiting it means the build settled.
async function awaitBuilt() {
  await screen.findByText("加一个备注字段");
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => {
    cleanup();
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
    And("对话给出后续修改建议", () => {
      expect(screen.getByText("加一个备注字段")).toBeInTheDocument();
    });
  });

  Scenario("搭好后发布表单", ({ Given, When, Then, And }) => {
    Given("设计器处于空状态", () => {
      render(<App chat={makeFakeChat()} />);
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
    Then("表单状态变为 LIVE", () => {
      expect(screen.getByText("LIVE")).toBeInTheDocument();
    });
    And("弹出带公开链接的分享弹窗", () => {
      expect(screen.getByText("forms.agentaily.dev/agentaily-salon-sh")).toBeInTheDocument();
    });
  });
});
