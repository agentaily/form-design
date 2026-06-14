// signin.jsx — 独立登录页 (SPEC §17). Wraps the DS SignInPage (split brand panel +
// centered card, signin/signup modes, client-side validation) and wires it to the
// REAL owner auth backend (core/auth login/register/requestPasswordReset → /api/auth/*,
// JWT persisted to localStorage) — NOT the DS AuthDialog.useAuth localStorage mock.
//
// Flow (replaces the old in-app LoginDialog modal): a signed-out owner who triggers a
// gated action (分享/发布/我的表单/集成设置) is sent here with ?return=<path>&reason=<copy>,
// the intent stashed in sessionStorage by the designer; on success we navigate back to
// `return`, the designer re-mounts signed-in and resumes the stashed intent.
//
// SignInPage (0.5.0) now exposes a backend-error seam — `error` shows a danger banner
// above the submit button (409 邮箱已注册 / 401 账号或密码错 / 400 弱密码) and `submitting`
// drives the async busy state (disabled + spinner + double-submit block). The component
// owns its CLIENT validation errors and clears them on input/mode change; this backend
// error is CALLER-owned, so we clear it ourselves (in onSubmit before the request, and on
// onModeChange / onEmailChange / onPasswordChange).
//
// One seam SignInPage still doesn't expose, handled locally:
//   • 找回密码 (§24.5) — SignInPage's onForgot is a bare callback, so we open a small DS
//     Dialog carrying the anti-enumeration neutral copy.
import React, { useState } from "react";
import { SignInPage, BrandMark, Alert, Dialog, Input, Button } from "@agentaily/design-system";
import { Icon } from "./chat.jsx";
import {
  login as authLogin,
  register as authRegister,
  requestPasswordReset as authRequestPasswordReset,
} from "./core/auth";
import { ApiError } from "./core/apiClient";
import { currentSearch } from "./core/router";
import { L } from "./core/i18n";

const MIN_PASSWORD_LENGTH = 8;

// The single neutral copy shown after any 找回密码 发起 — registered or not, success or
// backend hiccup — so the page never leaks whether the email exists (§24.5).
const RESET_NEUTRAL_COPY = L(
  "若该邮箱已注册，我们已发送重置链接，请查收邮件。",
  "If that email is registered, we've sent a reset link — check your inbox.",
);

// Localized copy for the DS SignInPage: per-mode strings under signin/signup, shared
// labels/placeholders/errors at the top level. `terms: null` hides the signup terms line.
const SIGNIN_COPY = {
  signin: {
    title: L("登录 Agentaily Forms", "Sign in to Agentaily Forms"),
    submit: L("登录", "Sign in"),
    switchText: L("还没有账户？", "No account yet?"),
    switchCta: L("注册一个", "Create one"),
  },
  signup: {
    title: L("创建 owner 账户", "Create your owner account"),
    subtitle: L(
      "用邮箱 + 密码注册即成为 owner（密码至少 8 位），注册即登录。",
      "Register with an email + password to become the owner (password ≥ 8 chars); you're signed in right away.",
    ),
    submit: L("注册并继续", "Register & continue"),
    switchText: L("已经有账户？", "Already have an account?"),
    switchCta: L("去登录", "Sign in"),
  },
  labels: {
    email: L("邮箱", "Email"),
    password: L("密码", "Password"),
    confirm: L("确认密码", "Confirm password"),
    forgot: L("忘记密码？", "Forgot password?"),
  },
  placeholders: {
    email: "owner@example.com",
    password: L("输入登录密码", "Enter your password"),
    passwordNew: L("设置一个至少 8 位的密码", "Set a password (≥ 8 chars)"),
    confirm: L("再次输入密码", "Re-enter your password"),
  },
  errors: {
    emailRequired: L("请输入邮箱", "Enter your email"),
    emailInvalid: L("请输入有效的邮箱地址", "Enter a valid email address"),
    passwordRequired: L("请输入密码", "Enter your password"),
    passwordShort: L(
      `密码至少 ${MIN_PASSWORD_LENGTH} 位`,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    ),
    confirmRequired: L("请再次输入密码", "Re-enter your password"),
    confirmMismatch: L("两次输入的密码不一致", "The two passwords don't match"),
  },
  terms: null,
};

// only allow a same-origin in-app path (a single leading "/"), never an absolute /
// protocol-relative / external URL (no "//", no scheme).
function sanitizeReturn(raw) {
  if (typeof raw === "string" && /^\/(?!\/)/.test(raw)) return raw;
  return "/";
}

