// Inner-loop unit specs for the 找回密码 sub-state of src/auth.jsx LoginDialog (SPEC
// §24.5). The login surface offers a「忘记密码？」entry → an email-only sub-state →
// requestPasswordReset → ONE neutral copy regardless of outcome (anti-enumeration).
// requestPasswordReset is injectable so this stays deterministic without a backend.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LoginDialog } from "../../src/auth.jsx";

afterEach(() => cleanup());

const NEUTRAL = /若该邮箱已注册，我们已发送重置链接/;

function openForgot() {
  fireEvent.click(screen.getByRole("button", { name: "忘记密码？" }));
}

describe("LoginDialog · 找回密码 entry", () => {
  it("login mode shows a 忘记密码？ entry that flips to the 找回密码 sub-state", () => {
    render(<LoginDialog open loggedIn={false} requestPasswordReset={vi.fn()} />);
    // login mode is the default
    openForgot();
    expect(screen.getByText("找回密码")).toBeInTheDocument();
    // the sub-state has an email field but no password field
    expect(screen.getByPlaceholderText("owner@example.com")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("输入登录密码")).not.toBeInTheDocument();
  });

  it("does not show 忘记密码？ in register mode", () => {
    render(<LoginDialog open loggedIn={false} requestPasswordReset={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "注册" }));
    expect(screen.queryByRole("button", { name: "忘记密码？" })).not.toBeInTheDocument();
  });
});

describe("LoginDialog · 找回密码 发起 (anti-enumeration)", () => {
  it("calls requestPasswordReset with the email and shows the neutral copy", async () => {
    const requestPasswordReset = vi.fn(async () => {});
    render(<LoginDialog open loggedIn={false} requestPasswordReset={requestPasswordReset} />);
    openForgot();
    fireEvent.change(screen.getByPlaceholderText("owner@example.com"), {
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
    render(<LoginDialog open loggedIn={false} requestPasswordReset={requestPasswordReset} />);
    openForgot();
    fireEvent.change(screen.getByPlaceholderText("owner@example.com"), {
      target: { value: "nobody@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送重置链接" }));
    await screen.findByText(NEUTRAL);
  });

  it("seeds the reset email from whatever was typed in the login email field", () => {
    render(<LoginDialog open loggedIn={false} requestPasswordReset={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("owner@example.com"), {
      target: { value: "typed@example.com" },
    });
    openForgot();
    expect(screen.getByPlaceholderText("owner@example.com")).toHaveValue("typed@example.com");
  });

  it("returns to the login form via 返回登录", () => {
    render(<LoginDialog open loggedIn={false} requestPasswordReset={vi.fn()} />);
    openForgot();
    fireEvent.click(screen.getByRole("button", { name: "返回登录" }));
    // back to dual-mode form: the password field is visible again
    expect(screen.getByPlaceholderText("输入登录密码")).toBeInTheDocument();
  });
});
