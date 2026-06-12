// auth.jsx — owner login/register/account dialog (SPEC §17, multi-user frontend).
// One DS Dialog that flips on `loggedIn`:
//   • logged-out → a 「登录 / 注册」 dual-mode form (DS Tabs switches mode), each
//     mode posting email + password to /api/auth/login or /api/auth/register; plus a
//     「忘记密码？」 entry that flips to the 找回密码 sub-state (§24.5).
//   • logged-in  → an "已登录" panel with a logout action.
// `login`/`register`/`logout`/`requestPasswordReset` default to the real core/auth
// functions but are injectable so tests stay deterministic. Error copy distinguishes
// 409 (邮箱已注册) / 401 (账号或密码错) / weak-password 400 / network (§17
// owner-login.feature). The 找回密码 sub-state always shows ONE neutral copy「若该邮箱
// 已注册，我们已发送重置链接」regardless of outcome — anti-enumeration (§24.5).
import React, { useState, useEffect } from "react";
import { Dialog, Tabs, Input, Button, Alert } from "@agentaily/design-system";
import { Icon } from "./chat.jsx";
import {
  login as authLogin,
  register as authRegister,
  logout as authLogout,
  requestPasswordReset as authRequestPasswordReset,
} from "./core/auth";
import { ApiError } from "./core/apiClient";

const MIN_PASSWORD_LENGTH = 8;

// The single neutral copy shown after any 找回密码 发起 — registered or not, success or
// backend hiccup. It MUST be identical in every branch so the dialog never leaks
// whether the email exists (§24.5 anti-enumeration).
const RESET_NEUTRAL_COPY = "若该邮箱已注册，我们已发送重置链接，请查收邮件。";

