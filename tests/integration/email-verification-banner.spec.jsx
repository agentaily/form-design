// App-level frontend realization of the 邮箱验证 (§23.6) UI scenarios from
// features/email-verification.feature. The backend behaviors (注册即发、确认置位、去重三态)
// are realized at the worker level (workers/test/email-verification-api.test.ts); this
// file pins the FRONTEND-only scenarios the feature calls out:
//   - 未验证时显示可重新发送的提示条  → the 未验证 banner (新设计:顶部内联 .vb 条) shows with a
//                                       「待验证」tag + the owner's email + a 重新发送 entry
//   - 已验证时不显示提示条           → a verified owner sees NO banner
//   - 未验证 owner 重新发送验证邮件   → clicking 重新发送 calls the owner-only resend and the
//                                       button enters a cooldown (重新发送 · {n}s, disabled)
//   - 落地页文案（点击有效/失效链接）  → /verify-email?status=ok|invalid copy
//
// The banner's verified bit is the AUTHORITATIVE one from GET /api/auth/me
// (getCurrentUser, §23.6) — we MUST mock it: emailVerified:false → banner present;
// true / a null (401) → banner absent. The App reads `loggedIn` from the token store
// (authIsLoggedIn), so we seed a token to put it in a logged-in session, then clear it.
//
// Like app-settings-login.spec.jsx, this is a plain App-level wiring spec (no gherkin
// binding) — the feature is bound at the backend altitude by name; here each test names
// the frontend scenario it realizes. Chrome is the real @agentaily/design-system Alert.
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
// /pure → no auto cleanup; we unmount + clear the token store explicitly between cases.
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { setToken, clearToken, ApiError } from "../../src/core/apiClient";

// Put the App into a logged-in session: the banner only renders when loggedIn AND
// emailVerified is false (§23.6). loggedIn comes from the token store (authIsLoggedIn),
// so we seed a throwaway token before render and clear it after each case.
function asLoggedIn() {
  setToken("test.session.jwt-not-decoded");
}

// Inert owner-only seams App injects into its children; chat never runs here.
function baseStubs() {
  return { chat: vi.fn(), login: vi.fn(), register: vi.fn(), logout: vi.fn() };
}

afterEach(() => {
  cleanup();
  clearToken();
});

