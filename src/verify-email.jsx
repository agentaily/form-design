// verify-email.jsx — the 邮箱验证 result landing page (SPEC §23.6), now built on the
// OFFICIAL design-system <VerifyEmailPage> (DS 0.12.0) instead of a hand-rolled
// Empty/Button shim. The component owns the verifying → ok / error state machine and its
// baked-in hard rules (error never auto-redirects, success counts down to a return that
// can be cancelled, resend is cooldown-gated + idempotent +「重发 ≠ 已验证」). We inject
// only the product wiring + fully-localised copy.
//
// ── Why CONTROLLED mode (not a client-side verifyToken) ──────────────────────────────
// form-design's backend confirms SERVER-SIDE (§23.4, shipped + unchanged): the link in
// the email points at the backend confirm endpoint (GET /api/auth/verify-email/confirm?
// token=), which consumes the one-time token, marks the email verified, then 302-redirects
// HERE carrying the verdict in ?status= (router-normalised to "ok" | "invalid",
// fail-closed). So by the time THIS page mounts the verdict is ALREADY decided — there is
// nothing to verify in the browser. The honest fit is therefore the component's CONTROLLED
// mode (`status` + `error`), which displays that pre-decided verdict with no fake spinner
// and — crucially — NO backend-contract change. (Driving it via an injected verifyToken
// instead would mean flipping the email link to the frontend + adding a JSON confirm
// endpoint: a backend pivot deliberately out of this PR's "纯前端 / 无迁移" scope.)
//
// Still injected per the handoff: `onResend` (owner-only requestEmailVerification, §23.3),
// `returnTo` / `onContinue` (回到设计器), `onBackToSignIn`, `email`, and an i18n `copy` bag.
// Product L5 stays put: the backend confirm itself + the in-app 未验证 banner's resend.

import React from "react";
import { VerifyEmailPage as DSVerifyEmailPage } from "@agentaily/design-system";
import { requestEmailVerification } from "./core/auth";
import { SIGNIN_PATH } from "./core/router";
import { L } from "./core/i18n";

// The designer entry the success state returns to. Internal-only: there is no
// user-controlled return URL on this route, so there is no open-redirect surface here
// (cf. the prototype's `^[\w.\-]+\.html$` guard, which is a static-HTML-world concern that
// does not map onto this SPA's routes — we simply land on "/").
const RETURN_TARGET = { label: "Agentaily", href: "/" };

/**
 * The email-verification result landing page (SPEC §23.6). Mounted by App at
 * /verify-email?status=ok|invalid; the official DS component is driven in controlled mode
 * off that backend-supplied verdict.
 *
 * @param {object} props
 * @param {"ok" | "invalid"} props.status            the backend-supplied result (router-normalised)
 * @param {string} [props.email]                      address being verified (shown in a mono chip; omit → no chip)
 * @param {boolean} [props.noRedirect=false]          disable the success auto-return countdown
 * @param {() => void} [props.onBackToApp]            route 回到设计器 (defaults to navigating to "/")
 * @param {() => Promise<void>} [props.onResend]      resend the verification email (defaults to the owner-only API)
 * @param {(url: string) => void} [props.navigate]    navigation seam (defaults to a real assign); used by 返回登录
 */
export function VerifyEmailPage({
  status,
  email,
  noRedirect = false,
  onBackToApp = () => {
    if (typeof window !== "undefined") window.location.assign("/");
  },
  onResend = () => requestEmailVerification(),
  navigate = (url) => {
    if (typeof window !== "undefined") window.location.assign(url);
  },
} = {}) {
  const ok = status === "ok";

  // The backend redirect distinguishes only ok vs invalid (it carries no expired/used/
  // invalid reason), so the error detail is a single generic, fail-closed message. It
  // becomes the component's error subtitle in controlled mode.
  const errorDetail = L(
    "这个验证链接无效或已过期。回到设计器后，可在顶部提示条点「重新发送」获取一封新的验证邮件。",
    "This verification link is invalid or has expired. Back in the designer, tap “Resend” in the top banner to get a fresh one.",
  );

  // All user-facing strings, locale-resolved via L() and shallow-merged over the DS English
  // defaults. {seconds} / {target} are interpolated by the component.
  const copy = {
    verifying: {
      title: L("正在验证你的邮箱", "Verifying your email"),
      subtitle: L(
        "正在确认邮件链接里的验证结果，请稍候。",
        "Confirming the result from your email link…",
      ),
    },
    ok: {
      title: L("邮箱已验证", "Email verified"),
      subtitle: L(
        "你的邮箱已成功验证，这个邮箱现在归你所有。可以回到设计器继续使用。",
        "Your email is verified — it's now yours. Head back to the designer to keep going.",
      ),
      continue: L("回到设计器", "Back to the designer"),
      continueNow: L("立即返回", "Go now"),
      redirectHint: L("{seconds}s 后自动返回 {target}…", "Returning to {target} in {seconds}s…"),
      cancelRedirect: L("留在本页", "Stay on this page"),
    },
    error: {
      title: L("链接已失效", "Link no longer valid"),
      subtitle: errorDetail,
      retry: L("重试", "Try again"),
      backToSignIn: L("返回登录", "Back to sign in"),
    },
    resend: {
      cta: L("重新发送验证邮件", "Resend verification email"),
      sending: L("发送中…", "Sending…"),
      cooldown: L("{seconds}s 后可重发", "Resend in {seconds}s"),
      sent: L(
        "验证邮件已重新发送，请查收。",
        "A new verification email is on its way — check your inbox.",
      ),
      error: L("发送失败，请稍后重试。", "Couldn't send. Please try again shortly."),
      notVerified: L(
        "重新发送只是再发一封，你仍需打开邮件里的链接完成验证。",
        "Resending just sends another email — you still need to open the link inside it to finish.",
      ),
    },
    target: "Agentaily",
  };

  return (
    <DSVerifyEmailPage
      // Controlled: the backend already decided the verdict (§23.4); we just display it.
      status={ok ? "ok" : "error"}
      error={ok ? undefined : errorDetail}
      email={email}
      returnTo={RETURN_TARGET}
      noRedirect={noRedirect}
      // 回到设计器 — internal-only navigation (no open-redirect surface here).
      onContinue={() => onBackToApp()}
      // owner-only resend (§23.3): a resolve = 「已重新发送」; a 401 surfaces in place and
      // 返回登录 routes the owner to sign in.
      onResend={onResend}
      onBackToSignIn={() => navigate(SIGNIN_PATH)}
      copy={copy}
    />
  );
}
