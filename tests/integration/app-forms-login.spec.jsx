// App-level wiring for the 表单管理 / 发布 401 → login handoff (SPEC §17), plus the
// "FormsPanel is inert when closed" invariant.
//
// form-publish-mgmt.spec.jsx pins the COMPONENT-level contract: a 401 from any
// forms call fires onNeedLogin and does NOT render an inline error. It defers the
// App-level effect of that callback — "close panel + route to /signin" — to here,
// mirroring app-settings-login.spec.jsx (which does the same for 集成设置).
//
// Since the UI refactor, login is a standalone /signin page (not an in-app modal):
// 「我的表单」 is reached from the AccountControl avatar menu (so the owner must be
// logged in to open it via guard), and a forms 401 closes the panel and navigate()s
// to /signin?return=&reason= instead of popping a dialog. We render the real <App/>,
// inject the owner-only forms seams + a navigate spy, and assert: (1) before opening,
// FormsPanel is inert — no listForms on mount; (2) opening with a 401 listForms closes
// the panel and routes to /signin. No backend.
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
// /pure → no auto afterEach(cleanup); we unmount explicitly between cases.
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { setToken, clearToken, ApiError } from "../../src/core/apiClient";
import { authedCheck } from "../helpers/authGate.js";

afterEach(() => {
  cleanup();
  clearToken();
});

// A held token puts the App into a logged-in session so the guarded 「我的表单」 entry
// opens the panel instead of bouncing straight to /signin. me resolves verified.
function baseStubs() {
  return {
    // Entry guard seam: authed so the designer (+ its 我的表单 entry) mounts behind the page-level 守卫.
    checkSession: authedCheck,
    chat: vi.fn(),
    getCurrentUser: async () => ({ email: "owner@example.com", emailVerified: true }),
  };
}

// 「我的表单」 lives in the AccountControl avatar menu (logged-in). Open the menu, click it.
async function openMyForms() {
  await waitFor(() => expect(document.querySelector(".am-acct")).toBeInTheDocument());
  fireEvent.click(document.querySelector(".am-acct"));
  fireEvent.click(screen.getByRole("menuitem", { name: /我的表单/ }));
}

describe("App wiring: FormsPanel mount + 401 routes into the /signin page", () => {
  it("does not fetch the forms list until 「我的表单」 is opened (inert when closed)", async () => {
    // App mounts <FormsPanel> unconditionally (like the PublishFeedback overlay), so it
    // must NOT call listForms on mount — only when the panel is actually opened. We don't
    // even need a session for this: the closed panel must stay quiet either way.
    const listForms = vi.fn(async () => []);
    render(<App {...baseStubs()} listForms={listForms} publishForm={vi.fn()} />);

    // Give any mount effects a tick to run; the closed panel must stay quiet.
    await Promise.resolve();
    expect(listForms).not.toHaveBeenCalled();
  });

  it("closes the panel and routes to /signin on a forms-list 401", async () => {
    // A listForms that rejects with 401 (missing/expired owner session).
    const navigate = vi.fn();
    const listForms = vi.fn(async () => {
      throw new ApiError(401, "未授权");
    });
    setToken("owner-jwt");
    render(
      <App {...baseStubs()} navigate={navigate} listForms={listForms} publishForm={vi.fn()} />,
    );

    // Open 「我的表单」 — its open effect fetches the list and hits the 401.
    await openMyForms();
    await waitFor(() => expect(listForms).toHaveBeenCalled());

    // The dialog swaps: the owner is routed to the standalone /signin page (no in-app
    // login dialog), and the raw 401 is never surfaced inline.
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(navigate.mock.calls[0][0]).toMatch(/^\/signin\?/);
    expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
  });
});
