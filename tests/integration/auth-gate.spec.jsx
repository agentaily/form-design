import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each step as its own test, so cleanup
// happens per scenario (AfterEachScenario), not per step. The rendered tree persists across
// the Given/When/Then of one scenario.
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { setToken, clearToken } from "../../src/core/apiClient";
import { authedCheck, unauthedCheck, errorCheck } from "../helpers/authGate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/auth-gate.feature"));

// auth-gate.feature realized at the component level against the REAL <App>, driving the entry
// guard through its injectable `checkSession` seam (the production default is the real
// validateSession → GET /api/auth/me). The designer's empty-state heading 「描述你想要的表单」 is
// the protected-content anchor; the standalone SignInScreen's 「登录 Agentaily Forms」 heading is
// the login-view anchor; the guard's error placeholder shows 「无法验证登录状态」 + a 「重试」 button.
const DESIGNER = "描述你想要的表单";
const LOGIN_VIEW = "登录 Agentaily Forms";
const ERROR_HEAD = "无法验证登录状态";

const verifiedMe = async () => ({ email: "owner@example.com", emailVerified: true });
const pendingMe = async () => ({ email: "owner@example.com", emailVerified: false });

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => {
    cleanup();
    clearToken();
  });

  Scenario("已登录有效则进入设计器", ({ Given, When, Then, And }) => {
    Given("owner 的会话校验通过(已登录)", () => {
      setToken("owner-jwt");
    });
    When("进入设计器入口", async () => {
      render(<App chat={vi.fn()} checkSession={authedCheck} getCurrentUser={verifiedMe} />);
      await screen.findByText(DESIGNER);
    });
    Then("守卫挂载设计器", () => {
      expect(screen.getByText(DESIGNER)).toBeInTheDocument();
    });
    And("不显示登录视图", () => {
      expect(screen.queryByText(LOGIN_VIEW)).not.toBeInTheDocument();
    });
  });

  Scenario("未登录则原地落到登录视图,绝不渲染设计器", ({ Given, When, Then, And }) => {
    Given("owner 未登录(会话校验判定未授权)", () => {
      clearToken();
    });
    When("进入设计器入口", async () => {
      render(<App chat={vi.fn()} checkSession={unauthedCheck} />);
      await screen.findByText(LOGIN_VIEW);
    });
    Then("守卫原地展示登录视图", () => {
      expect(screen.getByText(LOGIN_VIEW)).toBeInTheDocument();
    });
    And("绝不渲染设计器的任何受保护内容", () => {
      // zero-flash: the protected designer never mounts for an unauthorized owner.
      expect(screen.queryByText(DESIGNER)).not.toBeInTheDocument();
    });
  });

  Scenario("校验服务异常时给中性「重试」占位而非登录视图", ({ Given, When, Then, And }) => {
    Given("会话校验服务异常(5xx / 网络)", () => {
      setToken("owner-jwt");
    });
    When("进入设计器入口", async () => {
      render(<App chat={vi.fn()} checkSession={errorCheck} getCurrentUser={verifiedMe} />);
      await screen.findByText(ERROR_HEAD);
    });
    Then("守卫展示中性「重试」占位", () => {
      expect(screen.getByText(ERROR_HEAD)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    });
    And("不把异常误判为未登录(不直接落登录视图)", () => {
      expect(screen.queryByText(LOGIN_VIEW)).not.toBeInTheDocument();
      expect(screen.queryByText(DESIGNER)).not.toBeInTheDocument();
    });
  });

  Scenario("校验异常后重试成功则进入设计器", ({ Given, When, Then }) => {
    let calls = 0;
    const flakyCheck = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? { status: "error" } : await authedCheck();
    });
    Given("首次会话校验异常、重试将通过", () => {
      setToken("owner-jwt");
    });
    When("进入设计器入口并点击「重试」", async () => {
      render(<App chat={vi.fn()} checkSession={flakyCheck} getCurrentUser={verifiedMe} />);
      fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    });
    Then("守卫重新校验并挂载设计器", async () => {
      expect(await screen.findByText(DESIGNER)).toBeInTheDocument();
      expect(flakyCheck).toHaveBeenCalledTimes(2);
    });
  });

  Scenario("待验证邮箱仍进入设计器并显示软提醒条", ({ Given, When, Then, And }) => {
    Given("owner 已登录但邮箱待验证", () => {
      setToken("owner-jwt");
    });
    When("进入设计器入口", async () => {
      // The guard admits the owner (authed); the unverified bit comes from the designer's own
      // getCurrentUser → the soft banner (a 软提醒, never a hard wall — the designer still mounts).
      render(<App chat={vi.fn()} checkSession={authedCheck} getCurrentUser={pendingMe} />);
      await screen.findByText(DESIGNER);
    });
    Then("守卫挂载设计器", () => {
      expect(screen.getByText(DESIGNER)).toBeInTheDocument();
    });
    And("顶部显示邮箱未验证的软提醒条", async () => {
      expect(await screen.findByTestId("verify-banner")).toBeInTheDocument();
    });
  });
});
