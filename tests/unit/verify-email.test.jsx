// Inner-loop unit specs for src/verify-email.jsx — the 邮箱验证 result landing page
// (SPEC §23.6). It does NO backend call: the backend confirm endpoint 302s here with
// the outcome in ?status= (router-normalised to "ok" | "invalid", fail-closed). The
// page shows the matching two-state result + a 回到设计器 entry. onBackToApp is
// injectable so the affordance is asserted without a real navigation.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { VerifyEmailPage } from "../../src/verify-email.jsx";

afterEach(() => cleanup());

describe("VerifyEmailPage · status=ok", () => {
  it("shows 邮箱已验证 and a 回到设计器 entry", () => {
    render(<VerifyEmailPage status="ok" />);
    expect(screen.getByText("邮箱已验证")).toBeInTheDocument();
    expect(screen.queryByText("链接已失效")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回到设计器" })).toBeInTheDocument();
  });

  it("回到设计器 fires onBackToApp", () => {
    const onBackToApp = vi.fn();
    render(<VerifyEmailPage status="ok" onBackToApp={onBackToApp} />);
    fireEvent.click(screen.getByRole("button", { name: "回到设计器" }));
    expect(onBackToApp).toHaveBeenCalled();
  });
});

describe("VerifyEmailPage · status=invalid", () => {
  it("shows 链接已失效 (never claims verified) and the 回到设计器 entry", () => {
    render(<VerifyEmailPage status="invalid" />);
    expect(screen.getByText("链接已失效")).toBeInTheDocument();
    expect(screen.queryByText("邮箱已验证")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回到设计器" })).toBeInTheDocument();
  });
});
