// App-level wiring for the 表单管理 / 发布 401 → login handoff (SPEC §17), plus the
// "FormsPanel is inert when closed" invariant.
//
// form-publish-mgmt.spec.jsx pins the COMPONENT-level contract: a 401 from any
// forms call fires onNeedLogin and does NOT render an inline error. It defers the
// App-level effect of that callback — "close panel + pop login" — to here, mirroring
// app-settings-login.spec.jsx (which does the same for 集成设置).
//
// We render the real <App/>, inject the owner-only forms seams (listForms/publishForm)
// the same way App exposes getConfig/saveConfig/testConnections for SettingsDialog,
// open 「我的表单」 from the header, and assert: (1) before opening, FormsPanel is inert
// — no listForms fired on mount; (2) opening with a 401 listForms swaps settings/panel
// out and pops the owner login dialog. No backend / token store.
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
// /pure → no auto afterEach(cleanup); we unmount explicitly between cases.
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { ApiError } from "../../src/core/apiClient";

afterEach(() => cleanup());

// Owner-only seams App injects into its children. chat never runs here (we don't send
// a message); login/logout are inert placeholders.
function baseStubs() {
  return { chat: vi.fn(), login: vi.fn(), logout: vi.fn() };
}

function openMyForms() {
  // The 「我的表单」 entry — a header control labelled for the forms list.
  fireEvent.click(screen.getByRole("button", { name: /我的表单/ }));
}

describe("App wiring: FormsPanel mount + 401 routes into owner login", () => {
  it("does not fetch the forms list until 「我的表单」 is opened (inert when closed)", async () => {
    // App mounts <FormsPanel> unconditionally (like SettingsDialog), so it must NOT
    // call listForms on mount — only when the panel is actually opened.
    const listForms = vi.fn(async () => []);
    render(<App {...baseStubs()} listForms={listForms} publishForm={vi.fn()} />);

    // Give any mount effects a tick to run; the closed panel must stay quiet.
    await Promise.resolve();
    expect(listForms).not.toHaveBeenCalled();
  });

  it("closes the panel and pops the owner login dialog on a forms-list 401", async () => {
    // A listForms that rejects with 401 (missing/expired owner session).
    const listForms = vi.fn(async () => {
      throw new ApiError(401, "未授权");
    });
    render(<App {...baseStubs()} listForms={listForms} publishForm={vi.fn()} />);

    // Open 「我的表单」 — its open effect fetches the list and hits the 401.
    openMyForms();
    await waitFor(() => expect(listForms).toHaveBeenCalled());

    // The dialog swaps: owner login appears, and the raw 401 is never surfaced inline.
    // The dual-mode login dialog title is 「OWNER 登录 / 注册」 (§17 multi-user).
    await screen.findByText("OWNER 登录 / 注册");
    expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
  });
});
