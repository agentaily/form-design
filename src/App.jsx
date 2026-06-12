// App.jsx — App shell: header, split layout, live agent loop (streamed prose +
// tool-call cards over POST /api/chat), schema view, and the real publish surface
// (发布 / 分享 → PublishFeedback → POST /api/forms → public /f/:slug link).
// All chrome composed from @agentaily/design-system.
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Badge,
  IconButton,
  Button,
  Tabs,
  SchemaDisplay,
  Queue,
  Suggestions,
  Alert,
} from "@agentaily/design-system";

import { Icon, ChatThread, ChatComposer } from "./chat.jsx";
import { FormPreview } from "./preview.jsx";
import { MarkupLayer } from "./markup.jsx";
import { LoginDialog } from "./auth.jsx";
import { SettingsDialog } from "./settings.jsx";
import { FormsPanel, PublishFeedback } from "./forms-panel.jsx";
import { PublicFormPage } from "./public-form.jsx";
import { ResetPasswordPage } from "./reset-password.jsx";
import { VerifyEmailPage } from "./verify-email.jsx";
import {
  matchPublicForm,
  matchResetPassword,
  matchVerifyEmail,
  currentPathname,
  currentSearch,
} from "./core/router";
import { MessageQueue } from "./core/queue";
import { createFormModel, applyDesignerTool, uid, DESIGNER_SYSTEM } from "./core/designerTools";
import { runDesignerTurn } from "./core/designerLoop";
import { streamDesignerChat } from "./core/designerChat";
import { ApiError } from "./core/apiClient";
import {
  isLoggedIn as authIsLoggedIn,
  requestEmailVerification as authRequestEmailVerification,
  getCurrentUser as authGetCurrentUser,
} from "./core/auth";

// Fixed follow-up prompt chips shown once a form exists (a product affordance,
// not model output) — keeps "继续改" discoverable. Each routes through the agent.
const FOLLOWUPS = ["加一个备注字段", "把手机号设为必填", "换个封面文案"];

// reactive media query — drives the single-column mobile layout.
// Defensive: in non-browser/test environments without matchMedia, default to
// desktop (false) and skip the listener so render never throws.
function useMediaQuery(q) {
  const supported = typeof window !== "undefined" && typeof window.matchMedia === "function";
  const [match, setMatch] = useState(() => (supported ? window.matchMedia(q).matches : false));
  useEffect(() => {
    if (!supported) return;
    const mq = window.matchMedia(q);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q, supported]);
  return match;
}

// UI state for the designer. In the design prototype these were exposed through a
// Tweaks panel; here they're plain app state — theme + split are user-driven, the
// rest are fixed product defaults.
const UI_DEFAULTS = {
  theme: "dark",
  split: 46,
  density: "compact",
  formStyle: "minimal",
};

function useUiState(defaults) {
  const [state, setState] = useState(defaults);
  const set = useCallback((key, value) => setState((s) => ({ ...s, [key]: value })), []);
  return [state, set];
}

// build a SchemaDisplay-shaped object from the live fields
function schemaFor(meta, fields) {
  const typeMap = {
    text: "string",
    tel: "string",
    email: "string",
    textarea: "string",
    radio: "enum",
    checks: "array",
    select: "enum",
    consent: "boolean",
  };
  const out = {};
  if (meta) out.title = { type: "string", required: true, description: meta.title };
  fields.forEach((f) => {
    const key = f.label
      .replace(/\s*\/\s*|\s+/g, "_")
      .replace(/[?？]/g, "")
      .toLowerCase();
    out[key] = {
      type: typeMap[f.type] || "string",
      required: !!f.required,
      description: f.options ? f.options.join(" · ") : f.placeholder || undefined,
    };
  });
  return out;
}