export function SignInScreen({
  search = currentSearch(),
  // auth seams — default to the real core/auth fns; injectable so tests stay deterministic.
  login = authLogin,
  register = authRegister,
  requestPasswordReset = authRequestPasswordReset,
  // navigation seam: default is a full navigation so the designer re-mounts signed-in
  // and resumes the stashed intent. Injectable for tests (assert the target, no reload).
  navigate = (url) => {
    window.location.href = url;
  },
}) {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const reason = params.get("reason") || "";
  const returnTo = sanitizeReturn(params.get("return"));

  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // 找回密码 sub-dialog (§24.5): its own email field + the neutral "sent" flag.
  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetSent, setResetSent] = useState(false);

  // The gated `reason` (e.g. 登录后即可分享…) rides in as the signin subtitle.
  const copy = {
    ...SIGNIN_COPY,
    signin: {
      ...SIGNIN_COPY.signin,
      subtitle:
        reason ||
        L("登录以继续编辑与发布你的表单。", "Sign in to keep editing and publishing your forms."),
    },
  };

  // SignInPage validates client-side first, then calls this with the clean values.
  const submit = async ({ mode: m, email: em, password: pw }) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (m === "signup") await register(em, pw);
      else await login(em, pw);
      // core/auth persisted the JWT; navigate back — the designer re-mounts signed-in
      // and the stashed intent (sessionStorage) resumes there.
      navigate(returnTo);
    } catch (e) {
      setError(messageFor(e, m === "signup"));
      setBusy(false);
    }
  };

  const openForgot = () => {
    setResetEmail(email.trim());
    setResetSent(false);
    setForgotOpen(true);
  };

  // 发起找回密码: always lands on the SAME neutral copy regardless of outcome (§24.5).
  const submitReset = async () => {
    const em = resetEmail.trim();
    if (!em || busy) return;
    setBusy(true);
    try {
      await requestPasswordReset(em);
    } catch {
      // swallow — the neutral "sent" copy is shown regardless (never leak existence).
    } finally {
      setBusy(false);
      setResetSent(true);
    }
  };

  return (
    <React.Fragment>
      {/* SignInPage (0.5.0) renders the backend error itself in a danger banner above the
          submit button (`error`) and drives the async busy state (`submitting`). The
          backend error is caller-owned, so we clear it on submit + on every edit / mode flip. */}
      <SignInPage
        mode={mode}
        onModeChange={(next) => {
          setMode(next);
          setError("");
        }}
        brand={<BrandMark wordmark />}
        copy={copy}
        email={email}
        password={password}
        onEmailChange={(v) => {
          setEmail(v);
          setError("");
        }}
        onPasswordChange={(v) => {
          setPassword(v);
          setError("");
        }}
        onSubmit={submit}
        onForgot={openForgot}
        error={error}
        submitting={busy}
      />

      {/* 找回密码 (§24.5) — anti-enumeration neutral copy in every branch */}
      <Dialog
        open={forgotOpen}
        title={L("找回密码", "Reset your password")}
        onClose={() => setForgotOpen(false)}
        footer={
          resetSent ? (
            <Button
              variant="primary"
              icon={<Icon name="check" size={14} />}
              onClick={() => setForgotOpen(false)}
            >
              {L("好的", "Got it")}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Icon name="mail" size={14} />}
              disabled={!resetEmail.trim() || busy}
              onClick={submitReset}
            >
              {busy ? L("发送中…", "Sending…") : L("发送重置链接", "Send reset link")}
            </Button>
          )
        }
      >
        <div className="d-auth-body">
          {resetSent ? (
            <Alert
              variant="ok"
              title={L("已发送（若该邮箱已注册）", "Sent (if that email is registered)")}
            >
              {RESET_NEUTRAL_COPY}
            </Alert>
          ) : (
            <React.Fragment>
              <p className="d-auth__note">
                {L(
                  "输入你的注册邮箱，我们会发送一个重置链接。出于安全，无论邮箱是否注册，提示都相同。",
                  "Enter your registered email and we'll send a reset link. For your security, the message is the same whether or not the email is registered.",
                )}
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submitReset();
                }}
              >
                <Input
                  label={L("邮箱", "Email")}
                  type="email"
                  required
                  placeholder="owner@example.com"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  autoFocus
                />
                <button
                  type="submit"
                  style={{ display: "none" }}
                  aria-hidden="true"
                  tabIndex={-1}
                />
              </form>
            </React.Fragment>
          )}
        </div>
      </Dialog>
    </React.Fragment>
  );
}

// Map a thrown ApiError (or network error) to readable copy, distinguishing the
// register-vs-login meaning of each status (§17 owner-login.feature):
//   • 409 → 邮箱已注册 (register only)  • 401 → 账号或密码错 (login, unified §17.3)
//   • 400 → 弱密码 / 非法邮箱 (register backstop)  • else → network / backend
export function messageFor(e, registering) {
  if (e instanceof ApiError) {
    if (e.status === 409)
      return L("该邮箱已注册，请直接登录。", "That email is already registered — please sign in.");
    if (e.status === 401)
      return L("账号或密码错误，请重试。", "Wrong email or password. Please try again.");
    if (e.status === 400) {
      return registering
        ? L(
            "邮箱格式不对或密码过弱（至少 8 位）。",
            "Invalid email or weak password (at least 8 characters).",
          )
        : L("请求有误，请检查邮箱与密码。", "Bad request — check your email and password.");
    }
    return (
      e.message ||
      L(
        `${registering ? "注册" : "登录"}失败（${e.status}）。`,
        `${registering ? "Sign-up" : "Sign-in"} failed (${e.status}).`,
      )
    );
  }
  return L(
    "无法连接到后端，请检查网络或后端地址（VITE_API_BASE）。",
    "Couldn't reach the backend — check your network or the API base (VITE_API_BASE).",
  );
}
