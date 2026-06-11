// auth.jsx — owner login/account dialog (SPEC §17, frontend). One DS Dialog that
// flips on `loggedIn`: logged-out → a password form that POSTs to /api/auth/login;
// logged-in → an "已登录" panel with a logout action. `login`/`logout` default to
// the real core/auth functions but are injectable so tests stay deterministic.
import React, { useState, useEffect } from "react";
import { Dialog, Input, Button, Alert } from "@agentaily/design-system";
import { Icon } from "./chat.jsx";
import { login as authLogin, logout as authLogout } from "./core/auth";
import { ApiError } from "./core/apiClient";

export function LoginDialog({
  open,
  loggedIn,
  onClose,
  onLoggedIn,
  onLoggedOut,
  login = authLogin,
  logout = authLogout,
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Each (re)open starts from a clean form — no stale password or error lingering.
  useEffect(() => {
    if (open) {
      setPassword("");
      setError("");
      setBusy(false);
    }
  }, [open]);

  const submit = async () => {
    const pw = password.trim();
    if (!pw || busy) return;
    setBusy(true);
    setError("");
    try {
      await login(pw);
      setPassword("");
      onLoggedIn?.();
    } catch (e) {
      // Unified 401 (§17.7) → wrong password; anything else → network/backend.
      setError(
        e instanceof ApiError && e.status === 401
          ? "密码错误，请重试。"
          : "登录失败，请检查网络或后端地址（VITE_API_BASE）。",
      );
    } finally {
      setBusy(false);
    }
  };

  const doLogout = () => {
    logout();
    onLoggedOut?.();
  };

  return (
    <Dialog
      open={open}
      title={loggedIn ? "OWNER 账户" : "OWNER 登录"}
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
            disabled={busy || !password.trim()}
            onClick={submit}
          >
            {busy ? "登录中…" : "登录"}
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
          <p className="d-auth__note">
            输入 owner 密码登录。登录后对话设计（/api/chat）与管理功能才会解锁。
          </p>
          {/* Enter-to-submit: a real <form> wraps the field; the hidden submit
              button lets ⏎ fire submit() without a visible second action. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Input
              label="OWNER 密码"
              type="password"
              required
              placeholder="输入 owner 登录密码"
              value={password}
              error={error || undefined}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            <button type="submit" style={{ display: "none" }} aria-hidden="true" tabIndex={-1} />
          </form>
        </div>
      )}
    </Dialog>
  );
}
