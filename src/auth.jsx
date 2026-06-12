// auth.jsx — owner login/register/account dialog (SPEC §17, multi-user frontend).
// One DS Dialog that flips on `loggedIn`:
//   • logged-out → a 「登录 / 注册」 dual-mode form (DS Tabs switches mode), each
//     mode posting email + password to /api/auth/login or /api/auth/register.
//   • logged-in  → an "已登录" panel with a logout action.
// `login`/`register`/`logout` default to the real core/auth functions but are
// injectable so tests stay deterministic. Error copy distinguishes 409 (邮箱已
// 注册) / 401 (账号或密码错) / weak-password 400 / network (§17 owner-login.feature).
import React, { useState, useEffect } from "react";
import { Dialog, Tabs, Input, Button, Alert } from "@agentaily/design-system";
import { Icon } from "./chat.jsx";
import { login as authLogin, register as authRegister, logout as authLogout } from "./core/auth";
import { ApiError } from "./core/apiClient";

const MIN_PASSWORD_LENGTH = 8;

export function LoginDialog({
  open,
  loggedIn,
  onClose,
  onLoggedIn,
  onLoggedOut,
  login = authLogin,
  register = authRegister,
  logout = authLogout,
}) {
  // 'login' | 'register' — the dual mode toggled by the DS Tabs.
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Each (re)open starts from a clean form — no stale email/password/error/mode.
  useEffect(() => {
    if (open) {
      setMode("login");
      setEmail("");
      setPassword("");
      setError("");
      setBusy(false);
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
      onLoggedIn?.();
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

  const canSubmit = !!email.trim() && !!password && !busy;

  return (
    <Dialog
      open={open}
      title={loggedIn ? "OWNER 账户" : "OWNER 登录 / 注册"}
      onClose={onClose}
      footer={
        loggedIn ? (
          <Button variant="secondary" icon={<Icon name="lock" size={14} />} onClick={doLogout}>
            登出
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Icon name="check" size={14} />}
            disabled={!canSubmit}
            onClick={submit}
          >
            {busy ? (registering ? "注册中…" : "登录中…") : registering ? "注册" : "登录"}
          </Button>
        )
      }
    >
      {loggedIn ? (
        <div className="d-auth-body">
          <Alert variant="ok" title="已登录">
            你已作为 owner 登录，可以使用对话设计、集成设置与表单管理。
          </Alert>
        </div>
      ) : (
        <div className="d-auth-body">
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
        </div>
      )}
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
