// Inner-loop unit specs for the 邮箱未验证 banner's source of truth (SPEC §23.6).
//
// The banner used to show purely on a session-local heuristic ("a 注册 just happened
// this session"). It now reads the AUTHORITATIVE verified bit from GET /api/auth/me
// (core/auth.getCurrentUser, injected here as the `getCurrentUser` seam) so it is
// correct across reloads AND on a plain 登录 — not just a fresh 注册.
//
// We render the real <App/> in a logged-in session (a token in the store flips the
// header to 已登录 and mounts the banner region), inject a getCurrentUser, and assert
// the banner's presence/absence tracks `emailVerified`. The「刚注册」optimistic value
// is kept only as a no-flicker initial guess; once `me` resolves it is authoritative.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// /pure → no auto afterEach(cleanup); we unmount explicitly between cases.
import { render, screen, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { setToken, clearToken } from "../../src/core/apiClient";

beforeEach(() => {
  // A held token = a logged-in owner session, which is the precondition for the
  // banner to mount at all (it gates on `loggedIn`).
  setToken("owner-jwt");
});
afterEach(() => {
  cleanup();
  clearToken();
});

// chat/login/logout are inert here — no message is ever sent and no dialog driven.
function baseStubs() {
  return { chat: vi.fn(), login: vi.fn(), logout: vi.fn() };
}

const findBanner = () => screen.findByTestId("verify-banner");
const queryBanner = () => screen.queryByTestId("verify-banner");

describe("App: 未验证 banner reads GET /api/auth/me (§23.6)", () => {
  it("shows the banner when me reports the email is NOT verified", async () => {
    const getCurrentUser = vi.fn(async () => ({
      email: "owner@example.com",
      emailVerified: false,
    }));
    render(<App {...baseStubs()} getCurrentUser={getCurrentUser} />);

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    expect(await findBanner()).toBeInTheDocument();
  });

  it("does NOT show the banner when me reports the email IS verified", async () => {
    const getCurrentUser = vi.fn(async () => ({
      email: "owner@example.com",
      emailVerified: true,
    }));
    render(<App {...baseStubs()} getCurrentUser={getCurrentUser} />);

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    // give any state update a tick to flush, then assert it's gone
    await waitFor(() => expect(queryBanner()).not.toBeInTheDocument());
  });

  it("does NOT crash and leaves the banner hidden when me fails / returns null (degraded)", async () => {
    // getCurrentUser is the fail-soft seam: on 401 / network it resolves null.
    const getCurrentUser = vi.fn(async () => null);
    render(<App {...baseStubs()} getCurrentUser={getCurrentUser} />);

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    // No throw, and with no authoritative "unverified" signal the soft banner stays off.
    await waitFor(() => expect(queryBanner()).not.toBeInTheDocument());
    // The app shell still rendered (logged-in AccountControl avatar button present —
    // not the signed-out 登录 text button).
    expect(screen.getByRole("button", { name: "账户菜单" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
  });

  it("adopts the me bit even against the optimistic default (verified owner reloading → no banner)", async () => {
    // A returning, already-verified owner reloads the page: the optimistic default is
    // 'verified' (no banner), me confirms verified — banner must stay off and me must
    // have been consulted (proving it's authoritative, not just coincidence).
    const getCurrentUser = vi.fn(async () => ({
      email: "owner@example.com",
      emailVerified: true,
    }));
    render(<App {...baseStubs()} getCurrentUser={getCurrentUser} />);

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryBanner()).not.toBeInTheDocument());
  });

  it("flips an unverified owner reloading INTO the banner from the optimistic verified default", async () => {
    // The reload case the old heuristic got wrong: an unverified owner who registered in
    // a PRIOR session reloads. There's no「刚注册」signal this session, so the optimistic
    // default is 'verified' — yet me says unverified, and the banner must appear.
    const getCurrentUser = vi.fn(async () => ({
      email: "owner@example.com",
      emailVerified: false,
    }));
    render(<App {...baseStubs()} getCurrentUser={getCurrentUser} />);

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    expect(await findBanner()).toBeInTheDocument();
  });

  it("does not fetch me when logged OUT (no token) — nothing to verify", async () => {
    clearToken();
    const getCurrentUser = vi.fn(async () => ({ email: "x@y.z", emailVerified: false }));
    render(<App {...baseStubs()} getCurrentUser={getCurrentUser} />);

    // The logged-out shell shows the AccountControl 登录 button (no avatar menu) and
    // never mounts the banner.
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "账户菜单" })).not.toBeInTheDocument();
    expect(queryBanner()).not.toBeInTheDocument();
    expect(getCurrentUser).not.toHaveBeenCalled();
  });
});
