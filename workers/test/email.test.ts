import { describe, it, expect } from "vitest";
import { buildVerifyEmail, buildResetEmail } from "../src/email";

// Inner-loop unit specs for the PURE email-template builders in email.ts (SPEC.md
// §23.3 / §24.2). These are network-free: a landing-page URL in → { subject, html }
// out. The outer loop mocks fetch to exercise sendEmail; here we only assert the
// rendered content — link embedding, brand wording, the reset 1h notice — and that
// NO secret ever leaks into the body (§22.3).
//
//   - buildVerifyEmail: subject + clickable confirmUrl, Agentaily Forms brand
//   - buildResetEmail:   subject + clickable resetUrl, notes the 1h validity window
//   - neither builder embeds any secret (only the one-shot token inside the URL)

const CONFIRM_URL =
  "https://form-design.agentaily.com/api/auth/verify-email/confirm?token=VERIFYTOKEN123";
const RESET_URL = "https://form-design.agentaily.com/reset-password?token=RESETTOKEN456";

describe("buildVerifyEmail (SPEC.md §23.3)", () => {
  it("returns a non-empty subject and HTML body", () => {
    const { subject, html } = buildVerifyEmail(CONFIRM_URL);
    expect(subject).toBeTypeOf("string");
    expect(subject.length).toBeGreaterThan(0);
    expect(html).toBeTypeOf("string");
    expect(html.length).toBeGreaterThan(0);
  });

  it("carries the Agentaily Forms brand in the subject", () => {
    const { subject } = buildVerifyEmail(CONFIRM_URL);
    expect(subject).toContain("Agentaily Forms");
  });

  it("embeds the confirm URL as a clickable href", () => {
    const { html } = buildVerifyEmail(CONFIRM_URL);
    expect(html).toContain(CONFIRM_URL);
    // It must be a real clickable link, not just bare text.
    expect(html).toContain(`href="${CONFIRM_URL}"`);
  });

  it("never leaks a secret-looking value beyond the URL's one-shot token", () => {
    const { subject, html } = buildVerifyEmail(CONFIRM_URL);
    // No API key shapes (Resend keys start with re_) anywhere in the rendered mail.
    expect(subject).not.toMatch(/re_[A-Za-z0-9]/);
    expect(html).not.toMatch(/re_[A-Za-z0-9]/);
    expect(html).not.toMatch(/Bearer/i);
  });
});

describe("buildResetEmail (SPEC.md §24.2)", () => {
  it("returns a non-empty subject and HTML body", () => {
    const { subject, html } = buildResetEmail(RESET_URL);
    expect(subject.length).toBeGreaterThan(0);
    expect(html.length).toBeGreaterThan(0);
  });

  it("carries the Agentaily Forms brand in the subject", () => {
    const { subject } = buildResetEmail(RESET_URL);
    expect(subject).toContain("Agentaily Forms");
  });

  it("embeds the reset URL as a clickable href", () => {
    const { html } = buildResetEmail(RESET_URL);
    expect(html).toContain(RESET_URL);
    expect(html).toContain(`href="${RESET_URL}"`);
  });

  it("notes the link is short-lived (1 小时 / 1h validity window, §24.4)", () => {
    const { html } = buildResetEmail(RESET_URL);
    // The reset window is intentionally short — the body must say so.
    expect(html).toMatch(/1\s*(小时|hour|h\b)/i);
  });

  it("never leaks a secret-looking value beyond the URL's one-shot token", () => {
    const { subject, html } = buildResetEmail(RESET_URL);
    expect(subject).not.toMatch(/re_[A-Za-z0-9]/);
    expect(html).not.toMatch(/re_[A-Za-z0-9]/);
    expect(html).not.toMatch(/Bearer/i);
  });
});