describe("邮箱验证 banner + 落地页 (features/email-verification.feature, §23.6 frontend)", () => {
  it("Scenario: 未验证时显示可重新发送的提示条", async () => {
    // Given 一个邮箱未验证的 owner 已登录 — GET /api/auth/me says emailVerified:false.
    asLoggedIn();
    const getCurrentUser = vi.fn(async () => ({
      email: "owner@example.com",
      emailVerified: false,
    }));
    render(
      <App {...baseStubs()} getCurrentUser={getCurrentUser} requestEmailVerification={vi.fn()} />,
    );

    // When 进入设计器 — the mount effect reads me and adopts the authoritative bit.
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());

    // Then 顶部出现未验证内联条(新设计 .vb):「待验证」脉冲标签 + 「已发送至 <email>」+「重新发送」。
    const banner = await screen.findByTestId("verify-banner");
    expect(banner).toBeInTheDocument();
    expect(within(banner).getByText("待验证")).toBeInTheDocument();
    // 邮箱在 .vb__email 里加粗显示。
    expect(within(banner).getByText("owner@example.com")).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "重新发送" })).toBeInTheDocument();
  });

  it("Scenario: 已验证时不显示提示条", async () => {
    // Given 一个邮箱已验证的 owner 已登录 — GET /api/auth/me says emailVerified:true.
    asLoggedIn();
    const getCurrentUser = vi.fn(async () => ({
      email: "owner@example.com",
      emailVerified: true,
    }));
    render(
      <App {...baseStubs()} getCurrentUser={getCurrentUser} requestEmailVerification={vi.fn()} />,
    );

    // When 进入设计器
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());

    // Then 不显示「邮箱未验证」提示条 — once me resolves verified, the banner is absent.
    await waitFor(() => expect(screen.queryByTestId("verify-banner")).not.toBeInTheDocument());
    expect(screen.queryByText("邮箱未验证")).not.toBeInTheDocument();
  });

  it("Scenario: getCurrentUser 返回 null（401 会话软失效）时不显示 banner", async () => {
    // The banner's bit is fail-soft: a null me (401 / network) leaves the optimistic
    // default (no banner), never crashing the shell (§23.6 fail-soft).
    asLoggedIn();
    const getCurrentUser = vi.fn(async () => null);
    render(
      <App {...baseStubs()} getCurrentUser={getCurrentUser} requestEmailVerification={vi.fn()} />,
    );

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    // No authoritative "unverified" → the default (verified/no-banner) holds.
    await waitFor(() => expect(screen.queryByTestId("verify-banner")).not.toBeInTheDocument());
  });

  it("Scenario: 未验证 owner 重新发送验证邮件（成功后进入冷却倒计时）", async () => {
    // Given 一个邮箱未验证的 owner 已登录 (banner shown).
    asLoggedIn();
    const getCurrentUser = vi.fn(async () => ({
      email: "owner@example.com",
      emailVerified: false,
    }));
    // The owner-only resend always resolves when authenticated (§23.3): no payload.
    const requestEmailVerification = vi.fn(async () => {});
    render(
      <App
        {...baseStubs()}
        getCurrentUser={getCurrentUser}
        requestEmailVerification={requestEmailVerification}
      />,
    );
    const banner = await screen.findByTestId("verify-banner");

    // When 该 owner 点击「重新发送」
    fireEvent.click(within(banner).getByRole("button", { name: "重新发送" }));

    // Then 系统再次向其邮箱发出验证邮件 (the owner-only resend was called)
    await waitFor(() => expect(requestEmailVerification).toHaveBeenCalled());
    // And 新设计:成功后按钮进入冷却(「重新发送 · {n}s」且禁用),防连点,取代旧的「已重新发送」终态。
    await waitFor(() => {
      const btn = within(banner).getByRole("button", { name: /重新发送 · \d+s/ });
      expect(btn).toBeDisabled();
    });
    // 不再有旧的「已重新发送」终态文案。
    expect(screen.queryByText("已重新发送")).not.toBeInTheDocument();
  });

  it("Scenario: 重发遇 401 时引导先登录（会话失效）", async () => {
    // The owner-only resend 401s when the session lapsed — the banner routes into login
    // (same handler shape as the chat/settings 401 flow). Since the UI refactor login is
    // the standalone /signin page, so a 401 navigate()s there instead of popping a dialog.
    asLoggedIn();
    const navigate = vi.fn();
    const getCurrentUser = vi.fn(async () => ({
      email: "owner@example.com",
      emailVerified: false,
    }));
    const requestEmailVerification = vi.fn(async () => {
      throw new ApiError(401, "未授权");
    });
    render(
      <App
        {...baseStubs()}
        navigate={navigate}
        getCurrentUser={getCurrentUser}
        requestEmailVerification={requestEmailVerification}
      />,
    );
    const banner = await screen.findByTestId("verify-banner");

    fireEvent.click(within(banner).getByRole("button", { name: "重新发送" }));

    // A 401 routes the owner to the standalone /signin page (§23.3) and never surfaces
    // the raw 未授权.
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(navigate.mock.calls[0][0]).toMatch(/^\/signin\?/);
    expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
  });

  // --- 公开确认落地页 /verify-email?status= (§23.4 redirect target) ----------

  it("Scenario: 点击有效链接完成验证 — 落地页显示「邮箱已验证」", () => {
    // The backend confirm endpoint marks the email verified then 302s here with
    // ?status=ok (§23.4). App's route split mounts ONLY the bare VerifyEmailPage.
    render(<App pathname="/verify-email" search="?status=ok" />);
    expect(screen.getByText("邮箱已验证")).toBeInTheDocument();
    // The page is chrome-less: no designer surface leaks onto the landing.
    expect(screen.queryByText("描述你想要的表单")).not.toBeInTheDocument();
  });

  it("Scenario: 失效链接 — 落地页显示「链接已失效」(fail-closed)", () => {
    // status=invalid (used / expired / forged token, §23.4) → the 链接已失效 copy.
    render(<App pathname="/verify-email" search="?status=invalid" />);
    expect(screen.getByText("链接已失效")).toBeInTheDocument();
  });

  it("Scenario: 缺 / 未知 status fail-closed 到「链接已失效」", () => {
    // The router normalises a missing/unknown status to "invalid" — the page never
    // claims 已验证 without an explicit status=ok (§23.6 fail-closed).
    render(<App pathname="/verify-email" search="" />);
    expect(screen.getByText("链接已失效")).toBeInTheDocument();
  });
});
