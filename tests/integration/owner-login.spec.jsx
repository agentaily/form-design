import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { ApiError } from "../../src/core/apiClient";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/owner-login.feature"));

// The owner-only /api/chat proxy 401s until logged in (§17). We inject a fake
// `chat` (to drive the 401 path) plus fake `login`/`logout` so the dialog flow is
// deterministic without a backend or real token store.
const chat401 = () =>
  vi.fn(async () => {
    throw new ApiError(401, "未授权");
  });

function openAccount() {
  fireEvent.click(screen.getByRole("button", { name: "登录账户" }));
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => cleanup());

  Scenario("未登录时对话触发登录引导", ({ Given, When, Then, And }) => {
    Given("设计器处于空状态且未登录", () => {
      render(<App chat={chat401()} login={vi.fn()} logout={vi.fn()} />);
      expect(screen.getByText("描述你想要的表单")).toBeInTheDocument();
    });
    When("作者发起一句对话且后端返回 401", async () => {
      fireEvent.click(screen.getByText("做一个线下活动报名表"));
      await screen.findByText("请先登录 owner 后再使用对话设计。");
    });
    Then("对话提示需要先登录", () => {
      expect(screen.getByText("请先登录 owner 后再使用对话设计。")).toBeInTheDocument();
    });
    And("自动弹出 owner 登录框", () => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("OWNER 登录")).toBeInTheDocument();
    });
  });

  Scenario("owner 用正确密码登录", ({ Given, When, Then, And }) => {
    const login = vi.fn(async () => {});
    Given("打开了 owner 登录框", () => {
      render(<App chat={chat401()} login={login} logout={vi.fn()} />);
      openAccount();
      expect(screen.getByText("OWNER 登录")).toBeInTheDocument();
    });
    When("作者输入正确密码并提交", async () => {
      fireEvent.change(screen.getByPlaceholderText("输入 owner 登录密码"), {
        target: { value: "correct-horse" },
      });
      fireEvent.click(screen.getByRole("button", { name: "登录" }));
      await screen.findByText("已登录");
    });
    Then("登录框显示已登录", () => {
      expect(login).toHaveBeenCalledWith("correct-horse");
      expect(screen.getByText("已登录")).toBeInTheDocument();
    });
    And("顶栏账户入口标记为已登录", () => {
      expect(screen.getByRole("button", { name: "账户已登录" })).toBeInTheDocument();
    });
  });

  Scenario("密码错误时给出可读错误", ({ Given, When, Then, And }) => {
    const login = vi.fn(async () => {
      throw new ApiError(401, "未授权");
    });
    Given("打开了 owner 登录框", () => {
      render(<App chat={chat401()} login={login} logout={vi.fn()} />);
      openAccount();
      expect(screen.getByText("OWNER 登录")).toBeInTheDocument();
    });
    When("作者输入错误密码并提交", async () => {
      fireEvent.change(screen.getByPlaceholderText("输入 owner 登录密码"), {
        target: { value: "nope" },
      });
      fireEvent.click(screen.getByRole("button", { name: "登录" }));
      await screen.findByText("密码错误，请重试。");
    });
    Then("登录框显示密码错误", () => {
      expect(screen.getByText("密码错误，请重试。")).toBeInTheDocument();
    });
    And("顶栏账户入口仍为未登录", () => {
      expect(screen.getByRole("button", { name: "登录账户" })).toBeInTheDocument();
    });
  });

  Scenario("已登录后登出", ({ Given, When, Then, And }) => {
    const login = vi.fn(async () => {});
    const logout = vi.fn();
    Given("作者已登录并打开账户框", async () => {
      render(<App chat={chat401()} login={login} logout={logout} />);
      openAccount();
      fireEvent.change(screen.getByPlaceholderText("输入 owner 登录密码"), {
        target: { value: "pw" },
      });
      fireEvent.click(screen.getByRole("button", { name: "登录" }));
      await screen.findByText("已登录");
    });
    When("作者点击登出", async () => {
      fireEvent.click(screen.getByRole("button", { name: "登出" }));
      await waitFor(() =>
        expect(screen.getByPlaceholderText("输入 owner 登录密码")).toBeInTheDocument(),
      );
    });
    Then("登录框回到密码输入态", () => {
      expect(logout).toHaveBeenCalled();
      expect(screen.getByPlaceholderText("输入 owner 登录密码")).toBeInTheDocument();
    });
    And("顶栏账户入口回到未登录", () => {
      expect(screen.getByRole("button", { name: "登录账户" })).toBeInTheDocument();
    });
  });
});
