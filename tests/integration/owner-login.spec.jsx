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

// owner-login.feature realized at the component level: the real <App> + the real
// <LoginDialog> (dual-mode 登录 / 注册, §17 multi-user), with injected
// login/register/logout/chat seams so the flow is deterministic without a backend
// or token store. Each step matches the Gherkin exactly.
//
// Key UI facts from src/auth.jsx (the component under test):
//   - dialog title logged-out: 「OWNER 登录 / 注册」, logged-in: 「OWNER 账户」
//   - DS Tabs flips mode: 「登录」 / 「注册」
//   - email Input placeholder: owner@example.com
//   - password Input placeholder: login「输入登录密码」/ register「设置一个至少 8 位的密码」
//   - submit button label: 登录 / 注册 (busy → 登录中… / 注册中…)
//   - logged-in panel shows Alert「已登录」 + 登出 button
//   - account entry IconButton label: 登录账户 (out) / 账户已登录 (in)
//   - error copy: 409→「该邮箱已注册，请直接登录。」 401→「账号或密码错误，请重试。」
//     weak local pre-check→「密码至少 8 位。」

// The owner-only /api/chat proxy 401s until logged in (§17) — used by the chat
// auto-login-guide scenario.
const chat401 = () =>
  vi.fn(async () => {
    throw new ApiError(401, "未授权");
  });

const noopChat = () => vi.fn(async () => ({ text: "" }));

function openAccount() {
  fireEvent.click(screen.getByRole("button", { name: "登录账户" }));
}

function switchToRegister() {
  fireEvent.click(screen.getByRole("tab", { name: "注册" }));
}

