// App-level wiring for 设置 since it became a floating, route-reflected overlay (DS 0.8.0).
//
// integration-settings.spec.jsx pins the TAB-level contract on <SettingsOverlay section=
// "integrations"> (echo, save, backend errors, per-block test, 401 → onNeedLogin). This file
// pins the two App-level seams that contract leaves to App:
//   1. The AccountControl avatar menu「集成设置」OPENS the floating overlay over the designer
//      (NOT a route navigation / unmount), reflecting a /settings/:tab URL via history (the active
//      tab is now in the path, PR #76).
//   2. A deep-link to /settings opens the overlay; a config 401 on it routes the owner into
//      /signin (carrying return=/settings…) without surfacing the raw 401 or unmounting the
//      designer.
// We render the real <App/> with a held token (logged-in session) + injected config seams (so
// the integration tab's fetch is deterministic, no backend).
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
// /pure → no auto afterEach(cleanup); tests/setup.js installs none globally, so we
// unmount explicitly between cases to avoid a leaked App tree.
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { setToken, clearToken, ApiError } from "../../src/core/apiClient";
import { DESIGN_PROJECT_ID_KEY } from "../../src/core/projectClient";
import { readProjectId } from "../../src/core/router";

afterEach(() => {
  cleanup();
  clearToken();
  try {
    localStorage.removeItem(DESIGN_PROJECT_ID_KEY);
  } catch {
    /* ignore */
  }
  // The overlay pushes a /p/:id/settings history entry; reset the URL so cases don't leak.
  window.history.pushState({}, "", "/");
});

// A' 项目↔对话 (§26.10): the designer now lives at /p/:projectId, and settings nests under it
// (/p/:id/settings/:tab). The App also consumes loadProject / saveProjectWorkspace / listProjects +
// renameChatSession; inject empty-state fakes so the logged-in restore doesn't hit the real client
// (real fetch → undefined in jsdom). The project id is a minted UUID, so assert the /settings/:tab
// suffix + that a project segment is present, not an exact id.
function withProjectClients(props = {}) {
  return {
    loadProject: vi.fn(async () => ({ project: null })),
    saveProjectWorkspace: vi.fn(async () => ({ projectId: "pj", updatedAt: "t" })),
    listProjects: vi.fn(async () => ({ projects: [] })),
    renameChatSession: vi.fn(async () => ({ renamed: true })),
    loadChatSession: vi.fn(async () => ({ session: null })),
    saveChatTurns: vi.fn(async () => ({ sessionId: "x", updatedAt: "t" })),
    listChatSessions: vi.fn(async () => ({ sessions: [] })),
    ...props,
  };
}

// A held token puts the App into a logged-in session (authIsLoggedIn) so the guarded 集成设置
// entry opens the overlay instead of bouncing to /signin. me resolves verified (no banner). An
// empty masked config keeps the integration tab's mount fetch deterministic. chat never runs.
const EMPTY_CONFIG = {
  deepseek: { apiKey: null, model: null },
  feishu: { appId: null, appSecret: null, appToken: null, tableId: null },
  updatedAt: null,
};
function baseStubs() {
  return {
    chat: vi.fn(),
    getCurrentUser: async () => ({
      email: "owner@example.com",
      emailVerified: true,
      displayName: null,
    }),
    getConfig: vi.fn(async () => EMPTY_CONFIG),
    saveConfig: vi.fn(async () => EMPTY_CONFIG),
    testConnection: vi.fn(async () => ({ ok: false })),
  };
}

