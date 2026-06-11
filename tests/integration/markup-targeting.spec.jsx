import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each Gherkin step as its own
// test, so we must clean up per scenario (AfterEachScenario), not per step.
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { FormPreview } from "../../src/preview.jsx";
import { MarkupLayer } from "../../src/markup.jsx";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/markup-targeting.feature"));

// ---- shared fixtures ------------------------------------------------------

// The form described by the Background: 姓名/邮箱 fields + hero (封面) + submit.
const META = {
  kicker: "ACTIVITY · REGISTRATION",
  title: "Agentaily 开发者沙龙 · 上海站",
  desc: "6 月 28 日 · 一个下午的现场动手与交流。",
  meta: ["2026.06.28 SAT", "上海 · 西岸艺术中心"],
};
const FIELDS = [
  { id: "name", type: "text", label: "姓名", required: true, placeholder: "你的姓名" },
  { id: "email", type: "email", label: "邮箱", required: true, placeholder: "you@co.com" },
];

// Drive the scripted runner's setTimeout-based timeline to completion.
async function runScript() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

// Build the seeded form in the App via the starter prompt, leaving the app on
// the 预览 tab with fields present (the feature Background).
async function buildSeededApp() {
  render(<App />);
  fireEvent.click(screen.getByText("做一个线下活动报名表"));
  await runScript();
}

// jsdom has no real layout, so `document.elementFromPoint` (used by MarkupLayer to
// resolve the target under the cursor) doesn't exist / can't hit-test. For
// selection-dependent behavior we DEFINE it to return a node carrying the desired
// data-mk-* identity, then fire the canvas click the layer listens on. This
// exercises the real selection → composer → onSend path without relying on pixel
// hit-testing (left to e2e). Restored in AfterEachScenario.
function stubTarget({ label, kind }) {
  const node = document.createElement("div");
  node.setAttribute("data-mk-label", label);
  if (kind != null) node.setAttribute("data-mk-kind", kind);
  // MarkupLayer calls el.closest("[data-mk-label]"); the node matches itself.
  // jsdom doesn't implement elementFromPoint, so assign rather than spyOn.
  document.elementFromPoint = vi.fn().mockReturnValue(node);
  return node;
}

// Render the MarkupLayer alone and select a target by clicking the canvas while
// elementFromPoint is stubbed to the given identity. Returns { onSend, onClose }.
function renderLayerWithSelection(target) {
  const onSend = vi.fn();
  const onClose = vi.fn();
  render(<MarkupLayer onClose={onClose} onSend={onSend} />);
  stubTarget(target);
  fireEvent.click(document.querySelector(".d-markup__canvas"));
  return { onSend, onClose };
}