function fillCreds(email, password) {
  fireEvent.change(screen.getByPlaceholderText("owner@example.com"), {
    target: { value: email },
  });
  // Login + register modes use different password placeholders; match whichever exists.
  const pw =
    screen.queryByPlaceholderText("输入登录密码") ??
    screen.getByPlaceholderText("设置一个至少 8 位的密码");
  fireEvent.change(pw, { target: { value: password } });
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => cleanup());

  Scenario("未登录时对话触发登录引导", ({ Given, When, Then, And }) => {
    Given("设计器处于空状态且未登录", () => {
      render(<App chat={chat401()} login={vi.fn()} register={vi.fn()} logout={vi.fn()} />);
      expect(screen.getByText("描述你想要的表单")).toBeInTheDocument();
    });
    When("作者发起一句对话且后端返回 401", async () => {
      fireEvent.click(screen.getByText("做一个线下活动报名表"));
      await screen.findByText("请先登录 owner 后再使用对话设计。");
    });
    Then("对话提示需要先登录", () => {
      expect(screen.getByText("请先登录 owner 后再使用对话设计。")).toBeInTheDocument();
    });
    And("自动弹出 owner 登录 / 注册框", () => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("OWNER 登录 / 注册")).toBeInTheDocument();
    });
  });

  Scenario("新用户用邮箱 + 密码注册即登录", ({ Given, When, Then, And }) => {
    const register = vi.fn(async () => {});
    Given("打开了 owner 登录 / 注册框并切到注册模式", () => {
      render(<App chat={noopChat()} login={vi.fn()} register={register} logout={vi.fn()} />);
      openAccount();
      expect(screen.getByText("OWNER 登录 / 注册")).toBeInTheDocument();
      switchToRegister();
    });
    When("作者输入一个未注册的邮箱与一个 8 位及以上的密码并提交", async () => {
      fillCreds("newowner@example.com", "correct-horse-battery");
      fireEvent.click(screen.getByRole("button", { name: "注册" }));
      await screen.findByText("已登录");
    });
    Then("登录框显示已登录", () => {
      // register() called with the typed email + password — 注册即登录 (§17.2).
      expect(register).toHaveBeenCalledWith("newowner@example.com", "correct-horse-battery");
      expect(screen.getByText("已登录")).toBeInTheDocument();
    });
    And("顶栏账户入口标记为已登录", () => {
      expect(screen.getByRole("button", { name: "账户已登录" })).toBeInTheDocument();
    });
  });

  Scenario("注册一个已被占用的邮箱给出可读错误", ({ Given, When, Then, And }) => {
    const register = vi.fn(async () => {
      throw new ApiError(409, "email already registered");
    });
    Given("打开了 owner 登录 / 注册框并切到注册模式", () => {
      render(<App chat={noopChat()} login={vi.fn()} register={register} logout={vi.fn()} />);
      openAccount();
      switchToRegister();
    });
    When("作者输入一个已被注册的邮箱与密码并提交", async () => {
      fillCreds("taken@example.com", "correct-horse-battery");
      fireEvent.click(screen.getByRole("button", { name: "注册" }));
      await screen.findByText("该邮箱已注册，请直接登录。");
    });
    Then("登录框提示该邮箱已注册", () => {
      // 409 → 邮箱已注册 copy (register-specific, §17.2).
      expect(screen.getByText("该邮箱已注册，请直接登录。")).toBeInTheDocument();
    });
    And("顶栏账户入口仍为未登录", () => {
      expect(screen.getByRole("button", { name: "登录账户" })).toBeInTheDocument();
    });
  });

  Scenario("注册时密码过弱给出可读错误", ({ Given, When, Then, And }) => {
    // The local pre-check (< 8) short-circuits BEFORE any round-trip, so register
    // must NOT be called — we assert that to prove the weak-password guard.
    const register = vi.fn(async () => {});
    Given("打开了 owner 登录 / 注册框并切到注册模式", () => {
      render(<App chat={noopChat()} login={vi.fn()} register={register} logout={vi.fn()} />);
      openAccount();
      switchToRegister();
    });
    When("作者输入一个少于 8 位的密码并提交", async () => {
      fillCreds("weakpw@example.com", "short"); // 5 chars < 8
      fireEvent.click(screen.getByRole("button", { name: "注册" }));
      await screen.findByText("密码至少 8 位。");
    });
    Then("登录框提示密码过弱", () => {
      expect(screen.getByText("密码至少 8 位。")).toBeInTheDocument();
      // Weak password never reached the backend (caught client-side, §17.2).
      expect(register).not.toHaveBeenCalled();
    });
    And("顶栏账户入口仍为未登录", () => {
      expect(screen.getByRole("button", { name: "登录账户" })).toBeInTheDocument();
    });
  });

  Scenario("已注册用户用邮箱 + 密码登录", ({ Given, When, Then, And }) => {
    const login = vi.fn(async () => {});
    Given("打开了 owner 登录 / 注册框", () => {
      render(<App chat={noopChat()} login={login} register={vi.fn()} logout={vi.fn()} />);
      openAccount();
      // Dialog opens in 登录 mode by default.
      expect(screen.getByText("OWNER 登录 / 注册")).toBeInTheDocument();
    });
    When("作者输入正确的邮箱与密码并提交", async () => {
      fillCreds("owner@example.com", "correct-horse-battery");
      fireEvent.click(screen.getByRole("button", { name: "登录" }));
      await screen.findByText("已登录");
    });
    Then("登录框显示已登录", () => {
      expect(login).toHaveBeenCalledWith("owner@example.com", "correct-horse-battery");
      expect(screen.getByText("已登录")).toBeInTheDocument();
    });
    And("顶栏账户入口标记为已登录", () => {
      expect(screen.getByRole("button", { name: "账户已登录" })).toBeInTheDocument();
    });
  });

  Scenario("邮箱或密码错误时给出可读错误", ({ Given, When, Then, And }) => {
    // The backend returns a UNIFIED 401 that does NOT distinguish 邮箱不存在 vs 密码错
    // (§17.3) — the dialog maps it to one anti-enumeration copy.
    const login = vi.fn(async () => {
      throw new ApiError(401, "未授权");
    });
    Given("打开了 owner 登录 / 注册框", () => {
      render(<App chat={noopChat()} login={login} register={vi.fn()} logout={vi.fn()} />);
      openAccount();
    });
    When("作者输入错误的邮箱或密码并提交", async () => {
      fillCreds("owner@example.com", "wrong-password-x");
      fireEvent.click(screen.getByRole("button", { name: "登录" }));
      await screen.findByText("账号或密码错误，请重试。");
    });
    Then("登录框提示账号或密码错误", () => {
      expect(screen.getByText("账号或密码错误，请重试。")).toBeInTheDocument();
    });
    And("顶栏账户入口仍为未登录", () => {
      expect(screen.getByRole("button", { name: "登录账户" })).toBeInTheDocument();
    });
  });

  Scenario("已登录后登出", ({ Given, When, Then, And }) => {
    const login = vi.fn(async () => {});
    const logout = vi.fn();
    Given("作者已登录并打开账户框", async () => {
      render(<App chat={noopChat()} login={login} register={vi.fn()} logout={logout} />);
      openAccount();
      fillCreds("owner@example.com", "correct-horse-battery");
      fireEvent.click(screen.getByRole("button", { name: "登录" }));
      await screen.findByText("已登录");
    });
    When("作者点击登出", async () => {
      fireEvent.click(screen.getByRole("button", { name: "登出" }));
      await waitFor(() =>
        expect(screen.getByPlaceholderText("owner@example.com")).toBeInTheDocument(),
      );
    });
    Then("登录框回到邮箱 + 密码输入态", () => {
      expect(logout).toHaveBeenCalled();
      // Back to the dual-mode form: the email + password inputs are visible again.
      expect(screen.getByPlaceholderText("owner@example.com")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("输入登录密码")).toBeInTheDocument();
    });
    And("顶栏账户入口回到未登录", () => {
      expect(screen.getByRole("button", { name: "登录账户" })).toBeInTheDocument();
    });
  });
});