describe("App wiring: 集成设置 opens the floating overlay over the designer (DS 0.8.0)", () => {
  it("opens the settings overlay from the account menu and reflects a /settings/:tab URL (no unmount)", async () => {
    const navigate = vi.fn();
    setToken("owner-jwt");
    render(<App {...baseStubs()} {...withProjectClients()} navigate={navigate} />);

    // Open the AccountControl menu and click 集成设置.
    await waitFor(() => expect(document.querySelector(".am-acct")).toBeInTheDocument());
    fireEvent.click(document.querySelector(".am-acct"));
    fireEvent.click(screen.getByRole("menuitem", { name: /集成设置/ }));

    // The floating overlay opens over the designer (its 保存 bar appears) — App did NOT navigate
    // away, and the URL now reflects settings (history.pushState, designer still mounted).
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument());
    expect(navigate).not.toHaveBeenCalled();
    // 集成设置 opens the 集成 tab → the URL reflects the 集成 tab. A' (§26.10): settings now nests
    // UNDER the project (/p/:id/settings/integrations) so the project stays in the URL while open.
    expect(window.location.pathname).toMatch(/^\/p\/[^/]+\/settings\/integrations$/);
    expect(readProjectId(window.location.pathname)).toBeTruthy();
    // The designer underneath stays mounted (its 发布 action is still present).
    expect(screen.getByRole("button", { name: /发布/ })).toBeInTheDocument();
  });
});

describe("App wiring: the route-reflected overlay closes back to the designer (DS 0.8.0)", () => {
  it("closes on Esc, restores the prior URL, and keeps the designer mounted", async () => {
    setToken("owner-jwt");
    render(<App {...baseStubs()} {...withProjectClients()} navigate={vi.fn()} />);

    await waitFor(() => expect(document.querySelector(".am-acct")).toBeInTheDocument());
    fireEvent.click(document.querySelector(".am-acct"));
    fireEvent.click(screen.getByRole("menuitem", { name: /集成设置/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument());
    expect(window.location.pathname).toMatch(/^\/p\/[^/]+\/settings\/integrations$/);
    const projectId = readProjectId(window.location.pathname);

    // Esc closes the floating sheet (PanelSheet wires Esc → onClose → closeSettings).
    fireEvent.keyDown(document, { key: "Escape" });

    // The overlay unmounts and the URL steps back to the pre-overlay designer (A': /p/:id, the
    // project stays — designer stays mounted).
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(window.location.pathname).toBe(`/p/${projectId}`));
    expect(screen.getByRole("button", { name: /发布/ })).toBeInTheDocument();
  });

  it("closes when the browser Back button pops the /settings entry", async () => {
    setToken("owner-jwt");
    render(<App {...baseStubs()} {...withProjectClients()} navigate={vi.fn()} />);

    await waitFor(() => expect(document.querySelector(".am-acct")).toBeInTheDocument());
    fireEvent.click(document.querySelector(".am-acct"));
    fireEvent.click(screen.getByRole("menuitem", { name: /集成设置/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument());
    const projectId = readProjectId(window.location.pathname);

    // Browser Back: popping the /p/:id/settings entry closes the overlay (URL ↔ overlay in sync).
    window.history.back();

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument(),
    );
    // Back lands on the designer at /p/:id (the project stays in the URL under A').
    await waitFor(() => expect(window.location.pathname).toBe(`/p/${projectId}`));
  });
});

describe("App wiring: a config 401 in the settings overlay routes into /signin (SPEC §17)", () => {
  it("opens the overlay on a /settings deep-link and routes to /signin on a config 401", async () => {
    // Arrange: render App ON the /settings path (deep-link) with a getConfig that rejects 401
    // (missing/expired owner session). DesignerApp opens the overlay; the 集成 tab fetch hits 401.
    const navigate = vi.fn();
    const getConfig = vi.fn(async () => {
      throw new ApiError(401, "未授权");
    });
    render(
      <App
        {...baseStubs()}
        {...withProjectClients()}
        pathname="/settings"
        navigate={navigate}
        getConfig={getConfig}
      />,
    );

    // Act: the overlay's 集成 tab mount-fetch hits the 401.
    await waitFor(() => expect(getConfig).toHaveBeenCalled());

    // Assert: the owner is routed to the standalone /signin page (carrying return=/settings), and
    // the raw 401 message is never surfaced as an inline settings error.
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(navigate.mock.calls[0][0]).toMatch(/^\/signin\?/);
    expect(navigate.mock.calls[0][0]).toContain("return=%2Fsettings");
    expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
  });
});
