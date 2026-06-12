// reset-password.jsx — the 找回密码 reset landing page (SPEC §24.5). A STANDALONE,
// chrome-less page: App mounts ONLY this (no designer / login / settings) when
// matchResetPassword(pathname, search) hits /reset-password?token= (see
// src/core/router.ts + the 路由分流挂载点 note in App.jsx). It never holds the owner
// token; its only I/O is confirmPasswordReset (public, NO Bearer).
//
// The reset token comes from the URL query ONLY (read once by the router, passed in as
// `token`) — never persisted, never logged. Lifecycle:
//   1. token missing/blank → a readable「链接无效」hint + 回登录 entry (no form, the
//      backend would only ever 400 it).
//   2. token present → a form for the new password (+ confirm), with a ≥ 8 local
//      pre-check mirroring §17.2 (the backend re-checks; weak → 400). On submit →
//      confirmPasswordReset(token, password):
//        • 200 → 「改密成功」 + 引导回登录 (the page does not auto-login; §24.3 stores
//                 no session — the user logs in fresh).
//        • 400 → 「链接失效或密码过弱」 (the backend returns a unified 400 that does not
//                 distinguish 失效/过期/已用 vs 弱密码, §24.3) — surfaced verbatim copy.
//        • other/network → a retriable「请稍后重试」.
//
// All chrome from @agentaily/design-system (Input/Button/Alert/Empty). No hand-rolled
// controls. `onBackToLogin` lets the host (App) route the「回登录」action; in production
// it navigates to "/" where the designer's login dialog lives.

import React, { useState } from "react";
import { Input, Button, Alert, Empty } from "@agentaily/design-system";
import { Icon } from "./chat.jsx";
import { confirmPasswordReset as defaultConfirm } from "./core/auth";
import { ApiError } from "./core/apiClient";

const MIN_PASSWORD_LENGTH = 8;

/**
 * The reset-password landing page (SPEC §24.5). Mounted by App at /reset-password?token=.
 *
 * @param {object} props
 * @param {string} props.token                  the one-time reset token from the URL ("" → invalid-link state)
 * @param {(token: string, password: string) => Promise<void>} [props.confirmReset]
 *        injected for tests; defaults to core/auth.confirmPasswordReset (public, NO Bearer)
 * @param {() => void} [props.onBackToLogin]     route the「回登录」action (defaults to navigating to "/")
 */
export function ResetPasswordPage({
  token,
  confirmReset = defaultConfirm,
  onBackToLogin = () => {
    if (typeof window !== "undefined") window.location.assign("/");
  },
} = {}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const hasToken = typeof token === "string" && token.length > 0;

  const submit = async () => {
    if (busy) return;
    const pw = password;
    // Local pre-checks before the round-trip: length (mirrors §17.2 ≥ 8) + match.
    if (pw.length < MIN_PASSWORD_LENGTH) {
      setError(`密码至少 ${MIN_PASSWORD_LENGTH} 位。`);
      return;
    }
    if (pw !== confirm) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await confirmReset(token, pw);
      setPassword("");
      setConfirm("");
      setDone(true);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (!hasToken) {
    // No token in the link → nothing to confirm; guide the user to request a fresh one.
    body = (
      <div className="auth-land__state">
        <Empty
          icon={<Icon name="lock" size={18} />}
          title="链接无效"
          description="这个重置链接缺少必要的信息，可能已损坏。请回到登录页重新发起「忘记密码」。"
        />
        <Button variant="secondary" full onClick={onBackToLogin}>
          回到登录
        </Button>
      </div>
    );
  } else if (done) {
    body = (
      <div className="auth-land__state">
        <Alert variant="ok" title="改密成功">
          你的密码已重置，请用新密码重新登录。
        </Alert>
        <Button
          variant="primary"
          full
          icon={<Icon name="check" size={14} />}
          onClick={onBackToLogin}
        >
          回到登录
        </Button>
      </div>
    );
  } else {
    body = (
      <form
        className="auth-land__form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          label="新密码"
          type="password"
          required
          placeholder="设置一个至少 8 位的新密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <Input
          label="确认新密码"
          type="password"
          required
          placeholder="再次输入新密码"
          value={confirm}
          error={error || undefined}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {/* Hidden submit lets ⏎ fire submit() once; the visible Button is type=button
            with onClick, so a click never double-fires (mirrors LoginDialog). */}
        <button type="submit" style={{ display: "none" }} aria-hidden="true" tabIndex={-1} />
        <Button
          variant="primary"
          full
          disabled={busy}
          icon={<Icon name="check" size={14} />}
          onClick={submit}
        >
          {busy ? "提交中…" : "重置密码"}
        </Button>
      </form>
    );
  }

  return (
    <div className="pf-page">
      <div className="pf-card auth-land">
        <header className="pf-head">
          <h1 className="pf-title">重置密码</h1>
          <p className="pf-desc">为你的 agentaily forms 账户设置一个新密码。</p>
        </header>
        {body}
        <p className="pf-foot ax-label">Powered by agentaily forms</p>
      </div>
    </div>
  );
}

// Map a thrown ApiError (or network error) to readable copy. A 400 is the unified
// 「链接失效 / 密码过弱」 from §24.3 — the backend does not distinguish, so neither do we.
function messageFor(e) {
  if (e instanceof ApiError) {
    if (e.status === 400) return "链接已失效或密码过弱（至少 8 位），请重新发起找回密码。";
    return e.message || `重置失败（${e.status}），请稍后重试。`;
  }
  return "无法连接到后端，请稍后重试。";
}
