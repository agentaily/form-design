// App-level frontend realization of the 找回密码 (§24.5) UI scenarios from
// features/password-reset.feature. The backend behaviors (发起防枚举、确认改密、token 边界)
// are realized at the worker level (workers/test/password-reset-api.test.ts); this file
// pins the FRONTEND-only scenarios the feature calls out:
//   - 从登录框发起找回密码 → 「忘记密码？」→ email → 「发送重置链接」→ neutral copy
//   - 在重置页设置新密码后引导回登录 → /reset-password?token= → set password → 改密成功 + 回登录
//   - (确认失败：token 失效 / 弱密码 → 据 400 文案提示，不改密)
//
// requestPasswordReset / confirmReset are injected so the flow is deterministic without
// a backend or token store. Chrome is the real @agentaily/design-system Input/Button/Alert.
//
// Like app-settings-login.spec.jsx, this is a plain App-level wiring spec (no gherkin
// binding) — the feature is bound at the backend altitude by name; here each test names
// the frontend scenario it realizes.
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
// /pure → no auto cleanup; we unmount explicitly between cases.
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { SignInScreen } from "../../src/signin.jsx";
import { ApiError } from "../../src/core/apiClient";

afterEach(() => cleanup());

// Fill the 找回密码 dialog's own email field (the last owner@example.com input — the
// SignInPage login email field stays mounted under the overlay).
function fillResetEmail(value) {
  const emails = screen.getAllByPlaceholderText("owner@example.com");
  fireEvent.change(emails[emails.length - 1], { target: { value } });
}

describe("找回密码 发起（登录页）(features/password-reset.feature, §24.5 frontend)", () => {
  it("Scenario: 从登录页发起找回密码 — 显示中性提示", async () => {
    // Since the UI refactor the in-app login modal is gone — 找回密码 is opened from the
    // standalone /signin page (DS SignInPage's 忘记密码？ link → a 找回密码 dialog).
    // requestPasswordReset always resolves (anti-enumeration, §24.1) — ONE neutral copy
    // shows regardless of whether the email is registered.
    const requestPasswordReset = vi.fn(async () => {});
    render(
      <SignInScreen
        login={vi.fn()}
        register={vi.fn()}
        requestPasswordReset={requestPasswordReset}
        navigate={vi.fn()}
        search=""
      />,
    );

    // When 作者点击「忘记密码」并输入邮箱发起
    fireEvent.click(screen.getByRole("button", { name: "忘记密码？" }));
    // The 找回密码 dialog opens.
    await screen.findByRole("dialog");
    fillResetEmail("owner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "发送重置链接" }));

    // Then 显示中性提示「若该邮箱已注册，我们已发送重置链接」.
    // The neutral body copy is identical in every branch (registered or not) —
    // anti-enumeration (§24.5). Match the full sentence (the substring also appears in
    // the Alert title, so we pin the exact body copy to avoid an ambiguous match).
    await screen.findByText("若该邮箱已注册，我们已发送重置链接，请查收邮件。");
    expect(requestPasswordReset).toHaveBeenCalledWith("owner@example.com");
    expect(
      screen.getByText("若该邮箱已注册，我们已发送重置链接，请查收邮件。"),
    ).toBeInTheDocument();
  });

  it("Scenario: 未注册邮箱发起也得到相同中性提示（前端不区分）", async () => {
    // Even a network/backend hiccup is swallowed by submitReset, so the SAME neutral copy
    // shows — the UI can never enumerate accounts (§24.5).
    const requestPasswordReset = vi.fn(async () => {
      throw new Error("network blip"); // swallowed by the dialog's guard
    });
    render(
      <SignInScreen
        login={vi.fn()}
        register={vi.fn()}
        requestPasswordReset={requestPasswordReset}
        navigate={vi.fn()}
        search=""
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "忘记密码？" }));
    await screen.findByRole("dialog");
    fillResetEmail("ghost@example.com");
    fireEvent.click(screen.getByRole("button", { name: "发送重置链接" }));

    await screen.findByText("若该邮箱已注册，我们已发送重置链接，请查收邮件。");
    expect(
      screen.getByText("若该邮箱已注册，我们已发送重置链接，请查收邮件。"),
    ).toBeInTheDocument();
  });
});