// ── 路由分流挂载点 (第 6 步, SPEC §16.4.1 / §23.6 / §24.5) ─────────────────────
// The app's ONE route split (no react-router — see src/core/router.ts). App reads the
// current pathname + search (injectable for tests) and mounts ONE bare page when a
// public/auth-landing route matches, else the full designer:
//   • /f/:slug             → <PublicFormPage>   — the bare answerer view (公开填写).
//   • /reset-password?token= → <ResetPasswordPage> — set a new password (§24.5).
//   • /verify-email?status=  → <VerifyEmailPage>    — show the verify result (§23.6).
//   • anything else        → the full designer (<DesignerApp>) below.
// Each landing page is chrome-less: NO chat / preview / login / settings / publish, and
// NO owner token held on the page itself (reset/verify I/O is public, NO Bearer). This
// wrapper decides with no hooks before the branch, so routes never share hook order.
// Tests drive the split by passing explicit `pathname` / `search` (and may inject the
// per-route seams: getPublicForm/submitForm, confirmReset, onBackToLogin/onBackToApp).
export default function App({
  pathname = currentPathname(),
  search = currentSearch(),
  // PublicFormPage I/O seams, injected straight through on the public route so
  // App-level tests can drive the public-page fetch/submit deterministically.
  getPublicForm,
  submitForm,
  // ResetPasswordPage seam (§24.5): the confirm client, injectable for tests.
  confirmReset,
  // Landing-page navigation seams (§23.6 / §24.5): route 回登录 / 回设计器, injectable
  // so tests assert the affordance without a real navigation.
  onBackToLogin,
  onBackToApp,
  ...rest
} = {}) {
  const publicRoute = matchPublicForm(pathname);
  if (publicRoute) {
    return (
      <PublicFormPage
        slug={publicRoute.slug}
        getPublicForm={getPublicForm}
        submitForm={submitForm}
      />
    );
  }
  const resetRoute = matchResetPassword(pathname, search);
  if (resetRoute) {
    return (
      <ResetPasswordPage
        token={resetRoute.token}
        confirmReset={confirmReset}
        onBackToLogin={onBackToLogin}
      />
    );
  }
  const verifyRoute = matchVerifyEmail(pathname, search);
  if (verifyRoute) {
    return <VerifyEmailPage status={verifyRoute.status} onBackToApp={onBackToApp} />;
  }
  return <DesignerApp {...rest} />;
}

