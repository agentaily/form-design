import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each step as its own test,
// so cleanup must happen per scenario (AfterEachScenario), not per step.
import { render, cleanup } from "@testing-library/react/pure";
import { renderChatTurn } from "../../src/chat.jsx";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/chat-markdown.feature"));

// renderChatTurn(m, ctx, onSuggest) maps our message model onto DS chat atoms.
// An assistant text turn now routes its prose through the DS <Markdown> primitive,
// so markdown source must come out as typeset DOM (real <ul>/<li>/<strong>), never
// the literal `*`/`-` characters. We render the returned node directly (the renderer
// is the unit under test) and assert on the produced DOM.
const settled = { streaming: false };

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => cleanup());

  Scenario("助手文本消息把 markdown 渲染成 DOM(而非原文)", ({ Given, When, Then, And }) => {
    let msg;
    let container;
    Given("一条助手消息的文本是包含列表与加粗的 markdown", () => {
      msg = {
        role: "assistant",
        text: "这是 **加粗** 文本,后面跟一个列表:\n\n- 第一项\n- 第二项\n- 第三项",
      };
    });
    When("把这条消息渲染到对话里", () => {
      ({ container } = render(renderChatTurn(msg, settled, () => {})));
    });
    Then("列表渲染成 <ul><li>", () => {
      const ul = container.querySelector("ul");
      expect(ul).not.toBeNull();
      expect(ul.querySelectorAll("li")).toHaveLength(3);
      expect(ul).toHaveTextContent("第一项");
    });
    And("加粗渲染成 <strong>", () => {
      const strong = container.querySelector("strong");
      expect(strong).not.toBeNull();
      expect(strong).toHaveTextContent("加粗");
    });
    And("页面上看不到原始的 markdown 语法字符", () => {
      // The literal "**加粗**" / "- 第一项" syntax must not survive as text — if it did,
      // we'd be back to the pre-0.7.0 raw-text bug this PR closes.
      expect(container.textContent).not.toContain("**加粗**");
      expect(container.textContent).not.toContain("- 第一项");
    });
  });

  Scenario("助手 markdown 里的危险链接被净化(无 XSS)", ({ Given, When, Then }) => {
    let msg;
    let container;
    Given("一条助手消息的文本里带一个 javascript: 协议的链接", () => {
      msg = { role: "assistant", text: "点[这里](javascript:alert(1))" };
    });
    When("把这条消息渲染到对话里", () => {
      ({ container } = render(renderChatTurn(msg, settled, () => {})));
    });
    Then("该链接的 href 不是 javascript: 协议", () => {
      const anchor = container.querySelector("a");
      // If an anchor was emitted at all, its href must have had the javascript: scheme
      // stripped by the DS <Markdown> sanitizer (no script-execution surface).
      if (anchor) {
        expect((anchor.getAttribute("href") || "").toLowerCase()).not.toContain("javascript:");
      }
    });
  });
});
