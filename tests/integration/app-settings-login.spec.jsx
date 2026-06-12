// App-level wiring for 集成设置 since it became a standalone /settings route (DS 0.6.0).
//
// integration-settings.spec.jsx pins the PAGE-level contract on <SettingsScreen> (echo,
// save, backend errors, per-block test, 401 → navigate to /signin). This file pins the
// two App-level seams the page contract leaves to App:
//   1. The AccountControl avatar menu「集成设置」navigates a logged-in owner to /settings
//      (the page is no longer an in-app modal).
//   2. App's route split renders <SettingsScreen> on /settings and threads the config
//      seams + navigate so a config 401 on that page routes the owner to /signin (carrying
//      return=/settings) without surfacing the raw 401.
// We render the real <App/> with a held token (logged-in session) + an injected navigate
// spy. No backend.
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
// /pure → no auto afterEach(cleanup); tests/setup.js installs none globally, so we
// unmount explicitly between cases to avoid a leaked App tree.
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { setToken, clearToken, ApiError } from "../../src/core/apiClient";

afterEach(() => {
  cleanup();
  clearToken();
});

// A held token puts the App into a logged-in session (authIsLoggedIn) so the guarded
// 集成设置 entry navigates to /settings instead of bouncing to /signin. me resolves
// verified (no banner). chat never runs here (we don't send a message).
function baseStubs() {
  return {
    chat: vi.fn(),
    getCurrentUser: async () => ({ email: "owner@example.com", emailVerified: true }),
  };
}

describe("App wiring: 集成设置 navigates a logged-in owner to /settings", () => {
  it("routes to /settings from the account menu (no in-app modal)", async () => {
    const navigate = vi.fn();
    setToken("owner-jwt");
    render(<App {...baseStubs()} navigate={navigate} />);

    // Open the AccountControl menu and click 集成设置.
    await waitFor(() => expect(document.querySelector(".am-acct")).toBeInTheDocument());
    fireEvent.click(document.querySelector(".am-acct"));
    fireEvent.click(screen.getByRole("menuitem", { name: /集成设置/ }));

    // A logged-in owner is taken straight to the standalone /settings page.
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/settings"));
  });
});

describe("App wiring: a config 401 on /settings routes into the /signin page (SPEC §17)", () => {
  it("renders the settings page on /settings and routes to /signin on a config 401", async () => {
    // Arrange: render App ON the /settings route with a getConfig that rejects 401
    // (missing/expired owner session). App's route split mounts <SettingsScreen> and
    // threads these seams.
    const navigate = vi.fn();
    const getConfig = vi.fn(async () => {
      throw new ApiError(401, "未授权");
    });
    render(
      <App
        {...baseStubs()}
        pathname="/settings"
        navigate={navigate}
        getConfig={getConfig}
        saveConfig={vi.fn()}
        testConnections={vi.fn()}
      />,
    );

    // Act: the page's mount effect fetches config and hits the 401.
    await waitFor(() => expect(getConfig).toHaveBeenCalled());

    // Assert: the owner is routed to the standalone /signin page (carrying return=/settings),
    // and the raw 401 message is never surfaced as an inline settings error.
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(navigate.mock.calls[0][0]).toMatch(/^\/signin\?/);
    expect(navigate.mock.calls[0][0]).toContain("return=%2Fsettings");
    expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
  });
});
