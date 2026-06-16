import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { SignInScreen } from "../../src/signin.jsx";
import { setToken, clearToken, ApiError } from "../../src/core/apiClient";
import { authedCheck } from "../helpers/authGate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/owner-login.feature"));

// owner-login.feature realized at the component level. The UI refactor moved login out
// of an in-app modal and onto a standalone /signin page (DS SignInPage, 登录 / 注册 双模)
// rendered by <SignInScreen> with injectable login/register/requestPasswordReset/navigate
// seams. So 登录 / 注册 / 错误 are driven against <SignInScreen> directly, while the two
// designer-side behaviors (一个 401 把作者送进登录页;登出从顶栏账户菜单退出) are driven
// against the real <App> with an injected navigate spy / token store.
//
// Key UI facts from src/signin.jsx + the DS components:
//   - SignInPage footer flips mode: 注册一个 (→ signup) / 去登录 (→ signin)
//   - email Input: input[type=email], placeholder owner@example.com
//   - password Input: input[type=password]; signup also has a 确认密码 input
//   - submit button: 登录 (signin) / 注册并继续 (signup)
//   - the 忘记密码？ link shows in signin mode only
//   - backend errors render in SignInPage's own danger banner above the submit button
//     (the 0.5.0 `error` seam, via messageFor):
//       409 → 该邮箱已注册，请直接登录。  401 → 账号或密码错误，请重试。
//   - the SignInPage validates client-side first (邮箱格式 / 密码长度 / 确认一致),
//     so a < 8 password shows 密码至少 8 位 inline and never reaches register()
//   - on success SignInScreen calls navigate(returnTo) — the designer re-mounts logged-in
// From src/App.jsx (the designer):
//   - a chat 401 → needLogin → navigate("/signin?return=…&reason=登录后继续对话设计")
//   - the AccountControl: signed-out → a 登录 text button; signed-in → an avatar
//     (aria-label 账户菜单) opening a menu with 退出登录

const chat401 = () =>
  vi.fn(async () => {
    throw new ApiError(401, "未授权");
  });

// Fill the SignInPage credentials. `confirm` (signup only) fills the 确认密码 input.
function fillCreds(email, password, confirm) {
  fireEvent.change(document.querySelector('input[type="email"]'), {
    target: { value: email },
  });
  const pws = document.querySelectorAll('input[type="password"]');
  fireEvent.change(pws[0], { target: { value: password } });
  if (confirm != null && pws[1]) fireEvent.change(pws[1], { target: { value: confirm } });
}

function submitForm() {
  fireEvent.click(Array.from(document.querySelectorAll("button")).find((b) => b.type === "submit"));
}