export function LoginDialog({
  open,
  loggedIn,
  onClose,
  onLoggedIn,
  onLoggedOut,
  login = authLogin,
  register = authRegister,
  logout = authLogout,
  requestPasswordReset = authRequestPasswordReset,
}) {
  // 'auth' | 'forgot' — the logged-out dialog flips between the 登录/注册 form and the
  // 找回密码 sub-state. (logged-in always shows the account panel regardless.)
  const [view, setView] = useState("auth");
  // 'login' | 'register' — the dual mode toggled by the DS Tabs.
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // 找回密码 sub-state: its own email field + the neutral "sent" flag.
  const [resetEmail, setResetEmail] = useState("");
  const [resetSent, setResetSent] = useState(false);

  // Each (re)open starts from a clean form — no stale email/password/error/mode/view.
  useEffect(() => {
    if (open) {
      setView("auth");
      setMode("login");
      setEmail("");
      setPassword("");
      setError("");
      setBusy(false);
      setResetEmail("");
      setResetSent(false);
    }
  }, [open]);

  // Switching mode clears the inline error (a 邮箱已注册 from register shouldn't
  // linger when the author flips to 登录) but keeps the typed email/password.
  const switchMode = (next) => {
    if (next === mode) return;
    setMode(next);
    setError("");
  };

  const registering = mode === "register";

  const submit = async () => {
    const em = email.trim();
    const pw = password;
    if (!em || !pw || busy) return;
    // Local pre-check so 弱密码 is caught before a round-trip (matches the backend
    // ≥ 8 rule, §17.2) — register's 400 is still handled below as a backstop.
    if (registering && pw.length < MIN_PASSWORD_LENGTH) {
      setError(`密码至少 ${MIN_PASSWORD_LENGTH} 位。`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (registering) await register(em, pw);
      else await login(em, pw);
      setPassword("");
      // Tell the host whether this was a 注册 (→ email_verified=0, show the unverified
      // banner this session, §23.6) or a 登录 (we don't know verified state — no banner).
      onLoggedIn?.({ registered: registering });
    } catch (e) {
      setError(messageFor(e, registering));
    } finally {
      setBusy(false);
    }
  };

  const doLogout = () => {
    logout();
    onLoggedOut?.();
  };

  // Flip into the 找回密码 sub-state, seeding its email from whatever was typed in the
  // login field (a convenience; clears any auth error).
  const openForgot = () => {
    setView("forgot");
    setResetEmail(email.trim());
    setResetSent(false);
    setError("");
    setBusy(false);
  };

  const backToAuth = () => {
    setView("auth");
    setError("");
    setBusy(false);
  };

  // 发起找回密码: always lands on the SAME neutral copy. requestPasswordReset itself
  // never rejects (anti-enumeration), but we guard anyway so no outcome ever differs.
  const submitReset = async () => {
    const em = resetEmail.trim();
    if (!em || busy) return;
    setBusy(true);
    try {
      await requestPasswordReset(em);
    } catch {
      // Swallow: the neutral "sent" copy is shown regardless (never leak existence).
    } finally {
      setBusy(false);
      setResetSent(true);
    }
  };

  const canSubmit = !!email.trim() && !!password && !busy;
  const forgot = view === "forgot";

  // Dialog title reflects the active surface.
  const title = loggedIn ? "OWNER 账户" : forgot ? "找回密码" : "OWNER 登录 / 注册";

  // Footer primary action depends on the surface: logout / 发送重置链接 / 登录注册.
  let footer;
  if (loggedIn) {
    footer = (
      <Button variant="secondary" icon={<Icon name="lock" size={14} />} onClick={doLogout}>
        登出
      </Button>
    );
  } else if (forgot) {
    footer = resetSent ? (
      <Button variant="primary" icon={<Icon name="arrow-left" size={14} />} onClick={backToAuth}>
        返回登录
      </Button>
    ) : (
      <Button
        variant="primary"
        icon={<Icon name="check" size={14} />}
        disabled={!resetEmail.trim() || busy}
        onClick={submitReset}
      >
        {busy ? "发送中…" : "发送重置链接"}
      </Button>
    );
  } else {
    footer = (
      <Button
        variant="primary"
        icon={<Icon name="check" size={14} />}
        disabled={!canSubmit}
        onClick={submit}
      >
        {busy ? (registering ? "注册中…" : "登录中…") : registering ? "注册" : "登录"}
      </Button>
    );
  }

  let bodyContent;
  if (loggedIn) {
    bodyContent = (
      <Alert variant="ok" title="已登录">
        你已作为 owner 登录，可以使用对话设计、集成设置与表单管理。
      </Alert>
    );
  } else if (forgot) {
    // 找回密码 sub-state (§24.5). After 发起 we show ONE neutral copy regardless of
    // whether the email is registered (anti-enumeration) — never a different message.
    bodyContent = resetSent ? (
      <Alert variant="ok" title="已发送（若该邮箱已注册）">
        {RESET_NEUTRAL_COPY}
      </Alert>
    ) : (
      <React.Fragment>
        <p className="d-auth__note">
          输入你的注册邮箱，我们会发送一个重置链接。出于安全，无论邮箱是否注册，提示都相同。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitReset();
          }}
        >
          <Input
            label="邮箱"
            type="email"
            required
            placeholder="owner@example.com"
            value={resetEmail}
            onChange={(e) => setResetEmail(e.target.value)}
            autoFocus
          />
          <button type="submit" style={{ display: "none" }} aria-hidden="true" tabIndex={-1} />
        </form>
        <button type="button" className="d-auth__link" onClick={backToAuth}>
          返回登录
        </button>
      </React.Fragment>
    );
  } else {
    bodyContent = (
      <React.Fragment>
        <div className="d-auth__modes">
          <Tabs
            items={[
              { id: "login", label: "登录" },
              { id: "register", label: "注册" },
            ]}
            active={mode}
            onChange={switchMode}
          />
        </div>
        <p className="d-auth__note">
          {registering
            ? "用邮箱 + 密码注册即成为 owner（密码至少 8 位），注册即登录。"
            : "用邮箱 + 密码登录。登录后对话设计（/api/chat）与管理功能才会解锁。"}
        </p>
        {/* Enter-to-submit: a real <form> wraps the fields; the hidden submit
            button lets ⏎ fire submit() without a visible second action. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            label="邮箱"
            type="email"
            required
            placeholder="owner@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
          <Input
            label="密码"
            type="password"
            required
            placeholder={registering ? "设置一个至少 8 位的密码" : "输入登录密码"}
            value={password}
            error={error || undefined}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" style={{ display: "none" }} aria-hidden="true" tabIndex={-1} />
        </form>
        {/* 「忘记密码？」 entry → flips to the 找回密码 sub-state (§24.5). Only in login
            mode (register has no password to recover). */}
        {!registering ? (
          <button type="button" className="d-auth__link" onClick={openForgot}>
            忘记密码？
          </button>
        ) : null}
      </React.Fragment>
    );
  }

  return (
    <Dialog open={open} title={title} onClose={onClose} footer={footer}>
      <div className="d-auth-body">{bodyContent}</div>
    </Dialog>
  );
}

// Map a thrown ApiError (or network error) to readable copy, distinguishing the
// register-vs-login meaning of each status (§17 owner-login.feature):
//   • 409 → 邮箱已注册 (register only)
//   • 401 → 账号或密码错 (login: unified, never reveals 邮箱不存在 vs 密码错, §17.3)
//   • 400 → 弱密码 / 非法邮箱 (register validation backstop)
//   • else → network / backend
function messageFor(e, registering) {
  if (e instanceof ApiError) {
    if (e.status === 409) return "该邮箱已注册，请直接登录。";
    if (e.status === 401) return "账号或密码错误，请重试。";
    if (e.status === 400) {
      return registering ? "邮箱格式不对或密码过弱（至少 8 位）。" : "请求有误，请检查邮箱与密码。";
    }
    return e.message || `${registering ? "注册" : "登录"}失败（${e.status}）。`;
  }
  return "无法连接到后端，请检查网络或后端地址（VITE_API_BASE）。";
}