function DesignerApp({
  chat = streamDesignerChat,
  login,
  register,
  logout,
  // 找回密码 发起 (§24.5) — injected through to LoginDialog's forgot sub-state so
  // App-level tests can drive it deterministically (defaults to core/auth inside the dialog).
  requestPasswordReset,
  // Integration-settings client (SPEC §12/§14). Defaults to the real configClient
  // functions inside SettingsDialog; injectable here so App-level tests can drive
  // the 401 → close-settings + open-login wiring deterministically (same seam as
  // chat/login/logout). Left undefined → SettingsDialog uses its own defaults.
  getConfig,
  saveConfig,
  testConnections,
  // Forms publish + management client (SPEC §16/§21). Defaults to the real formsClient
  // functions inside FormsPanel/PublishFeedback; injectable here so App-level tests can
  // drive the publish flow + the 401 → close-panel + open-login wiring deterministically
  // (same seam as getConfig/saveConfig). Left undefined → the children use their defaults.
  publishForm,
  listForms,
  updateForm,
  deleteForm,
  publicFormUrl,
  // 数据后台「看提交」(§18). Defaults to the real submissionsClient inside SubmissionsView
  // (mounted per-row by FormsPanel); injectable here for App-level tests, same seam.
  listSubmissions,
  // 邮箱未验证 banner 的「重新发送」(§23.3 owner-only). Defaults to the real
  // core/auth.requestEmailVerification (POST with Bearer); injectable for tests.
  requestEmailVerification = authRequestEmailVerification,
  // Authoritative 邮箱验证状态 read (§23.6 owner-only): GET /api/auth/me →
  // { email, emailVerified }, fail-soft to null. Defaults to the real
  // core/auth.getCurrentUser; injectable so banner tests are deterministic.
  getCurrentUser = authGetCurrentUser,
} = {}) {
  const [t, setTweak] = useUiState(UI_DEFAULTS);
  const [messages, setMessages] = useState([]);
  const [meta, setMeta] = useState(null);
  const [fields, setFields] = useState([]);
  const [values, setValuesState] = useState({});
  const [draft, setDraft] = useState("");
  const [building, setBuilding] = useState(false);
  const [tab, setTab] = useState("preview");
  const [device, setDevice] = useState("full");
  const [markupOn, setMarkupOn] = useState(false);
  // Header LIVE/DRAFT badge: flips to LIVE only when a publish actually succeeds
  // (PublishFeedback fires onPublished → setPublished(true)).
  const [published, setPublished] = useState(false);
  // Publish feedback (SPEC §16): opened by the 发布 / 分享 button; it publishes the live
  // model and shows the public fill link. 「我的表单」 management panel (SPEC §21).
  const [publishOpen, setPublishOpen] = useState(false);
  const [formsOpen, setFormsOpen] = useState(false);
  // owner session (SPEC §17): logged-in unlocks the owner-only /api/chat proxy.
  const [loggedIn, setLoggedIn] = useState(() => authIsLoggedIn());
  const [loginOpen, setLoginOpen] = useState(false);
  // 邮箱验证状态 (§23.6). The AUTHORITATIVE bit comes from GET /api/auth/me
  // (getCurrentUser below) — fetched on mount (when logged in) and after each login —
  // so the banner is correct across reloads AND on a plain 登录, not just a fresh 注册.
  // We default to `true` (no banner) and treat「刚注册」as an OPTIMISTIC initial flip to
  // 未验证 (register always yields email_verified=0) purely to avoid a first-frame
  // flicker before `me` resolves; once `me` returns it is authoritative. A failed/null
  // `me` leaves whatever optimistic value we have (banner stays a soft nudge, never a
  // hard error). Logout resets it to true (no owner to verify).
  const [emailVerified, setEmailVerified] = useState(true);
  // 重新发送 反馈: "" | "sending" | "sent" — the banner shows a neutral「已重新发送」
  // after a resend, never leaking the backend's already-verified/send状态 (§23.3).
  const [resendState, setResendState] = useState("");
  // integration settings (SPEC §12 + §14): owner connects DeepSeek + 飞书 here.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // single-column mobile layout (≤720px): one pane at a time via the sub-bar.
  const isMobile = useMediaQuery("(max-width: 720px)");
  const [mobileView, setMobileView] = useState("chat");
  // continuous-send buffer (SPEC §4.1): pending messages shown above the composer.
  const [queueItems, setQueueItems] = useState([]);
  const draggingRef = useRef(false);
  // Canonical form model the agent tools mutate; React `meta`/`fields` mirror it
  // for rendering (synced after each tool batch via syncModel).
  const modelRef = useRef(null);
  if (!modelRef.current) modelRef.current = createFormModel();
  // LLM message history for the whole session (OpenAI shape), seeded with the
  // designer system prompt; user/assistant/tool turns accumulate across sends.
  const historyRef = useRef(null);
  if (!historyRef.current) historyRef.current = [{ role: "system", content: DESIGNER_SYSTEM }];

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", t.theme === "light" ? "light" : "dark");
  }, [t.theme]);

  const setValue = useCallback((id, v) => setValuesState((s) => ({ ...s, [id]: v })), []);
  const pushMsg = (m) => {
    const id = uid("msg");
    setMessages((ms) => [...ms, { id, ...m }]);
    return id;
  };
  const patchMsg = (id, patch) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  const removeMsg = (id) => setMessages((ms) => ms.filter((m) => m.id !== id));
  // Clear the entrance-animation flag ~600ms after a field appears — on the model
  // (source of truth) AND the rendered mirror, so a later sync won't re-trigger it.
  const clearNew = (fid) =>
    setTimeout(() => {
      const f = modelRef.current.fields.find((x) => x.id === fid);
      if (f) f._new = false;
      setFields(modelRef.current.fields.map((x) => ({ ...x })));
    }, 600);

  // Push the canonical model into React state for rendering; schedule the
  // entrance animation to clear for any freshly-added/updated fields.
  const syncModel = () => {
    const m = modelRef.current;
    setMeta(m.meta ? { ...m.meta } : null);
    setFields(m.fields.map((f) => ({ ...f })));
    m.fields.forEach((f) => {
      if (f._new) clearNew(f.id);
    });
  };

  // Turn a backend/network failure into a human message for the thread.
  const errorMessage = (e) => {
    if (e instanceof ApiError) {
      if (e.status === 401) return "请先登录 owner 后再使用对话设计。";
      return e.message || `对话服务出错（${e.status}）。`;
    }
    return "无法连接到对话服务，请检查网络或后端地址（VITE_API_BASE）。";
  };

  // Pull the AUTHORITATIVE 验证状态 from GET /api/auth/me (§23.6). getCurrentUser is
  // fail-soft (resolves null on 401 / network), so on a null we leave `emailVerified`
  // as-is (keep the optimistic value, never crash). On a real snapshot we adopt its
  // bit — this is what makes the banner correct after a reload and on a plain 登录.
  const refreshMe = useCallback(async () => {
    const me = await getCurrentUser();
    if (me) setEmailVerified(me.emailVerified);
  }, [getCurrentUser]);

  // On mount (and whenever we transition into a logged-in session), read me once so
  // the banner reflects the real verified bit — independent of how we got here
  // (reload, 登录, or 注册). Logged-out sessions have nothing to verify, so we skip.
  useEffect(() => {
    if (loggedIn) refreshMe();
  }, [loggedIn, refreshMe]);

  // 重新发送验证邮件 (§23.3, owner-only). The request always succeeds when
  // authenticated (already-verified → no-op; unverified → sends), so on resolve we
  // show ONE neutral「已重新发送」regardless. A 401 means the session lapsed — route
  // into login (same handler as the chat/settings 401 flow) so the fix is one step away.
  const resendVerification = async () => {
    if (resendState === "sending") return;
    setResendState("sending");
    try {
      await requestEmailVerification();
      setResendState("sent");
      // Re-read me: the owner may have verified out-of-band (e.g. clicked the email
      // link in another tab); adopt the authoritative bit so the banner self-clears.
      refreshMe();
    } catch (e) {
      setResendState("");
      if (e instanceof ApiError && e.status === 401) {
        setLoggedIn(false);
        setLoginOpen(true);
      }
    }
  };

  // One streamed LLM call → one assistant bubble. Text streams in live; a turn
  // that only calls tools (no prose) drops its empty bubble. On failure (401 未登录,
  // 409 未配置, 502 上游, network) the placeholder bubble is removed before the error
  // rethrows — otherwise an empty typing bubble would be orphaned next to the Alert.
  const callChat = async ({ messages: history }) => {
    let acc = "";
    const mid = pushMsg({ role: "assistant", kind: "text", text: "", streaming: true });
    let res;
    try {
      res = await chat({
        messages: history,
        onText: (d) => {
          acc += d;
          patchMsg(mid, { text: acc });
        },
      });
    } catch (e) {
      // drop the placeholder (and any partial stream) so only the error Alert shows
      removeMsg(mid);
      throw e;
    }
    const finalText = res.text || acc;
    if (finalText) patchMsg(mid, { text: finalText, streaming: false });
    else removeMsg(mid);
    return res;
  };

  // Run one agent turn over a merged batch of user prompts (§4 ReAct loop):
  // stream prose, execute form tools (rendered as tool-call cards), rerender preview.
  // `merged` is the queue's batch-merged text (numbered + <context>-wrapped for
  // mid-work input per §4.1) — sent verbatim as the user turn so the model never
  // misreads buffered messages as a reply to its last output.
  const runTurn = async (merged) => {
    historyRef.current.push({ role: "user", content: merged });
    const midById = new Map();
    try {
      await runDesignerTurn({
        messages: historyRef.current,
        callChat,
        executeTool: (name, input) => applyDesignerTool(modelRef.current, name, input),
        onToolStart: (ev) => {
          midById.set(
            ev.id,
            pushMsg({
              role: "assistant",
              kind: "tool",
              name: ev.name,
              args: ev.input,
              status: "running",
            }),
          );
        },
        onToolEnd: (ev, result) => {
          const mid = midById.get(ev.id);
          if (mid) patchMsg(mid, { status: ev.error ? "error" : "done", result });
        },
        onPreview: syncModel,
      });
    } catch (e) {
      pushMsg({ role: "assistant", kind: "error", text: errorMessage(e) });
      // 401 means no/expired owner session — pop the login dialog so the fix is
      // one step away (§17). After logging in, the author re-sends the message.
      if (e instanceof ApiError && e.status === 401) {
        setLoggedIn(false);
        setLoginOpen(true);
      }
    }
    syncModel();
  };

  // One message queue for the whole session: connect-send N times → exactly one
  // consumer loop; whatever accumulated flushes together as a single agent turn.
  // The consumer receives `merged` (queue.mergeBatch of this flush's batch) — the
  // exact text sent to the model, numbered + <context>-wrapped for mid-work input.
  // `bufferRef` mirrors the same atomic flush so the visible thread shows each raw
  // message as its own bubble (and stays in sync when a queued item is cancelled).
  const queueRef = useRef(null);
  const bufferRef = useRef([]);
  if (!queueRef.current) {
    const q = new MessageQueue(async (merged) => {
      const texts = bufferRef.current;
      bufferRef.current = [];
      texts.forEach((tx) => pushMsg({ role: "user", text: tx }));
      setBuilding(true);
      try {
        await runTurn(merged);
      } finally {
        setBuilding(false);
      }
    });
    q.onChange = (items) => setQueueItems(items.filter((m) => m.status === "pending"));
    queueRef.current = q;
  }

  const onSend = (override) => {
    const text = (override != null ? override : draft).trim();
    if (!text) return;
    if (override == null) setDraft("");
    bufferRef.current = [...bufferRef.current, text];
    queueRef.current.enqueue(text);
  };

  const removeQueued = (i) => {
    const item = queueItems[i];
    if (!item) return;
    if (queueRef.current.cancel(item.id)) {
      // keep the flush buffer in sync so the cancelled text is never sent
      const j = bufferRef.current.indexOf(item.text);
      if (j >= 0) bufferRef.current = bufferRef.current.filter((_, idx) => idx !== j);
    }
  };

  useEffect(() => {
    const move = (e) => {
      if (!draggingRef.current) return;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      setTweak("split", Math.round(Math.max(32, Math.min(64, (x / window.innerWidth) * 100))));
    };
    const up = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", move);
    window.addEventListener("touchend", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
    };
  }, [setTweak]);

  const empty = messages.length === 0;
  const fieldCount = fields.length;

  return (
    <div className="d-app">
      <header className="d-top">
        <div className="d-top__brand">
          <span className="d-top__mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 32 32" fill="none">
              <path d="M2 10 V2 H10" stroke="currentColor" strokeWidth="2" />
              <path d="M22 30 H30 V22" stroke="currentColor" strokeWidth="2" />
              <rect x="12" y="9" width="8" height="14" fill="currentColor" />
            </svg>
          </span>
          <span className="d-top__word">agentaily</span>
          <span className="d-top__div">/</span>
          <span className="d-top__crumb">forms</span>
        </div>
        <div className="d-top__title">
          <span className="d-top__name">活动报名 · 未命名表单</span>
          <Badge variant={published ? "ok" : "neutral"} dot>
            {published ? "LIVE" : "DRAFT"}
          </Badge>
        </div>
        <div className="d-top__actions">
          <IconButton
            label={loggedIn ? "账户已登录" : "登录账户"}
            variant={loggedIn ? "solid" : "ghost"}
            onClick={() => setLoginOpen(true)}
          >
            <Icon name={loggedIn ? "user" : "lock"} size={15} />
          </IconButton>
          <IconButton label="我的表单" onClick={() => setFormsOpen(true)}>
            <Icon name="list" size={15} />
          </IconButton>
          <IconButton label="集成设置" onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" size={15} />
          </IconButton>
          <IconButton
            label="切换主题"
            onClick={() => setTweak("theme", t.theme === "dark" ? "light" : "dark")}
          >
            <Icon name={t.theme === "dark" ? "sun" : "moon"} size={15} />
          </IconButton>
          {isMobile ? (
            <IconButton label="分享" onClick={() => setPublishOpen(true)}>
              <Icon name="share" size={15} />
            </IconButton>
          ) : (
            <Button
              variant="secondary"
              icon={<Icon name="share" size={14} />}
              onClick={() => setPublishOpen(true)}
            >
              分享
            </Button>
          )}
          <Button
            variant="primary"
            icon={<Icon name="spark" size={14} />}
            disabled={building || fieldCount === 0}
            // Open the real publish-feedback surface (§16): it publishes the live model
            // via publishForm, shows the public fill link, and fires onPublished — which
            // is what flips the header badge to LIVE. The header stays DRAFT until that
            // publish actually succeeds (no optimistic flip on click).
            onClick={() => setPublishOpen(true)}
          >
            发布
          </Button>
        </div>
      </header>

      {/* 邮箱未验证 banner (§23.6). Soft — it gates NOTHING (§23.1); it only nudges the
          owner to verify. Shown when logged in AND the AUTHORITATIVE verified bit from
          GET /api/auth/me (emailVerified, fetched on mount/login above) is false — so it
          is correct across reloads and on a plain 登录, not just a fresh 注册. The
          「重新发送」action calls the owner-only resend; after it resolves we show ONE
          neutral「已重新发送」(§23.3) and re-read me so an out-of-band verify self-clears. */}
      {loggedIn && !emailVerified ? (
        <div className="d-verify-banner" data-testid="verify-banner">
          <Alert variant="warn" title="邮箱未验证" icon={<Icon name="mail" size={16} />}>
            <div className="d-verify-banner__row">
              <span>验证你的邮箱可锁定它归你所有；在此之前所有功能照常可用。</span>
              {resendState === "sent" ? (
                <span className="ax-label d-verify-banner__sent">已重新发送</span>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={resendState === "sending"}
                  onClick={resendVerification}
                >
                  {resendState === "sending" ? "发送中…" : "重新发送"}
                </Button>
              )}
            </div>
          </Alert>
        </div>
      ) : null}

      {isMobile ? (
        <div className="d-mbar">
          <button
            className={"d-mseg" + (mobileView === "chat" ? " is-on" : "")}
            onClick={() => setMobileView("chat")}
          >
            <Icon name="message" size={15} /> 对话
          </button>
          <button
            className={"d-mseg" + (mobileView === "preview" ? " is-on" : "")}
            onClick={() => setMobileView("preview")}
          >
            <Icon name="eye" size={15} /> 预览
            {fieldCount ? <span className="d-mseg__count">{fieldCount}</span> : null}
          </button>
        </div>
      ) : null}

      <div className="d-split" data-mview={mobileView}>
        <section className="d-pane d-pane--chat" style={{ width: t.split + "%" }}>
          <ChatThread
            messages={messages}
            empty={empty}
            onStarter={(c) => onSend(c)}
            density={t.density}
          />
          <div className="d-foot">
            {!building && fieldCount > 0 ? (
              <div className="d-foot__suggest">
                <Suggestions items={FOLLOWUPS} onSelect={(v) => onSend(v)} scroll />
              </div>
            ) : null}
            {queueItems.length > 0 ? (
              <div className="d-foot__queue">
                <Queue
                  title="缓冲区·下一轮一起发"
                  items={queueItems.map((q) => ({ text: q.text }))}
                  onRemove={removeQueued}
                />
              </div>
            ) : null}
            <ChatComposer
              value={draft}
              onChange={setDraft}
              onSend={() => onSend()}
              placeholder={
                empty
                  ? "描述你想要的表单，例如：做一个活动报名表…"
                  : building
                    ? "可继续输入，会收进缓冲区一起处理…"
                    : "继续描述要怎么改…"
              }
            />
            <p className="d-foot__note">AGENTAILY 会出错 · 发布前请核对字段</p>
          </div>
        </section>

        <div
          className="d-divider"
          onMouseDown={() => {
            draggingRef.current = true;
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
          onTouchStart={() => {
            draggingRef.current = true;
          }}
        >
          <span className="d-divider__grip" />
        </div>

        <section className="d-pane d-pane--preview" style={{ width: 100 - t.split + "%" }}>
          <div className="d-pvhead">
            <div className="d-pvhead__tabs">
              <Tabs
                items={[
                  { id: "preview", label: "预览" },
                  { id: "schema", label: "Schema", count: fieldCount },
                ]}
                active={tab}
                onChange={setTab}
              />
            </div>
            <span style={{ flex: 1 }} />
            {tab === "preview" ? (
              <div className="d-seg">
                <IconButton
                  label="指向修改"
                  size="sm"
                  variant={markupOn ? "solid" : "outline"}
                  disabled={building || fieldCount === 0}
                  onClick={() => setMarkupOn((on) => !on)}
                >
                  <Icon name="markup" size={13} />
                </IconButton>
                {!isMobile ? (
                  <React.Fragment>
                    <span className="d-seg__sep" />
                    <IconButton
                      label="桌面宽度"
                      size="sm"
                      variant={device === "full" ? "solid" : "outline"}
                      onClick={() => setDevice("full")}
                    >
                      <Icon name="layout" size={13} />
                    </IconButton>
                    <IconButton
                      label="手机宽度"
                      size="sm"
                      variant={device === "phone" ? "solid" : "outline"}
                      onClick={() => setDevice("phone")}
                    >
                      <Icon name="phone" size={13} />
                    </IconButton>
                  </React.Fragment>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className={"d-pvbody ax-dotgrid" + (markupOn ? " is-markup" : "")}>
            {tab === "preview" ? (
              <div className={"d-pvscroll" + (device === "phone" ? " is-phone" : "")}>
                <FormPreview
                  meta={meta}
                  fields={fields}
                  values={values}
                  setValue={setValue}
                  style={t.formStyle}
                  building={building}
                />
              </div>
            ) : (
              <div className="d-schema">
                <SchemaDisplay schema={schemaFor(meta, fields)} />
              </div>
            )}
          </div>

          {tab === "preview" && markupOn ? (
            <MarkupLayer
              onClose={() => setMarkupOn(false)}
              onSend={(txt) => {
                setMarkupOn(false);
                onSend(txt);
              }}
            />
          ) : null}
        </section>
      </div>

      <LoginDialog
        open={loginOpen}
        loggedIn={loggedIn}
        login={login}
        register={register}
        logout={logout}
        requestPasswordReset={requestPasswordReset}
        onClose={() => setLoginOpen(false)}
        // setLoggedIn(true) flips loggedIn false→true, which triggers the mount/login
        // effect to fetch GET /api/auth/me and adopt the AUTHORITATIVE verified bit
        // (§23.6) — so a plain 登录 is now as accurate as a 注册. For 注册 we ALSO flip
        // emailVerified→false optimistically (register always yields email_verified=0)
        // to avoid a first-frame flicker before `me` resolves; `me` then confirms it.
        onLoggedIn={(info) => {
          if (info?.registered) {
            setEmailVerified(false);
            setResendState("");
          }
          setLoggedIn(true);
          // Always re-read me on login: covers a re-login while already logged in
          // (where setLoggedIn(true) is a no-op and wouldn't retrigger the effect).
          refreshMe();
        }}
        onLoggedOut={() => {
          setLoggedIn(false);
          // logging out drops the session — hide the banner (no owner to verify).
          setEmailVerified(true);
          setResendState("");
        }}
      />

      {/* Integration settings (§12/§14). A 401 from any config call means the owner
          session is missing/expired — close settings and pop login (mirrors the
          /api/chat 401 flow above) so the fix is one step away. */}
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onNeedLogin={() => {
          setSettingsOpen(false);
          setLoggedIn(false);
          setLoginOpen(true);
        }}
        getConfig={getConfig}
        saveConfig={saveConfig}
        testConnections={testConnections}
      />

      {/* 「我的表单」 management panel (§21). Mounted unconditionally (inert when closed,
          like SettingsDialog) so it fires no listForms until opened. A 401 from any forms
          call means the owner session is missing/expired — close the panel and pop login
          (same handler shape as SettingsDialog). */}
      <FormsPanel
        open={formsOpen}
        onClose={() => setFormsOpen(false)}
        onNeedLogin={() => {
          setFormsOpen(false);
          setLoggedIn(false);
          setLoginOpen(true);
        }}
        listForms={listForms}
        updateForm={updateForm}
        deleteForm={deleteForm}
        publicFormUrl={publicFormUrl}
        listSubmissions={listSubmissions}
      />

      {/* Publish feedback (§16): opened by the 发布 button, it publishes the live model
          and shows the public fill link. onPublished flips the header status to LIVE; a
          401 routes into login (same handler as above). */}
      <PublishFeedback
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        onNeedLogin={() => {
          setPublishOpen(false);
          setLoggedIn(false);
          setLoginOpen(true);
        }}
        meta={meta}
        fields={fields}
        publishForm={publishForm}
        publicFormUrl={publicFormUrl}
        onPublished={() => setPublished(true)}
      />
    </div>
  );
}
