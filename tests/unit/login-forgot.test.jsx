// Inner-loop unit specs for the 找回密码 sub-state of the standalone /signin page
// (src/signin.jsx SignInScreen, SPEC §24.5). The login surface offers a「忘记密码？」
// entry → an email-only 找回密码 dialog → requestPasswordReset → ONE neutral copy
// regardless of outcome (anti-enumeration). requestPasswordReset is injectable so this
// stays deterministic without a backend.
//
// Since the UI refactor the in-app LoginDialog modal is gone; login is the DS SignInPage
// rendered by <SignInScreen>, and 找回密码 is a small DS Dialog opened by the page's
// 忘记密码？ link. The behavior contract is unchanged — only the realization moved.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SignInScreen } from "../../src/signin.jsx";

afterEach(() => cleanup());

const NEUTRAL = /若该邮箱已注册，我们已发送重置链接/;

// The 忘记密码？ link lives on the SignInPage (signin mode only).
function openForgot() {
  fireEvent.click(screen.getByRole("button", { name: "忘记密码？" }));
}

// SignInScreen needs all auth seams + navigate injected so nothing hits the backend.
function renderSignIn(props = {}) {
  return render(
    <SignInScreen
      login={vi.fn()}
      register={vi.fn()}
      requestPasswordReset={vi.fn(async () => {})}
      navigate={vi.fn()}
      search=""
      {...props}
    />,
  );
}

describe("SignInScreen · 找回密码 entry", () => {
  it("login mode shows a 忘记密码？ entry that opens the 找回密码 dialog", () => {
    renderSignIn();
    // signin mode is the default
    openForgot();
    // the dialog opens with its 找回密码 title
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("找回密码");
    // the 找回密码 dialog has its own email field but no password field (the page's
    // login password input lives outside the dialog, under the overlay)
    expect(dialog.querySelector('input[type="email"]')).toBeInTheDocument();
    expect(dialog.querySelector('input[type="password"]')).not.toBeInTheDocument();
  });

  it("does not show 忘记密码？ in 注册 (signup) mode", () => {
    renderSignIn();
    // flip to signup via the SignInPage footer link
    fireEvent.click(screen.getByRole("button", { name: "注册一个" }));
    expect(screen.queryByRole("button", { name: "忘记密码？" })).not.toBeInTheDocument();
  });
});

describe("SignInScreen · 找回密码 发起 (anti-enumeration)", () => {
  it("calls requestPasswordReset with the email and shows the neutral copy", async () => {
    const requestPasswordReset = vi.fn(async () => {});
    renderSignIn({ requestPasswordReset });
    openForgot();
    // the 找回密码 dialog's own email field is the last owner@example.com input
    const emails = screen.getAllByPlaceholderText("owner@example.com");
    fireEvent.change(emails[emails.length - 1], {
      target: { value: "someone@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送重置链接" }));
    await screen.findByText(NEUTRAL);
    expect(requestPasswordReset).toHaveBeenCalledWith("someone@example.com");
  });

  it("shows the SAME neutral copy even if requestPasswordReset rejects (never leak existence)", async () => {
    // requestPasswordReset should never reject in practice, but the UI must show the
    // identical neutral outcome if it ever does — no different message leaks.
    const requestPasswordReset = vi.fn(async () => {
      throw new Error("boom");
    });
    renderSignIn({ requestPasswordReset });
    openForgot();
    const emails = screen.getAllByPlaceholderText("owner@example.com");
    fireEvent.change(emails[emails.length - 1], {
      target: { value: "nobody@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送重置链接" }));
    await screen.findByText(NEUTRAL);
  });

  it("seeds the reset email from whatever was typed in the login email field", () => {
    renderSignIn();
    // type into the SignInPage login email field, then open 找回密码
    fireEvent.change(screen.getByPlaceholderText("owner@example.com"), {
      target: { value: "typed@example.com" },
    });
    openForgot();
    // the dialog's email field is pre-filled from the login email
    const emails = screen.getAllByPlaceholderText("owner@example.com");
    expect(emails[emails.length - 1]).toHaveValue("typed@example.com");
  });

  it("returns to the login form by closing the 找回密码 dialog", () => {
    renderSignIn();
    openForgot();
    expect(screen.getByRole("dialog")).toHaveTextContent("找回密码");
    // close the dialog — the dual-mode SignInPage form remains, password visible
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("输入登录密码")).toBeInTheDocument();
  });
});