describe("找回密码 重置页 /reset-password?token= (features/password-reset.feature, §24.5 frontend)", () => {
  it("Scenario: 在重置页设置新密码后引导回登录", async () => {
    // Given 作者打开重置密码落地页且链接有效 — App's route split mounts ONLY the bare
    // ResetPasswordPage when pathname=/reset-password?token=. confirmReset is injected.
    const confirmReset = vi.fn(async () => {});
    const onBackToLogin = vi.fn();
    render(
      <App
        pathname="/reset-password"
        search="?token=valid-reset-token-abc"
        confirmReset={confirmReset}
        onBackToLogin={onBackToLogin}
      />,
    );
    // "重置密码" is both the page <h1> and the submit button label — pin the heading.
    expect(screen.getByRole("heading", { name: "重置密码" })).toBeInTheDocument();
    // Chrome-less: no designer surface leaks onto the landing page.
    expect(screen.queryByText("描述你想要的表单")).not.toBeInTheDocument();

    // When 作者设置一个合法的新密码并提交 (password + confirm must match, ≥ 8).
    const newPassword = "brand-new-strong-pass-1";
    fireEvent.change(screen.getByPlaceholderText("设置一个至少 8 位的新密码"), {
      target: { value: newPassword },
    });
    fireEvent.change(screen.getByPlaceholderText("再次输入新密码"), {
      target: { value: newPassword },
    });
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));

    // Then 提示改密成功 — confirmReset called with the URL token + the new password.
    await screen.findByText("改密成功");
    expect(confirmReset).toHaveBeenCalledWith("valid-reset-token-abc", newPassword);
    expect(screen.getByText("改密成功")).toBeInTheDocument();

    // And 引导作者回到登录 — the「回到登录」action routes via onBackToLogin.
    fireEvent.click(screen.getByRole("button", { name: "回到登录" }));
    expect(onBackToLogin).toHaveBeenCalled();
  });

  it("Scenario: 重置页提交失效 / 过期 token 据 400 文案提示（不改密）", async () => {
    // The backend returns a unified 400 for 失效/过期/已用 token (§24.3) — the page shows
    // the 链接已失效 copy verbatim, no「改密成功」.
    const confirmReset = vi.fn(async () => {
      throw new ApiError(400, "重置链接无效或已过期");
    });
    render(
      <App pathname="/reset-password" search="?token=expired-token" confirmReset={confirmReset} />,
    );

    const newPassword = "brand-new-strong-pass-1";
    fireEvent.change(screen.getByPlaceholderText("设置一个至少 8 位的新密码"), {
      target: { value: newPassword },
    });
    fireEvent.change(screen.getByPlaceholderText("再次输入新密码"), {
      target: { value: newPassword },
    });
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));

    await screen.findByText(/链接已失效或密码过弱/);
    expect(confirmReset).toHaveBeenCalled();
    expect(screen.queryByText("改密成功")).not.toBeInTheDocument();
  });

  it("Scenario: 弱密码本地拦截在 round-trip 之前（不打后端）", async () => {
    // A < 8 password is caught client-side before any confirm call (mirrors §17.2),
    // so confirmReset must NOT be hit.
    const confirmReset = vi.fn(async () => {});
    render(
      <App pathname="/reset-password" search="?token=valid-token" confirmReset={confirmReset} />,
    );

    fireEvent.change(screen.getByPlaceholderText("设置一个至少 8 位的新密码"), {
      target: { value: "short" }, // 5 < 8
    });
    fireEvent.change(screen.getByPlaceholderText("再次输入新密码"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));

    await screen.findByText(/密码至少 8 位/);
    expect(confirmReset).not.toHaveBeenCalled();
  });

  it("Scenario: 缺 token 的重置链接显示「链接无效」并引导回登录", () => {
    // A /reset-password without ?token= → the page shows a「链接无效」hint + 回登录 entry
    // (the backend would only ever 400 it), never the password form.
    const onBackToLogin = vi.fn();
    render(<App pathname="/reset-password" search="" onBackToLogin={onBackToLogin} />);
    expect(screen.getByText("链接无效")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("设置一个至少 8 位的新密码")).not.toBeInTheDocument();
  });
});
