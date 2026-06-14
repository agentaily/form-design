// Inner-loop unit specs for src/verify-email.jsx — the 邮箱验证 result landing page
// (SPEC §23.6), now built on the OFFICIAL design-system <VerifyEmailPage> (DS 0.12.0).
//
// It does NO backend confirm: the backend confirm endpoint consumes the token SERVER-SIDE
// and 302s here with the outcome in ?status= (router-normalised to "ok" | "invalid",
// fail-closed). So we drive the DS component in CONTROLLED mode off that verdict — ok shows
// 「邮箱已验证」, invalid shows 「链接已失效」 (never claims verified). The product wiring
// (回到设计器 / 重新发送 / 返回登录) is injectable so each affordance is asserted without a
// real navigation or network call. Copy is locale-resolved; tests run under the default zh.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { VerifyEmailPage } from "../../src/verify-email.jsx";

afterEach(() => cleanup());

describe("VerifyEmailPage · status=ok", () => {
  it("shows 邮箱已验证 (never 链接已失效)", () => {
    render(<VerifyEmailPage status="ok" />);
    expect(screen.getByText("邮箱已验证")).toBeInTheDocument();
    expect(screen.queryByText("链接已失效")).not.toBeInTheDocument();
  });

  it("回到设计器 fires onBackToApp (success-state continue)", () => {
    const onBackToApp = vi.fn();
    // noRedirect keeps the manual 「回到设计器」 button (no auto-return countdown) for a
    // deterministic assertion.
    render(<VerifyEmailPage status="ok" noRedirect onBackToApp={onBackToApp} />);
    fireEvent.click(screen.getByRole("button", { name: "回到设计器" }));
    expect(onBackToApp).toHaveBeenCalled();
  });
});

describe("VerifyEmailPage · status=invalid", () => {
  it("shows 链接已失效 (never claims verified)", () => {
    render(<VerifyEmailPage status="invalid" />);
    expect(screen.getByText("链接已失效")).toBeInTheDocument();
    expect(screen.queryByText("邮箱已验证")).not.toBeInTheDocument();
  });

  it("offers 重新发送验证邮件 and wires it to onResend", async () => {
    const onResend = vi.fn(() => Promise.resolve());
    render(<VerifyEmailPage status="invalid" onResend={onResend} />);
    fireEvent.click(screen.getByRole("button", { name: /重新发送验证邮件/ }));
    await waitFor(() => expect(onResend).toHaveBeenCalled());
  });

  it("返回登录 routes to /signin via the navigate seam", () => {
    const navigate = vi.fn();
    render(<VerifyEmailPage status="invalid" navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "返回登录" }));
    expect(navigate).toHaveBeenCalledWith("/signin");
  });
});