function switchToRegister() {
  fireEvent.click(screen.getByRole("button", { name: "注册一个" }));
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => {
    cleanup();
    clearToken();
  });

  Scenario("会话中途失效时对话触发重新登录引导", ({ Given, When, Then, And }) => {
    const navigate = vi.fn();
    Given("设计器已载入（owner 已登录）", async () => {
      // 入口守卫放行(checkSession→authed)后设计器挂载;随后会话在一次对话动作上失效(chat 401),
      // 由 needLogin 引导去 /signin —— 入口守卫只在进入时校验,会话中途失效仍走这条行为级兜底。
      setToken("owner-jwt");
      render(
        <App
          chat={chat401()}
          navigate={navigate}
          checkSession={authedCheck}
          getCurrentUser={async () => ({ email: "owner@example.com", emailVerified: true })}
        />,
      );
      await screen.findByText("描述你想要的表单");
    });
    When("作者发起一句对话但后端返回 401（会话已失效）", async () => {
      fireEvent.click(screen.getByText("做一个线下活动报名表"));
      await screen.findByText("请先登录 owner 后再使用对话设计。");
    });
    Then("对话提示需要先登录", () => {
      expect(screen.getByText("请先登录 owner 后再使用对话设计。")).toBeInTheDocument();
    });
    And("跳转到 owner 登录页", async () => {
      // No in-app modal anymore — a 401 routes the owner to the standalone /signin page.
      await waitFor(() => expect(navigate).toHaveBeenCalled());
      expect(navigate.mock.calls[0][0]).toMatch(/^\/signin\?/);
      // the redirect carries where to come back to + why (the gated reason).
      expect(navigate.mock.calls[0][0]).toContain("return=");
      expect(navigate.mock.calls[0][0]).toContain("reason=");
    });
  });

  Scenario("新用户用邮箱 + 密码注册即登录", ({ Given, When, Then, And }) => {
    const register = vi.fn(async () => {});
    const navigate = vi.fn();
    Given("打开了 owner 登录页并切到注册模式", () => {
      render(
        <SignInScreen
          login={vi.fn()}
          register={register}
          requestPasswordReset={vi.fn()}
          navigate={navigate}
          search="?return=/back"
        />,
      );
      switchToRegister();
      expect(screen.getByText("创建 owner 账户")).toBeInTheDocument();
    });
    When("作者输入一个未注册的邮箱与一个 8 位及以上的密码并提交", async () => {
      const pw = "correct-horse-battery";
      fillCreds("newowner@example.com", pw, pw);
      submitForm();
      await waitFor(() => expect(register).toHaveBeenCalled());
    });
    Then("注册成功并跳回原页面", async () => {
      // register() called with the typed email + password — 注册即登录 (§17.2),
      // then the page navigates back to ?return=.
      expect(register).toHaveBeenCalledWith("newowner@example.com", "correct-horse-battery");
      await waitFor(() => expect(navigate).toHaveBeenCalledWith("/back"));
    });
    And("进入已登录态", () => {
      // the navigation back IS the logged-in transition (the designer re-mounts with the
      // persisted token); no backend error banner is shown.
      expect(screen.queryByText(/该邮箱已注册|账号或密码错误|失败/)).not.toBeInTheDocument();
    });
  });

  Scenario("注册一个已被占用的邮箱给出可读错误", ({ Given, When, Then, And }) => {
    const register = vi.fn(async () => {
      throw new ApiError(409, "email already registered");
    });
    const navigate = vi.fn();
    Given("打开了 owner 登录页并切到注册模式", () => {
      render(
        <SignInScreen
          login={vi.fn()}
          register={register}
          requestPasswordReset={vi.fn()}
          navigate={navigate}
          search="?return=/back"
        />,
      );
      switchToRegister();
    });
    When("作者输入一个已被注册的邮箱与密码并提交", async () => {
      const pw = "correct-horse-battery";
      fillCreds("taken@example.com", pw, pw);
      submitForm();
      await screen.findByText("该邮箱已注册，请直接登录。");
    });
    Then("登录页提示该邮箱已注册", () => {
      // 409 → 邮箱已注册 copy (register-specific, §17.2), in SignInPage's danger banner.
      expect(screen.getByRole("alert")).toHaveTextContent("该邮箱已注册，请直接登录。");
    });
    And("仍停留在登录页（未登录）", () => {
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  Scenario("注册时密码过弱给出可读错误", ({ Given, When, Then, And }) => {
    // The SignInPage client-side check (< 8) short-circuits BEFORE any round-trip, so
    // register must NOT be called — we assert that to prove the weak-password guard.
    const register = vi.fn(async () => {});
    const navigate = vi.fn();
    Given("打开了 owner 登录页并切到注册模式", () => {
      render(
        <SignInScreen
          login={vi.fn()}
          register={register}
          requestPasswordReset={vi.fn()}
          navigate={navigate}
          search="?return=/back"
        />,
      );
      switchToRegister();
    });
    When("作者输入一个少于 8 位的密码并提交", () => {
      fillCreds("weakpw@example.com", "short", "short"); // 5 chars < 8
      submitForm();
    });
    Then("登录页提示密码过弱", () => {
      // SignInPage shows the inline 密码至少 8 位 field error; never reaches register().
      expect(screen.getByText("密码至少 8 位")).toBeInTheDocument();
      expect(register).not.toHaveBeenCalled();
    });
    And("仍停留在登录页（未登录）", () => {
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  Scenario("已注册用户用邮箱 + 密码登录", ({ Given, When, Then, And }) => {
    const login = vi.fn(async () => {});
    const navigate = vi.fn();
    Given("打开了 owner 登录页", () => {
      render(
        <SignInScreen
          login={login}
          register={vi.fn()}
          requestPasswordReset={vi.fn()}
          navigate={navigate}
          search="?return=/back"
        />,
      );
      // signin mode is the default.
      expect(screen.getByText("登录 Agentaily Forms")).toBeInTheDocument();
    });
    When("作者输入正确的邮箱与密码并提交", async () => {
      fillCreds("owner@example.com", "correct-horse-battery");
      submitForm();
      await waitFor(() => expect(login).toHaveBeenCalled());
    });
    Then("登录成功并跳回原页面", async () => {
      expect(login).toHaveBeenCalledWith("owner@example.com", "correct-horse-battery");
      await waitFor(() => expect(navigate).toHaveBeenCalledWith("/back"));
    });
    And("进入已登录态", () => {
      expect(screen.queryByText(/该邮箱已注册|账号或密码错误|失败/)).not.toBeInTheDocument();
    });
  });

  Scenario("邮箱或密码错误时给出可读错误", ({ Given, When, Then, And }) => {
    // The backend returns a UNIFIED 401 that does NOT distinguish 邮箱不存在 vs 密码错
    // (§17.3) — messageFor maps it to one anti-enumeration copy.
    const login = vi.fn(async () => {
      throw new ApiError(401, "未授权");
    });
    const navigate = vi.fn();
    Given("打开了 owner 登录页", () => {
      render(
        <SignInScreen
          login={login}
          register={vi.fn()}
          requestPasswordReset={vi.fn()}
          navigate={navigate}
          search="?return=/back"
        />,
      );
    });
    When("作者输入错误的邮箱或密码并提交", async () => {
      fillCreds("owner@example.com", "wrong-password-x");
      submitForm();
      await screen.findByText("账号或密码错误，请重试。");
    });
    Then("登录页提示账号或密码错误", () => {
      expect(screen.getByRole("alert")).toHaveTextContent("账号或密码错误，请重试。");
    });
    And("仍停留在登录页（未登录）", () => {
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  Scenario("已登录后登出", ({ Given, When, Then, And }) => {
    const logout = vi.fn();
    Given("作者已登录并打开账户菜单", async () => {
      // A held token = a logged-in session (authIsLoggedIn). me resolves verified so no
      // banner; the AccountControl renders the avatar menu.
      setToken("owner-jwt");
      render(
        <App
          chat={vi.fn()}
          logout={logout}
          checkSession={authedCheck}
          getCurrentUser={async () => ({ email: "owner@example.com", emailVerified: true })}
        />,
      );
      await waitFor(() => expect(document.querySelector(".am-acct")).toBeInTheDocument());
      fireEvent.click(document.querySelector(".am-acct"));
      expect(screen.getByRole("menuitem", { name: /退出登录/ })).toBeInTheDocument();
    });
    When("作者点击退出登录", () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /退出登录/ }));
    });
    Then("顶栏账户入口回到未登录", async () => {
      // doLogout drops the session: logout() called + state cleared → the AccountControl
      // falls back to the signed-out 登录 button (avatar menu gone).
      expect(logout).toHaveBeenCalled();
      await waitFor(() => expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument());
      expect(document.querySelector(".am-acct")).not.toBeInTheDocument();
    });
    And("可重新进入登录", () => {
      // the signed-out account entry is the re-entry into the /signin flow.
      expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
    });
  });
});
