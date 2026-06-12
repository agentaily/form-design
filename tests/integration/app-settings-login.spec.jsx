// App-level wiring for the integration-settings 401 → login handoff (SPEC §17).
//
// integration-settings.spec.jsx pins the DIALOG-level contract: a 401 from any
// config call fires onNeedLogin and does NOT render an inline settings error. It
// deliberately stops there and defers the App-level effect of that callback —
// "close settings + pop login" — to this test, so the promise in that file's
// comment is actually backed by an assertion.
//
// We render the real <App/>, inject a getConfig that 401s (same seam App exposes
// for chat/login/logout), open 集成设置 from the header, and assert the dialog
// swaps: settings closes, the owner login dialog opens. No backend / token store.
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
// /pure → no auto afterEach(cleanup); tests/setup.js installs none globally, so we
// unmount explicitly between cases to avoid a leaked App tree.
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { ApiError } from "../../src/core/apiClient";

afterEach(() => cleanup());

// Stubs for the owner-only seams App injects into its children. chat never runs
// in these cases (we don't send a message); login/logout are inert placeholders.
function baseStubs() {
  return { chat: vi.fn(), login: vi.fn(), logout: vi.fn() };
}

function openSettings() {
  fireEvent.click(screen.getByRole("button", { name: "集成设置" }));
}

describe("App wiring: integration-settings 401 routes into owner login", () => {
  it("closes settings and pops the owner login dialog on a config 401", async () => {
    // Arrange: a getConfig that rejects with 401 (missing/expired owner session).
    const getConfig = vi.fn(async () => {
      throw new ApiError(401, "未授权");
    });
    render(
      <App {...baseStubs()} getConfig={getConfig} saveConfig={vi.fn()} testConnections={vi.fn()} />,
    );

    // Act: open 集成设置 — its open effect fetches config and hits the 401.
    openSettings();
    await waitFor(() => expect(getConfig).toHaveBeenCalled());

    // Assert: the dialog swaps — owner login appears, settings is gone, and the
    // raw 401 message is never surfaced as an inline settings error. The dual-mode
    // login dialog title is 「OWNER 登录 / 注册」 (§17 multi-user).
    await screen.findByText("OWNER 登录 / 注册");
    await waitFor(() => expect(screen.queryByText("集成设置")).not.toBeInTheDocument());
    expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
  });
});
