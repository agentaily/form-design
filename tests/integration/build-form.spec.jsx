import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each step as its own test,
// so cleanup must happen per scenario (AfterEachScenario), not per step.
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/build-form.feature"));

// Drive the scripted runner's setTimeout-based timeline to completion in virtual time.
async function runScript() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

describeFeature(feature, ({ Scenario, BeforeEachScenario, AfterEachScenario }) => {
  BeforeEachScenario(() => {
    vi.useFakeTimers();
  });
  AfterEachScenario(() => {
    cleanup();
    vi.useRealTimers();
  });

  Scenario("从提示词搭出活动报名表", ({ Given, When, Then, And }) => {
    Given("设计器处于空状态", () => {
      render(<App />);
      expect(screen.getByText("描述你想要的表单")).toBeInTheDocument();
    });
    When("作者选择「做一个线下活动报名表」起步提示", async () => {
      fireEvent.click(screen.getByText("做一个线下活动报名表"));
      await runScript();
    });
    Then("Agent 把表单封面渲染到预览", () => {
      expect(screen.getByText(/Agentaily 开发者沙龙/)).toBeInTheDocument();
    });
    And("预览里挂载了 9 个字段", () => {
      expect(document.querySelectorAll(".pv-fields > div")).toHaveLength(9);
    });
    And("对话给出后续修改建议", () => {
      expect(screen.getByText("发布并生成链接")).toBeInTheDocument();
    });
  });

  Scenario("搭好后发布表单", ({ Given, When, Then, And }) => {
    Given("设计器处于空状态", () => {
      render(<App />);
      expect(screen.getByText("描述你想要的表单")).toBeInTheDocument();
    });
    When("作者选择「做一个线下活动报名表」起步提示", async () => {
      fireEvent.click(screen.getByText("做一个线下活动报名表"));
      await runScript();
    });
    And("作者点击顶栏「发布」", async () => {
      fireEvent.click(screen.getByRole("button", { name: "发布" }));
      await runScript();
    });
    Then("表单状态变为 LIVE", () => {
      expect(screen.getByText("LIVE")).toBeInTheDocument();
    });
    And("弹出带公开链接的分享弹窗", () => {
      expect(screen.getByText("forms.agentaily.dev/agentaily-salon-sh")).toBeInTheDocument();
    });
  });
});
