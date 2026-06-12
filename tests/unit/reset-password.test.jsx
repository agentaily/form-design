// Inner-loop unit specs for src/reset-password.jsx — the 找回密码 reset landing page
// (SPEC §24.5). It reads the one-time token (passed in by the router, from the URL
// only), pre-checks the new password (≥ 8 + match) locally, then confirmPasswordReset.
// A 200 → 改密成功 + 回登录; a 400 → 链接失效 / 密码过弱 (unified §24.3 copy); a missing
// token → a readable「链接无效」hint with no form. confirmReset/onBackToLogin are
// injectable so these stay deterministic without a backend or navigation.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ResetPasswordPage } from "../../src/reset-password.jsx";
import { ApiError } from "../../src/core/apiClient";

afterEach(() => cleanup());

const VALID_PW = "brand-new-pass"; // ≥ 8

function fillNewPassword(pw, confirm = pw) {
  fireEvent.change(screen.getByPlaceholderText("设置一个至少 8 位的新密码"), {
    target: { value: pw },
  });
  fireEvent.change(screen.getByPlaceholderText("再次输入新密码"), {
    target: { value: confirm },
  });
}

describe("ResetPasswordPage · missing token", () => {
  it("shows a readable 链接无效 hint and no password form when token is empty", () => {
    render(<ResetPasswordPage token="" confirmReset={vi.fn()} />);
    expect(screen.getByText("链接无效")).toBeInTheDocument();
    // No new-password field is rendered (nothing to confirm without a token).
    expect(screen.queryByPlaceholderText("设置一个至少 8 位的新密码")).not.toBeInTheDocument();
  });

  it("offers a 回到登录 affordance that fires onBackToLogin", () => {
    const onBackToLogin = vi.fn();
    render(<ResetPasswordPage token="" confirmReset={vi.fn()} onBackToLogin={onBackToLogin} />);
    fireEvent.click(screen.getByRole("button", { name: "回到登录" }));
    expect(onBackToLogin).toHaveBeenCalled();
  });
});

describe("ResetPasswordPage · local pre-checks (before any round-trip)", () => {
  it("blocks a < 8 password with 密码至少 8 位 and never calls confirmReset", () => {
    const confirmReset = vi.fn();
    render(<ResetPasswordPage token="tok" confirmReset={confirmReset} />);
    fillNewPassword("short"); // 5 chars
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    expect(screen.getByText("密码至少 8 位。")).toBeInTheDocument();
    expect(confirmReset).not.toHaveBeenCalled();
  });

  it("blocks a password/confirm mismatch and never calls confirmReset", () => {
    const confirmReset = vi.fn();
    render(<ResetPasswordPage token="tok" confirmReset={confirmReset} />);
    fillNewPassword(VALID_PW, "different-pass");
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    expect(screen.getByText("两次输入的密码不一致。")).toBeInTheDocument();
    expect(confirmReset).not.toHaveBeenCalled();
  });
});

describe("ResetPasswordPage · confirm outcomes", () => {
  it("on 200 shows 改密成功 and guides back to login", async () => {
    const confirmReset = vi.fn(async () => {});
    render(<ResetPasswordPage token="tok-abc" confirmReset={confirmReset} />);
    fillNewPassword(VALID_PW);
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    await screen.findByText("改密成功");
    // The token + new password reached the confirm call verbatim.
    expect(confirmReset).toHaveBeenCalledWith("tok-abc", VALID_PW);
    expect(screen.getByRole("button", { name: "回到登录" })).toBeInTheDocument();
  });

  it("回到登录 after success fires onBackToLogin", async () => {
    const onBackToLogin = vi.fn();
    render(
      <ResetPasswordPage
        token="tok-abc"
        confirmReset={vi.fn(async () => {})}
        onBackToLogin={onBackToLogin}
      />,
    );
    fillNewPassword(VALID_PW);
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    await screen.findByText("改密成功");
    fireEvent.click(screen.getByRole("button", { name: "回到登录" }));
    expect(onBackToLogin).toHaveBeenCalled();
  });

  it("on 400 shows the unified 链接失效/密码过弱 copy (§24.3, no enumeration of cause)", async () => {
    const confirmReset = vi.fn(async () => {
      throw new ApiError(400, "invalid or expired token");
    });
    render(<ResetPasswordPage token="dead-tok" confirmReset={confirmReset} />);
    fillNewPassword(VALID_PW);
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    await screen.findByText(/链接已失效或密码过弱/);
    // Still on the form (not the success state) so the user can retry / re-request.
    expect(screen.getByRole("button", { name: "重置密码" })).toBeInTheDocument();
  });

  it("on a network failure shows a retriable hint", async () => {
    const confirmReset = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    render(<ResetPasswordPage token="tok" confirmReset={confirmReset} />);
    fillNewPassword(VALID_PW);
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    await screen.findByText(/无法连接到后端/);
  });
});