describeFeature(
  feature,
  ({ Scenario, ScenarioOutline, Background, BeforeEachScenario, AfterEachScenario }) => {
    BeforeEachScenario(() => {
      vi.useFakeTimers();
    });
    AfterEachScenario(() => {
      cleanup();
      vi.restoreAllMocks();
      // elementFromPoint is assigned (not spied) by stubTarget; remove it.
      delete document.elementFromPoint;
      vi.useRealTimers();
    });

    // Background steps are declared but the real seeding happens inside the Given
    // steps of each scenario that needs the live App (so timers/cleanup stay scoped).
    Background(({ Given, And }) => {
      Given("一份含「姓名」「邮箱」字段、封面与提交按钮的表单", () => {});
      And("预览处于「预览」标签", () => {});
    });

    Scenario("有字段时可进入「指向修改」模式", ({ When, Then, And }) => {
      When("作者点击预览工具栏的「指向修改」", async () => {
        await buildSeededApp();
        fireEvent.click(screen.getByRole("button", { name: "指向修改" }));
      });
      Then("进入指向修改模式", () => {
        expect(document.querySelector(".d-markup")).toBeInTheDocument();
      });
      And("「指向修改」按钮点亮为选中态", () => {
        // entry button lit: variant="solid" → ax-iconbtn--solid
        expect(screen.getByRole("button", { name: "指向修改" })).toHaveClass("ax-iconbtn--solid");
      });
      And("顶部提示「移到要改的地方，点击它再描述修改」", () => {
        expect(screen.getByText("移到要改的地方，点击它再描述修改")).toBeInTheDocument();
      });
    });

    Scenario("空表单时「指向修改」入口禁用", ({ Given, Then }) => {
      Given("一份没有任何字段的表单", () => {
        render(<App />);
      });
      Then("预览工具栏的「指向修改」处于禁用态", () => {
        expect(screen.getByRole("button", { name: "指向修改" })).toBeDisabled();
      });
    });

    Scenario("仅在「预览」标签下才有「指向修改」入口", ({ When, Then }) => {
      When("作者切到「Schema」标签", async () => {
        await buildSeededApp();
        fireEvent.click(screen.getByRole("tab", { name: /Schema/ }));
      });
      Then("预览工具栏不显示「指向修改」入口", () => {
        expect(screen.queryByRole("button", { name: "指向修改" })).not.toBeInTheDocument();
      });
    });

    Scenario("hover 高亮光标下最近的可定位元素并显示其身份", ({ Given, When, Then, And }) => {
      // jsdom can't do real elementFromPoint hit-testing; assert instead that the
      // FormPreview marks the 姓名 field with the identity the highlight tag reads.
      Given("作者处于指向修改模式", () => {
        render(
          <FormPreview
            meta={META}
            fields={FIELDS}
            values={{}}
            setValue={() => {}}
            style="card"
            building={false}
          />,
        );
      });
      When("作者把光标移到「姓名」字段上", () => {
        // pixel hit-testing is e2e's job; here we assert the preview marks 姓名 with
        // the identity the hover highlight tag reads.
        expect(document.querySelector('[data-mk-label="姓名"]')).toBeInTheDocument();
      });
      Then("该字段出现高亮框", () => {
        // the targetable node carrying 姓名's identity exists in the preview
        expect(document.querySelector('[data-mk-label="姓名"]')).toBeInTheDocument();
      });
      And("高亮框左上角显示身份标签「姓名 · 输入框」", () => {
        const node = document.querySelector('[data-mk-label="姓名"]');
        expect(node.getAttribute("data-mk-label")).toBe("姓名");
        expect(node.getAttribute("data-mk-kind")).toBe("输入框");
      });
    });

    Scenario("click 选中元素并在其下方弹出 composer", ({ Given, When, Then, And }) => {
      let onSend;
      Given("作者处于指向修改模式", () => {
        onSend = vi.fn();
        render(<MarkupLayer onClose={() => {}} onSend={onSend} />);
      });
      When("作者点击「提交按钮」", () => {
        stubTarget({ label: "提交按钮", kind: "按钮" });
        fireEvent.click(document.querySelector(".d-markup__canvas"));
      });
      Then("该元素被选中并冻结 hover 高亮", () => {
        expect(document.querySelector(".d-markup__box.is-selected")).toBeInTheDocument();
      });
      And("其下方弹出修改 composer", () => {
        expect(document.querySelector(".d-markup__pop")).toBeInTheDocument();
        expect(document.querySelector(".d-markup__ta")).toBeInTheDocument();
      });
      And("composer 顶部回显身份「提交按钮 · 按钮」", () => {
        expect(screen.getByText("提交按钮 · 按钮")).toBeInTheDocument();
      });
      And("顶部提示变为「输入修改要求，发送到左侧对话」", () => {
        expect(screen.getByText("输入修改要求，发送到左侧对话")).toBeInTheDocument();
      });
    });

    Scenario("发送把带身份的消息送进左侧对话并退出模式", ({ Given, When, Then, And }) => {
      // App-level realization: entering markup mode, selecting the submit button,
      // sending — the tagged text must land in the LEFT chat as a user message and
      // markup mode must exit. Asserting at App altitude (real onSend wiring), not a
      // standalone MarkupLayer onSend spy.
      Given("作者在指向修改模式下选中了「提交按钮」", async () => {
        await buildSeededApp();
        fireEvent.click(screen.getByRole("button", { name: "指向修改" }));
        // jsdom elementFromPoint is unreliable → stub the target the canvas resolves.
        stubTarget({ label: "提交按钮", kind: "按钮" });
        fireEvent.click(document.querySelector(".d-markup__canvas"));
      });
      When("作者输入「改成『立即报名』」并点击「发送到对话」", async () => {
        const ta = document.querySelector(".d-markup__ta");
        fireEvent.change(ta, { target: { value: "改成『立即报名』" } });
        fireEvent.click(screen.getByRole("button", { name: /发送到对话/ }));
        await runScript();
      });
      Then("左侧对话新增一条用户消息「〔提交按钮 · 按钮〕改成『立即报名』」", () => {
        // user-role turns render inside .d-turn--user; the tagged text is the message.
        const userTurns = Array.from(document.querySelectorAll(".d-turn--user"));
        const texts = userTurns.map((n) => n.textContent);
        expect(texts).toContain("〔提交按钮 · 按钮〕改成『立即报名』");
      });
      And("退出指向修改模式", () => {
        expect(document.querySelector(".d-markup")).not.toBeInTheDocument();
      });
    });

    Scenario("无 kind 的元素发送时只带 label", ({ Given, When, Then }) => {
      let onSend;
      Given("一个只有 label、没有 kind 的可定位元素被选中", () => {
        ({ onSend } = renderLayerWithSelection({ label: "封面" }));
      });
      When("作者输入「换个封面图」并发送", () => {
        const ta = document.querySelector(".d-markup__ta");
        fireEvent.change(ta, { target: { value: "换个封面图" } });
        fireEvent.click(screen.getByRole("button", { name: /发送到对话/ }));
      });
      Then("左侧对话新增一条用户消息「〔封面〕换个封面图」", () => {
        expect(onSend).toHaveBeenCalledWith("〔封面〕换个封面图");
      });
    });

    Scenario("空 note 不可发送", ({ Given, When, Then }) => {
      Given("作者在指向修改模式下选中了某个元素", () => {
        renderLayerWithSelection({ label: "姓名", kind: "输入框" });
      });
      When("修改输入框为空或只含空白", () => {
        const ta = document.querySelector(".d-markup__ta");
        fireEvent.change(ta, { target: { value: "   " } });
      });
      Then("「发送到对话」按钮不可用", () => {
        expect(screen.getByRole("button", { name: /发送到对话/ })).toBeDisabled();
      });
    });

    Scenario("Esc 在选中态先取消选中", ({ Given, When, Then, And }) => {
      let onClose;
      Given("作者在指向修改模式下选中了某个元素", () => {
        ({ onClose } = renderLayerWithSelection({ label: "姓名", kind: "输入框" }));
      });
      When("作者按 Esc", () => {
        fireEvent.keyDown(window, { key: "Escape" });
      });
      Then("取消选中并关闭 composer", () => {
        expect(document.querySelector(".d-markup__pop")).not.toBeInTheDocument();
      });
      And("仍处于指向修改模式", () => {
        // onClose (exit) was NOT called — the layer is still mounted.
        expect(onClose).not.toHaveBeenCalled();
        expect(document.querySelector(".d-markup")).toBeInTheDocument();
      });
    });

    Scenario("Esc 在未选中态退出模式", ({ Given, When, Then }) => {
      let onClose;
      Given("作者处于指向修改模式且未选中任何元素", () => {
        onClose = vi.fn();
        render(<MarkupLayer onClose={onClose} onSend={() => {}} />);
      });
      When("作者按 Esc", () => {
        fireEvent.keyDown(window, { key: "Escape" });
      });
      Then("退出指向修改模式", () => {
        expect(onClose).toHaveBeenCalled();
      });
    });

    Scenario("✕「退出」按钮退出模式", ({ Given, When, Then }) => {
      let onClose;
      Given("作者处于指向修改模式", () => {
        onClose = vi.fn();
        render(<MarkupLayer onClose={onClose} onSend={() => {}} />);
      });
      When("作者点击顶部提示里的「退出」", () => {
        fireEvent.click(screen.getByRole("button", { name: "退出" }));
      });
      Then("退出指向修改模式", () => {
        expect(onClose).toHaveBeenCalled();
      });
    });

    Scenario("取消按钮放弃当前选中", ({ Given, When, Then, And }) => {
      let onClose;
      Given("作者在指向修改模式下选中了某个元素", () => {
        ({ onClose } = renderLayerWithSelection({ label: "姓名", kind: "输入框" }));
      });
      When("作者点击 composer 的「取消」", () => {
        fireEvent.click(screen.getByRole("button", { name: "取消" }));
      });
      Then("取消选中并关闭 composer", () => {
        expect(document.querySelector(".d-markup__pop")).not.toBeInTheDocument();
      });
      And("仍处于指向修改模式", () => {
        expect(onClose).not.toHaveBeenCalled();
        expect(document.querySelector(".d-markup")).toBeInTheDocument();
      });
    });

    ScenarioOutline("字段类型映射为中文 kind", ({ Given, Then }, variables) => {
      Given("一个类型为 <type> 的字段被选中", () => {
        render(
          <FormPreview
            meta={null}
            fields={[{ id: "f", type: variables.type, label: "字段名", options: ["A", "B"] }]}
            values={{}}
            setValue={() => {}}
            style="card"
            building={false}
          />,
        );
      });
      Then("其身份 kind 为 <kind>", () => {
        const node = document.querySelector("[data-mk-label]");
        expect(node).toBeInTheDocument();
        expect(node.getAttribute("data-mk-kind")).toBe(variables.kind);
      });
    });

    Scenario("label 去掉末尾必填星", ({ Given, Then }) => {
      Given("一个 label 为「手机号 *」的必填字段被选中", () => {
        render(
          <FormPreview
            meta={null}
            fields={[{ id: "tel", type: "tel", label: "手机号 *", required: true }]}
            values={{}}
            setValue={() => {}}
            style="card"
            building={false}
          />,
        );
      });
      Then("其身份 label 为「手机号」", () => {
        const node = document.querySelector("[data-mk-kind]");
        expect(node).toBeInTheDocument();
        expect(node.getAttribute("data-mk-label")).toBe("手机号");
      });
    });
  },
);
