// Cross-cutting smoke specs proving the EN locale actually flows all the way to the
// rendered DOM (not just the L() primitive — that's covered in i18n.test.js). The locale
// is read once at i18n module load, so each case stubs localStorage="en" BEFORE the
// dynamic import, then asserts an English string is on screen. The default-zh path is
// already pinned by every other component spec (which run under the zh default), so these
// only need to confirm the en side renders — i.e. 两语都渲染正常.
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Seed an in-memory localStorage with the en locale, installed before the dynamic import. */
function seedEnLocale() {
  const store = new Map([["agentaily.locale.v1", "en"]]);
  vi.stubGlobal("localStorage", {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => void store.clear(),
  });
}

describe("i18n · EN locale renders end-to-end (两语渲染)", () => {
  it("verify-email landing shows the English success copy under locale=en", async () => {
    seedEnLocale();
    // Dynamic import AFTER the stub so i18n reads en at load → L() returns the English arm.
    const { VerifyEmailPage } = await import("../../src/verify-email.jsx");
    render(<VerifyEmailPage status="ok" noRedirect />);
    expect(screen.getByText("Email verified")).toBeInTheDocument();
    expect(screen.queryByText("邮箱已验证")).not.toBeInTheDocument();
  });

  it("verify-email landing shows the English error copy under locale=en", async () => {
    seedEnLocale();
    const { VerifyEmailPage } = await import("../../src/verify-email.jsx");
    render(<VerifyEmailPage status="invalid" />);
    expect(screen.getByText("Link no longer valid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Resend verification email/ })).toBeInTheDocument();
  });
});
