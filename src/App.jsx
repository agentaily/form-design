// App.jsx — App shell. Since the design system shipped its full page/chat surfaces
// (0.4.0), the two-pane frame is the DS DesignerShell, the chat column is the DS
// ConversationThread (pure render + external controller), the account control is the
// DS AccountControl, and 指向修改 is the DS MarkupLayer — the hand-written shell /
// thread / composer / markup are gone. The real engineering stays: the live agent loop
// (streamed prose + tool-call cards over POST /api/chat), the §4.1 continuous-send
// MessageQueue (wrapped as the ConversationThread controller), the publish surface
// (发布/分享 → PublishFeedback → POST /api/forms), integration settings, forms mgmt,
// the owner session + 邮箱未验证 banner, and the route split. Login is now a standalone
// /signin page (DS SignInPage) instead of an in-app modal.
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Badge,
  IconButton,
  Button,
  Tabs,
  SchemaDisplay,
  Alert,
  AlertDialog,
  HoverCard,
  DesignerShell,
  ConversationThread,
  AccountControl,
  MarkupLayer,
  BrandMark,
} from "@agentaily/design-system";

import { L } from "./core/i18n";
import { Icon, renderChatTurn } from "./chat.jsx";
import { FormPreview } from "./preview.jsx";
import { SettingsOverlay } from "./settings.jsx";
import { FormsPanel, PublishFeedback } from "./forms-panel.jsx";
import { PublicFormPage } from "./public-form.jsx";
import { ResetPasswordPage } from "./reset-password.jsx";
import { VerifyEmailPage } from "./verify-email.jsx";
import { SignInScreen } from "./signin.jsx";
import {
  matchPublicForm,
  matchResetPassword,
  matchVerifyEmail,
  matchSignIn,
  currentPathname,
  currentSearch,
  SIGNIN_PATH,
  SETTINGS_PATH,
} from "./core/router";
import { MessageQueue } from "./core/queue";
import {
  createFormModel,
  applyDesignerTool,
  reserveUidsFrom,
  uid,
  DESIGNER_SYSTEM,
} from "./core/designerTools";
import {
  updateFormDefinition as defaultUpdateFormDefinition,
  getFormForEdit as defaultGetFormForEdit,
} from "./core/formsClient";
import { runDesignerTurn } from "./core/designerLoop";
import { streamDesignerChat } from "./core/designerChat";
import { ApiError } from "./core/apiClient";
import {
  getOrCreateDesignSessionId,
  setActiveDesignSessionId,
  newDesignSessionId,
  loadChatSession as loadChatSessionClient,
  saveChatTurns as saveChatTurnsClient,
  listChatSessions as listChatSessionsClient,
  deleteChatSession as deleteChatSessionClient,
  toPersistedTurns,
} from "./core/chatSessionClient";
import {
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  CHAT_MODEL_STORAGE_KEY,
  isValidChatModel,
  chatModelPill,
} from "./core/chatModels";
import { SessionMenu } from "./SessionMenu.jsx";
import {
  isLoggedIn as authIsLoggedIn,
  logout as authLogout,
  requestEmailVerification as authRequestEmailVerification,
  getCurrentUser as authGetCurrentUser,
  updateProfile as authUpdateProfile,
} from "./core/auth";

// gated actions resumed after a round-trip to the standalone /signin page, keyed by a
// serializable id (a function can't survive a full-page navigation).
const AUTH_INTENT_KEY = "agentaily_auth_intent";

// Fixed follow-up prompt chips surfaced once a form exists (a product affordance, not
// model output) — keeps "继续改" discoverable. ConversationThread has no persistent
// followups slot, so they ride the closing assistant turn and render via the DS
// Suggestions in renderChatTurn; clicking one routes back through onSend → the queue.
const FOLLOWUPS = [
  L("加一个备注字段", "Add a notes field"),
  L("把手机号设为必填", "Make the phone number required"),
  L("换个封面文案", "Rewrite the cover copy"),
];

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

// A stable content signature of the live form (meta + fields), used to tell whether an
// in-progress edit has unsaved changes (PR-7 dirty 保护). Transient/identity bits that
// don't represent user-visible content are excluded: field `id` (preserved on load but
// not "content"), the `_new` entrance-animation flag, and undefined-vs-default noise are
// normalized so a freshly-loaded form compares equal to itself (clean = not dirty).
function editSig(meta, fields) {
  return JSON.stringify({
    meta: meta || null,
    fields: (fields || []).map((f) => ({
      type: f.type,
      label: f.label,
      placeholder: f.placeholder || "",
      required: !!f.required,
      options: f.options || null,
    })),
  });
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

// ── 路由分流挂载点 (第 6 步, SPEC §16.4.1 / §17 / §23.6 / §24.5) ─────────────────
// The app's ONE route split (no react-router — see src/core/router.ts). App reads the
// current pathname + search (injectable for tests) and mounts ONE bare page when a
// public/auth route matches, else the full designer:
//   • /f/:slug             → <PublicFormPage>   — the bare answerer view (公开填写).
//   • /signin              → <SignInScreen>     — the standalone owner login page (§17).
//   • /reset-password?token= → <ResetPasswordPage> — set a new password (§24.5).
//   • /verify-email?status=  → <VerifyEmailPage>    — show the verify result (§23.6).
//   • anything else (incl. /settings) → the full designer (<DesignerApp>) below.
// Each landing page is chrome-less: NO chat / preview / publish frame, and NO token held on
// the page (reset/verify I/O is public). 集成/账户设置 (§12 + §14 + §17) is NO LONGER a bare
// route page since DS 0.8.0 — it is a FLOATING OVERLAY (<SettingsOverlay>) that DesignerApp
// opens over itself, reflecting a /settings URL via history WITHOUT unmounting the designer.
// So /settings falls through to <DesignerApp>, which opens the overlay on that path (deep-link)
// and restores the prior page on close. This wrapper decides with no hooks before the branch,
// so routes never share hook order. Tests drive the split by passing explicit `pathname` /
// `search` (and may inject per-route seams).
export default function App({
  pathname = currentPathname(),
  search = currentSearch(),
  // PublicFormPage I/O seams, injected straight through on the public route.
  getPublicForm,
  submitForm,
  // ResetPasswordPage seam (§24.5): the confirm client, injectable for tests.
  confirmReset,
  // Landing-page navigation seams (§23.6 / §24.5), injectable for tests.
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
  if (matchSignIn(pathname)) {
    return <SignInScreen search={search} />;
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
  // /settings now falls through here: DesignerApp opens the settings overlay when the path is
  // /settings (deep-link) and reflects it via history on open/close. `pathname` is threaded so
  // the overlay's initial open state matches the URL.
  return <DesignerApp pathname={pathname} {...rest} />;
}

function DesignerApp({
  chat = streamDesignerChat,
  // Forms publish + management client (SPEC §16/§21). Defaults to the real formsClient
  // inside FormsPanel/PublishFeedback; injectable here for the publish/401 flow.
  publishForm,
  listForms,
  updateForm,
  deleteForm,
  // 载回设计器编辑 (PR-7): FormsPanel pulls a form's full meta+fields via getFormForEdit,
  // App writes edits back via updateFormDefinition (PATCH meta+fields). Default to the real
  // formsClient; injectable so the edit/load/写回-401 flow is driven deterministically.
  getFormForEdit = defaultGetFormForEdit,
  updateFormDefinition = defaultUpdateFormDefinition,
  publicFormUrl,
  // 数据后台「看提交」(§18). Defaults to the real submissionsClient; injectable for tests.
  listSubmissions,
  // 设计对话持久化 (§26, owner-only). Defaults to the real chatSessionClient; injectable so
  // the load-on-mount / save-at-turn-end wiring is driven deterministically in tests.
  loadChatSession = loadChatSessionClient,
  saveChatTurns = saveChatTurnsClient,
  // 多会话列表 + 删除 (§26.9, owner-only). Same injection pattern: default to the real client;
  // injectable so the SessionMenu (list / new / switch / delete) wiring is driven by fakes.
  listChatSessions = listChatSessionsClient,
  deleteChatSession = deleteChatSessionClient,
  // 邮箱未验证 banner 的「重新发送」(§23.3 owner-only). Defaults to the real
  // core/auth.requestEmailVerification (POST with Bearer); injectable for tests.
  requestEmailVerification = authRequestEmailVerification,
  // Authoritative 邮箱验证状态 + 账户 read (§23.6 owner-only): GET /api/auth/me →
  // { email, emailVerified }, fail-soft to null. Injectable so banner/account tests stay
  // deterministic.
  getCurrentUser = authGetCurrentUser,
  // logout seam — drops the owner session. Defaults to the real core/auth.logout.
  logout = authLogout,
  // 设置浮层 (§12 + §14 + §17) seams — threaded into <SettingsOverlay>. Default to the real
  // config/profile clients; injectable so tests drive the integration + account tabs.
  getConfig,
  saveConfig,
  testConnections,
  updateProfile = authUpdateProfile,
  // Initial path (from App's route split). When it is /settings the overlay opens on mount
  // (deep-link); otherwise the overlay starts closed.
  pathname = currentPathname(),
  // navigation seam for the standalone /signin redirect (full nav by default; injectable
  // so tests assert the target without a real reload).
  navigate = (url) => {
    window.location.href = url;
  },
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
  // Header LIVE/DRAFT badge: flips to LIVE only when a publish actually succeeds.
  const [published, setPublished] = useState(false);
  // 表单编辑入口 (PR-7). When the owner picks 继续编辑/编辑 on a 我的表单 card, that form's
  // EditableForm ({ slug, meta, fields, status }) is loaded back into the designer and held
  // here as the active edit target (null = not editing — the normal new-form designer).
  const [editingForm, setEditingForm] = useState(null);
  // Content signature captured at load (and re-captured after each 更新). editDirty compares
  // the live form against it to gate the 更新 button + the 放弃 confirmation on exit.
  const [editBaseline, setEditBaseline] = useState("");
  // "放弃本次编辑" confirmation (DS AlertDialog) — shown when exiting with unsaved changes.
  const [discardOpen, setDiscardOpen] = useState(false);
  // Transient "已更新" feedback on the 更新 button right after a successful write-back.
  const [updateDone, setUpdateDone] = useState(false);
  // Publish feedback (§16) + 「我的表单」 management panel (§21).
  const [publishOpen, setPublishOpen] = useState(false);
  const [formsOpen, setFormsOpen] = useState(false);
  // 设置浮层 (§12 + §14 + §17) — a floating SettingsSheet over the designer (NOT a route page).
  // Opening reflects a /settings URL via history WITHOUT unmounting the designer; a deep-link to
  // /settings starts it open. `settingsSection` is the active tab (账户 / 集成), kept in state
  // (not the URL). The designer stays mounted underneath, so closing restores the prior state.
  const [settingsOpen, setSettingsOpen] = useState(() => pathname === SETTINGS_PATH);
  const [settingsSection, setSettingsSection] = useState("integrations");
  // owner session (SPEC §17): logged-in unlocks the owner-only /api/chat proxy. `loggedIn`
  // is the token-presence bit (read on mount); `userEmail` is filled from GET /api/auth/me.
  const [loggedIn, setLoggedIn] = useState(() => authIsLoggedIn());
  const [userEmail, setUserEmail] = useState(null);
  // owner 显示名 (§17 个人资料). Filled from GET /api/auth/me; drives the AccountControl avatar/name
  // + seeds the 账户 tab. null → the UI falls back to the email.
  const [userDisplayName, setUserDisplayName] = useState(null);
  // 邮箱验证状态 (§23.6). AUTHORITATIVE bit from GET /api/auth/me — fetched on mount (when
  // logged in). Defaults to `true` (no banner) so a failed/null `me` never flashes a banner.
  const [emailVerified, setEmailVerified] = useState(true);
  // 重新发送 反馈: "" | "sending" | "sent".
  const [resendState, setResendState] = useState("");
  // continuous-send buffer (SPEC §4.1): pending messages shown above the composer.
  const [queueItems, setQueueItems] = useState([]);
  // 多会话列表 (§26.9): the owner's other design conversations, for the SessionMenu. Loaded on
  // mount (logged in) and refreshed after new/switch/delete. best-effort — a load failure just
  // leaves the prior list (the menu still offers 新会话).
  const [sessions, setSessions] = useState([]);
  // 对话级模型芯片 (§13.6): the per-conversation model the owner picked, persisted as a UI
  // preference in localStorage (sanitized through isValidChatModel so a stale value can't be
  // forwarded). Default = V4-Flash. Drives the composer pill + rides into the per-request `model`.
  const [chatModel, setChatModelState] = useState(() => {
    try {
      const saved = localStorage.getItem(CHAT_MODEL_STORAGE_KEY);
      if (isValidChatModel(saved)) return saved;
    } catch {
      /* storage unavailable — fall through to the default */
    }
    return DEFAULT_CHAT_MODEL;
  });
  // 模型菜单开合,由 DS Composer 的模型 pill 点击 (onModelClick) 驱动 (handoff chat13).
  // 弹层锚定走纯 CSS (.cm-menu 相对 .cm-wrap 左下),不再读 pill 坐标。
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // Always-current mirror of the picked model so the §4.1 queue consumer closure (captured on
  // first render) reads the LATEST model when it constructs the chat call, not a stale one.
  const chatModelRef = useRef(chatModel);
  // Persist + sanitize on pick; keep the ref in sync.
  const setChatModel = useCallback((value) => {
    if (!isValidChatModel(value)) return;
    chatModelRef.current = value;
    setChatModelState(value);
    try {
      localStorage.setItem(CHAT_MODEL_STORAGE_KEY, value);
    } catch {
      /* storage unavailable — the in-memory state still drives this page */
    }
  }, []);
  // Canonical form model the agent tools mutate; React `meta`/`fields` mirror it.
  const modelRef = useRef(null);
  if (!modelRef.current) modelRef.current = createFormModel();
  // LLM message history for the whole session (OpenAI shape), seeded with the system prompt.
  const historyRef = useRef(null);
  if (!historyRef.current) historyRef.current = [{ role: "system", content: DESIGNER_SYSTEM }];

  // 设计对话持久化 (§26). The stable, client-minted, localStorage-backed design session id
  // (keyed (owner_id, sessionId)); minted once on mount and reused across reloads / publish.
  const sessionIdRef = useRef(null);
  if (!sessionIdRef.current) sessionIdRef.current = getOrCreateDesignSessionId();
  // The published form's slug once this session's form is published (§26.2): carried on every
  // subsequent turn-end save so the session row gets associated; null before publish.
  const publishedSlugRef = useRef(null);
  // Guard so the load-on-mount restore runs exactly once per logged-in mount (§26 restore).
  const restoredRef = useRef(false);
  // Always-current mirror of `messages` so the turn-end save reads the latest thread
  // without a stale closure (and without abusing a setState updater as a getter).
  const messagesRef = useRef([]);
  // Always-current mirror of `editingForm` (PR-7). The §4.1 queue consumer closure captures
  // the FIRST render's runTurn → persistTurn, so a state read there is stale; persistTurn must
  // check this ref to skip §26 persistence while editing (an edit conversation is ephemeral and
  // must NOT overwrite the form's design session — kept in sync by loadFormForEdit / doExit).
  const editingFormRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", t.theme === "light" ? "light" : "dark");
  }, [t.theme]);

  const setValue = useCallback((id, v) => setValuesState((s) => ({ ...s, [id]: v })), []);
  // All thread mutations go through setMessagesTracked. We compute `next` synchronously off
  // `messagesRef.current` (the canonical thread snapshot) and update the ref *before* calling
  // setMessages — so the ref is the latest thread the instant the call returns, and the §26
  // turn-end save (which reads messagesRef synchronously) sees the final prose text. setMessages
  // gets the already-computed value, never an updater fn — React defers updater bodies to
  // render/commit, which left the ref stale (and StrictMode double-invokes updaters). Multiple
  // calls in one tick accumulate correctly: each computes off the prior call's messagesRef.
  const setMessagesTracked = (updater) => {
    const next = typeof updater === "function" ? updater(messagesRef.current) : updater;
    messagesRef.current = next; // sync: ref is always the latest thread snapshot
    setMessages(next); // only to trigger a render
  };
  const pushMsg = (m) => {
    const id = uid("msg");
    setMessagesTracked((ms) => [...ms, { id, ...m }]);
    return id;
  };
  const patchMsg = (id, patch) =>
    setMessagesTracked((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  const removeMsg = (id) => setMessagesTracked((ms) => ms.filter((m) => m.id !== id));
  // Clear the entrance-animation flag ~600ms after a field appears — on the model AND
  // the rendered mirror, so a later sync won't re-trigger it.
  const clearNew = (fid) =>
    setTimeout(() => {
      const f = modelRef.current.fields.find((x) => x.id === fid);
      if (f) f._new = false;
      setFields(modelRef.current.fields.map((x) => ({ ...x })));
    }, 600);

  // Push the canonical model into React state for rendering; schedule the entrance
  // animation to clear for any freshly-added/updated fields.
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
      if (e.status === 401)
        return L(
          "请先登录 owner 后再使用对话设计。",
          "Please sign in as the owner to use conversational design.",
        );
      return (
        e.message || L(`对话服务出错（${e.status}）。`, `Conversation service error (${e.status}).`)
      );
    }
    return L(
      "无法连接到对话服务，请检查网络或后端地址（VITE_API_BASE）。",
      "Can't reach the conversation service — check your network or the backend address (VITE_API_BASE).",
    );
  };

  // ── owner session helpers (standalone /signin page model) ──────────────────────
  // Send a signed-out owner to the standalone login page, carrying where to come back
  // to (return) and why (reason). Login persists the session and navigates back; the
  // designer re-mounts signed-in and resumes the stashed intent. `return` defaults to the
  // current path but a caller may override it (集成设置 wants to land on /settings).
  const goSignIn = (params) => {
    const qs = new URLSearchParams({ return: currentPathname() || "/", ...params });
    navigate(SIGNIN_PATH + "?" + qs.toString());
  };

  // ── 设置浮层 open/close (路由反映, 不卸载设计器, §12/§14/§17) ─────────────────────
  // Track whether WE pushed the /settings history entry, so closing can step back to the prior
  // page (history.back) rather than stranding the owner. A deep-link (no push) closes to "/".
  const settingsPushedRef = useRef(false);
  const openSettings = useCallback((sectionId) => {
    setSettingsSection(sectionId === "account" ? "account" : "integrations");
    setSettingsOpen(true);
    // Reflect /settings in the URL without navigating away (the designer stays mounted). Guard
    // the push so re-opening / a deep-link doesn't stack duplicate history entries.
    if (typeof window !== "undefined" && window.history && currentPathname() !== SETTINGS_PATH) {
      window.history.pushState({ settings: true }, "", SETTINGS_PATH);
      settingsPushedRef.current = true;
    }
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    if (typeof window === "undefined" || !window.history) return;
    if (settingsPushedRef.current) {
      settingsPushedRef.current = false;
      window.history.back(); // restore the pre-overlay URL (the designer never unmounted)
    } else if (currentPathname() === SETTINGS_PATH) {
      // Deep-linked straight to /settings (no prior entry to pop) → normalize to the designer.
      window.history.pushState({}, "", "/");
    }
  }, []);
  // Keep the overlay in sync with the URL so the browser Back/Forward buttons toggle it (Back
  // while open → closes + restores the designer). popstate just re-reads the path.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPop = () => {
      const open = currentPathname() === SETTINGS_PATH;
      setSettingsOpen(open);
      if (!open) settingsPushedRef.current = false;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // A 401 mid-action means the owner session lapsed — drop it and route into login.
  const needLogin = (reason) => {
    setLoggedIn(false);
    goSignIn(reason ? { reason } : {});
  };
  // 401 inside the settings overlay: stash which tab so re-login reopens it, close the overlay,
  // then route into login carrying return=/settings (so the owner lands back on settings after
  // logging in — deterministic regardless of the current location).
  const needLoginFromSettings = (reason) => {
    try {
      sessionStorage.setItem(
        AUTH_INTENT_KEY,
        settingsSection === "account" ? "account" : "settings",
      );
    } catch {
      /* ignore */
    }
    setSettingsOpen(false);
    settingsPushedRef.current = false;
    setLoggedIn(false);
    goSignIn({ return: SETTINGS_PATH, ...(reason ? { reason } : {}) });
  };
  // Run a resolved intent now (signed-in). publish/share/forms stay in-app overlays; 集成设置 /
  // 账户 open the floating settings overlay on the matching tab (§12/§14/§17).
  const dispatchIntent = (id) => {
    if (id === "publish" || id === "share") setPublishOpen(true);
    else if (id === "forms") setFormsOpen(true);
    else if (id === "settings") openSettings("integrations");
    else if (id === "account") openSettings("account");
  };
  // Gate an action behind auth: signed-in → run now; signed-out → stash the intent and bounce
  // through /signin, which returns here and resumes the stashed intent (incl. opening settings /
  // the account tab).
  const guard = (intentId, reason) => {
    if (loggedIn) {
      dispatchIntent(intentId);
      return;
    }
    try {
      sessionStorage.setItem(AUTH_INTENT_KEY, intentId);
    } catch {
      /* private mode / disabled storage — fall through to a plain login */
    }
    goSignIn(reason ? { reason } : {});
  };
  const doLogout = () => {
    logout();
    setLoggedIn(false);
    setUserEmail(null);
    setUserDisplayName(null);
    // logging out drops the session — hide the banner (no owner to verify) + close settings.
    setEmailVerified(true);
    setResendState("");
    closeSettings();
  };

  // Pull the AUTHORITATIVE 验证状态 + 账户邮箱 from GET /api/auth/me (§23.6). getCurrentUser
  // is fail-soft (resolves null on 401 / network), so on a null we leave state as-is.
  const refreshMe = useCallback(async () => {
    const me = await getCurrentUser();
    if (me) {
      setEmailVerified(me.emailVerified);
      setUserEmail(me.email);
      setUserDisplayName(me.displayName ?? null);
    }
  }, [getCurrentUser]);

  // 账户 tab 保存显示名后回流到 App：刷新 AccountControl 的头像/名 + 下次开浮层的初值 (§17 个人资料)。
  const onProfileSaved = useCallback((me) => {
    if (!me) return;
    setUserDisplayName(me.displayName ?? null);
    if (me.email) setUserEmail(me.email);
    if (typeof me.emailVerified === "boolean") setEmailVerified(me.emailVerified);
  }, []);

  // On mount (when logged in) read me once so the banner + account control reflect the
  // real session. Logged-out sessions have nothing to read, so we skip.
  useEffect(() => {
    if (loggedIn) refreshMe();
  }, [loggedIn, refreshMe]);

  // Apply a loaded persisted session onto the live workspace: rebuild the visible thread
  // (`messages`) AND re-seed the loop's LLM history (`historyRef`, incl. the leading system
  // prompt) so the owner resumes the same thread and the Agent keeps the prior context
  // (§26.6). Empty/null → reset to the初始空态. Shared by the load-on-mount restore effect and
  // the SessionMenu 切换 path (switchSession below).
  const applyRestoredSession = (session) => {
    if (!session) return;
    if (Array.isArray(session.turns) && session.turns.length > 0) {
      setMessagesTracked(session.turns.map((tn) => ({ ...tn })));
    } else {
      setMessagesTracked([]);
    }
    historyRef.current =
      Array.isArray(session.history) && session.history.length > 0
        ? session.history.map((h) => ({ ...h }))
        : [{ role: "system", content: DESIGNER_SYSTEM }];
    publishedSlugRef.current = session.formSlug || null;
  };

  // 设计对话恢复 (§26 restore): when logged in, load this session's persisted conversation
  // ONCE and rebuild both transcripts — the visible thread (`messages`) and the loop's LLM
  // history (`historyRef`, incl. the leading system prompt) — so the owner resumes the same
  // thread AND the Agent keeps the prior context. A never-persisted id → { session: null } →
  // stay in the初始空态 (current behavior). Signed-out owners never load (§26.5). A 401 means
  // the session lapsed → route into /signin. best-effort: any other failure leaves the empty
  // thread intact (the next turn-end save re-establishes the row).
  useEffect(() => {
    if (!loggedIn || restoredRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const { session } = await loadChatSession(sessionIdRef.current);
        if (cancelled || !session) return;
        // StrictMode-safe: only mark as restored once the async result actually
        // applies (success + not cancelled). Marking eagerly in the effect body would
        // let StrictMode's cancelled first run "consume" the flag, so the second run
        // early-returns and setMessages never fires. StrictMode dev double-fires the
        // GET (intentional); production runs it once.
        restoredRef.current = true;
        applyRestoredSession(session);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401)
          needLogin(L("登录后恢复你的设计对话", "Sign in to restore your design conversation"));
        // else: best-effort — leave the empty thread; the next save re-establishes the row.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn]);

  // 会话列表 (§26.9): pull the owner's other conversations for the SessionMenu. best-effort —
  // a load failure (incl. transient) just keeps the prior list; a 401 routes into /signin.
  const refreshSessions = useCallback(async () => {
    if (!loggedIn) return;
    try {
      const { sessions: list } = await listChatSessions();
      if (Array.isArray(list)) setSessions(list);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401)
        needLogin(L("登录后管理你的设计对话", "Sign in to manage your design conversations"));
      // else: best-effort — keep the prior list.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, listChatSessions]);

  // Load the session list on mount (when logged in); refreshed imperatively after new/switch/delete.
  useEffect(() => {
    if (loggedIn) refreshSessions();
  }, [loggedIn, refreshSessions]);

  // ── 多会话 新建 / 切换 / 删除 (§26.9) ───────────────────────────────────────────
  // Reset the live workspace to a clean, empty designer (mirrors doExit's cleanup, minus the
  // edit-mode-only bits): empty thread, fresh LLM history, no published slug, cleared form model
  // + preview. Used by 新会话 and by deleting the active session. `restoredRef` is set so the
  // mount-restore effect never re-fires against the new id.
  const resetWorkspace = () => {
    restoredRef.current = true; // a fresh session has nothing to restore
    editingFormRef.current = null;
    setEditingForm(null);
    historyRef.current = [{ role: "system", content: DESIGNER_SYSTEM }];
    publishedSlugRef.current = null;
    modelRef.current = createFormModel();
    setMessagesTracked([]);
    setMeta(null);
    setFields([]);
    setValuesState({});
    setPublished(false);
  };

  // 新会话: mint + activate a brand-new design session id (so subsequent turn-end saves write a
  // NEW row, never overwriting the prior conversation), clear the workspace, refresh the list.
  const newChat = () => {
    sessionIdRef.current = newDesignSessionId();
    resetWorkspace();
    refreshSessions();
  };

  // 切换: make `id` the active session, load + apply its transcript (reusing the same restore
  // path as mount), and refresh the list so the menu highlight follows. A 401 routes into login;
  // any other failure leaves the prior workspace (best-effort).
  const switchSession = async (id) => {
    if (!id || id === sessionIdRef.current) return;
    setActiveDesignSessionId(id);
    sessionIdRef.current = id;
    restoredRef.current = true; // we restore explicitly here, not via the mount effect
    try {
      const { session } = await loadChatSession(id);
      // Hit → rebuild that conversation. Miss ({ session: null }, e.g. a stale list row whose
      // row vanished) → reset to an EMPTY workspace, NOT a no-op: sessionIdRef already moved to
      // `id`, so leaving the prior conversation visible would let the next turn-end save write
      // the OLD transcript under the new id. A fresh empty workspace is the safe state.
      if (session) applyRestoredSession(session);
      else resetWorkspace();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401)
        needLogin(L("登录后切换你的设计对话", "Sign in to switch your design conversation"));
      // else: best-effort — leave the prior workspace.
    }
    refreshSessions();
  };

  // 删除: remove the session server-side; if it was the ACTIVE one, behave like 新会话 (open a
  // fresh empty conversation). Refresh the list either way. A 404 (foreign / never-existed) is
  // swallowed for the menu's purposes (the row just disappears on refresh); a 401 routes into login.
  const removeSession = async (id) => {
    if (!id) return;
    try {
      await deleteChatSession(id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        needLogin(L("登录后管理你的设计对话", "Sign in to manage your design conversations"));
        return;
      }
      // 404 / other: best-effort — fall through to a list refresh (the row drops off).
    }
    if (id === sessionIdRef.current) {
      // deleting the open conversation → start a fresh one (no orphaned empty workspace).
      sessionIdRef.current = newDesignSessionId();
      resetWorkspace();
    }
    refreshSessions();
  };

  // Returning from /signin: if signed in and an intent was stashed, run it once.
  useEffect(() => {
    if (!loggedIn) return;
    let id = null;
    try {
      id = sessionStorage.getItem(AUTH_INTENT_KEY);
      sessionStorage.removeItem(AUTH_INTENT_KEY);
    } catch {
      /* ignore */
    }
    if (id) setTimeout(() => dispatchIntent(id), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn]);

  // 重新发送验证邮件 (§23.3, owner-only). Always succeeds when authenticated; on resolve we
  // show ONE neutral「已重新发送」. A 401 means the session lapsed — route into login.
  const resendVerification = async () => {
    if (resendState === "sending") return;
    setResendState("sending");
    try {
      await requestEmailVerification();
      setResendState("sent");
      refreshMe();
    } catch (e) {
      setResendState("");
      if (e instanceof ApiError && e.status === 401)
        needLogin(L("登录后重新发送验证邮件", "Sign in to resend the verification email"));
    }
  };

  // One streamed LLM call → one assistant bubble. Text streams in live; a tool-only turn
  // drops its empty bubble. On failure the placeholder is removed before rethrow.
  const callChat = async ({ messages: history }) => {
    let acc = "";
    const mid = pushMsg({ role: "assistant", kind: "text", text: "", streaming: true });
    let res;
    try {
      res = await chat({
        messages: history,
        // 对话级模型 (§13.6): forward the owner's picked model as the per-request `model`.
        // Read the REF (kept current by setChatModel) so this queue-consumer closure — captured
        // on first render — uses the LATEST pick, not the model at construction time.
        model: chatModelRef.current,
        onText: (d) => {
          acc += d;
          patchMsg(mid, { text: acc });
        },
      });
    } catch (e) {
      removeMsg(mid);
      throw e;
    }
    const finalText = res.text || acc;
    if (finalText) patchMsg(mid, { text: finalText, streaming: false });
    else removeMsg(mid);
    return res;
  };

  // Run one agent turn over a merged batch of user prompts (§4 ReAct loop): stream prose,
  // execute form tools (tool-call cards), rerender preview. `merged` is the queue's
  // batch-merged text (numbered + <context>-wrapped for mid-work input per §4.1).
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
      // With a form now present, surface the fixed follow-up suggestion chips on the
      // closing assistant prose so 「继续改」 stays discoverable (build-form.feature
      // 「对话给出后续修改建议」). The DS ConversationThread has no persistent followups
      // slot, so they ride the last assistant text turn → renderChatTurn's Suggestions.
      if (modelRef.current.fields.length > 0) {
        setMessagesTracked((ms) => {
          for (let i = ms.length - 1; i >= 0; i--) {
            if (ms[i].role === "assistant" && ms[i].kind === "text") {
              const next = ms.slice();
              next[i] = { ...ms[i], suggestions: FOLLOWUPS };
              return next;
            }
          }
          return ms;
        });
      }
    } catch (e) {
      pushMsg({ role: "assistant", kind: "error", text: errorMessage(e) });
      // 401 means no/expired owner session — route into the standalone login (§17).
      if (e instanceof ApiError && e.status === 401)
        needLogin(L("登录后继续对话设计", "Sign in to continue conversational design"));
    }
    syncModel();
    // 持久化 (§26.4): at TURN END (here, after the §4 loop settled — never during the
    // streaming onText above), flush the full snapshot — the complete UI thread + LLM
    // history — once. Signed-out owners never persist (§26.5).
    persistTurn();
  };

  // Persist the current full conversation snapshot for this session (§26.3/§26.4): the
  // complete UI thread (serialized to PersistedTurn[], `streaming` stripped) + the loop's
  // LLM history (`historyRef`, incl. system) + the published slug (once published). Reads
  // the latest thread from `messagesRef` (kept current by setMessagesTracked) so a
  // just-settled turn is included. best-effort: a non-401 failure does NOT break the
  // conversation (the next turn's full PUT overwrites idempotently); a 401 routes into
  // /signin (§26.4 失败不阻断 + 401 例外).
  const persistTurn = () => {
    if (!loggedIn) return; // 未登录不持久化 (§26.5)
    // 编辑态不写 §26 设计会话 (PR-7): an edit conversation is ephemeral (the form definition is
    // saved server-side via 更新/PATCH, not the design session). Persisting it would overwrite the
    // form's own design-session row with a foreign transcript. Read the REF, not `editingForm` —
    // this closure is the first-render one captured by the queue consumer (state would be stale).
    if (editingFormRef.current) return;
    const input = {
      turns: toPersistedTurns(messagesRef.current),
      history: historyRef.current,
      ...(publishedSlugRef.current ? { formSlug: publishedSlugRef.current } : {}),
    };
    Promise.resolve(saveChatTurns(sessionIdRef.current, input)).catch((e) => {
      if (e instanceof ApiError && e.status === 401)
        needLogin(L("登录后继续对话设计", "Sign in to continue conversational design"));
      // else: best-effort, swallow — the next turn-end PUT overwrites (§26.4).
    });
  };

  // One message queue for the whole session (§4.1): connect-send N times → exactly one
  // consumer loop; whatever accumulated flushes together as a single agent turn over the
  // merged text. `bufferRef` mirrors the same atomic flush so each raw message shows as
  // its own bubble (and stays in sync when a queued item is cancelled).
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

  // every send path — composer (via the ConversationThread controller), 建议 chip, 标注层 —
  // enqueues explicit text into the same §4.1 buffer.
  const onSend = (text) => {
    const tx = (text || "").trim();
    if (!tx) return;
    bufferRef.current = [...bufferRef.current, tx];
    queueRef.current.enqueue(tx);
  };

  const removeQueued = (i) => {
    const item = queueItems[i];
    if (!item) return;
    if (queueRef.current.cancel(item.id)) {
      const j = bufferRef.current.indexOf(item.text);
      if (j >= 0) bufferRef.current = bufferRef.current.filter((_, idx) => idx !== j);
    }
  };

  // Adapt the real §4.1 MessageQueue + React state into the shape ConversationThread's
  // `controller` expects (a Queue.useQueue return value). The composer enqueues into it,
  // the buffer list + busy placeholder read from it — but the actual batching/merge stays
  // in core/queue.ts (tested), not the DS hook.
  const controller = {
    queue: queueItems.map((q) => ({ id: q.id, text: q.text })),
    busy: building,
    enqueue: (text) => onSend(text),
    remove: (i) => removeQueued(i),
    reset: () => {},
  };

  // ── 表单编辑入口 (PR-7) ─────────────────────────────────────────────────────────
  // Load a stored form's full definition (from FormsPanel → getFormForEdit) back into the
  // designer for editing. The canonical model is replaced (so the agent's tool calls mutate
  // THIS form), the React mirror is synced, and the edit baseline is captured for dirty
  // detection. reserveUidsFrom advances the session id counter past the loaded field ids —
  // those ids are kept verbatim (the write-back round-trips them so the backend matches a
  // changed label as a rename, not a delete+add), so a freshly added field must not collide
  // with them. A status-aware 载入 note seeds the thread (closed forms aren't "online").
  const loadFormForEdit = (form) => {
    if (!form) return;
    setFormsOpen(false);
    const loadedMeta = form.meta ? { ...form.meta } : null;
    const loadedFields = (form.fields || []).map((f) => ({ ...f }));
    reserveUidsFrom(loadedFields.map((f) => f.id));
    // replace the canonical model so subsequent agent edits operate on the loaded form
    modelRef.current.meta = loadedMeta ? { ...loadedMeta } : null;
    modelRef.current.fields = loadedFields.map((f) => ({ ...f }));
    // Start the edit on a CLEAN agent context: reset the LLM history to just the system prompt
    // so the prior (new-form) conversation can't bleed into edits of a different form, and mark
    // the editing ref so turn-end §26 persistence is skipped (an edit conversation is ephemeral
    // and must not overwrite this or any form's design session). The visible thread is reseeded
    // below; the agent reads the loaded fields via get_form_schema, so history needs no fields.
    editingFormRef.current = { slug: form.slug, status: form.status, meta: loadedMeta };
    historyRef.current = [{ role: "system", content: DESIGNER_SYSTEM }];
    setMeta(loadedMeta);
    setFields(loadedFields);
    setValuesState({});
    setEditingForm({ slug: form.slug, status: form.status, meta: loadedMeta });
    setPublished(form.status === "published");
    setUpdateDone(false);
    setDiscardOpen(false);
    setEditBaseline(editSig(loadedMeta, loadedFields));
    setTab("preview");
    const title = loadedMeta?.title || L("这份表单", "this form");
    const note =
      form.status === "closed"
        ? L(
            `已载入《${title}》的当前版本，共 ${loadedFields.length} 个字段。这份表单当前已关闭、未在收集；直接告诉我要改什么，改好点「更新」保存，需要时再「重新发布」让访问者看到新版本。不想保留这次改动就点「退出」。`,
            `Loaded the current version of “${title}” — ${loadedFields.length} fields. This form is currently closed and not collecting; just tell me what to change, click “Update” to save, and “Republish” when ready so visitors see the new version. Click “Exit” if you don't want to keep these changes.`,
          )
        : L(
            `已载入《${title}》的当前版本，共 ${loadedFields.length} 个字段。直接告诉我要改什么，或在右侧预览里「指向修改」。改好后点「更新」即可对新访问者生效；不想保留这次改动就点「退出」。`,
            `Loaded the current version of “${title}” — ${loadedFields.length} fields. Just tell me what to change, or use “Point to edit” in the preview on the right. Click “Update” to apply it to new visitors; click “Exit” if you don't want to keep these changes.`,
          );
    setMessagesTracked([{ id: uid("msg"), role: "assistant", kind: "text", text: note }]);
  };

  // Write the edited form back via PATCH /api/forms/:slug (整块替换 meta+fields, §21.3).
  // On success re-baseline (so 更新 disables again until the next change) + flash 已更新.
  // A 401 means the session lapsed → route into login. Other failures surface in the thread.
  const updateLiveForm = async () => {
    if (!editingForm || !editDirty || building) return;
    try {
      await updateFormDefinition(editingForm.slug, modelRef.current.meta, modelRef.current.fields);
      // Re-baseline from the SAME source we wrote back (the canonical model), not the React
      // mirror — so dirty detection can't diverge if the model was mutated without a synchronous
      // state flush before 更新. The button re-disables until the next real change.
      setEditBaseline(editSig(modelRef.current.meta, modelRef.current.fields));
      setUpdateDone(true);
      setTimeout(() => setUpdateDone(false), 2200);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        needLogin(L("登录后保存你的表单改动", "Sign in to save your form changes"));
        return;
      }
      pushMsg({ role: "assistant", kind: "error", text: errorMessage(e) });
    }
  };

  // Leave edit mode and reset to a clean draft designer (the stored form is safe in 我的表单).
  // Mirror loadFormForEdit's ref hygiene: clear the editing ref (re-enables §26 persistence) and
  // reset the LLM history + published-slug association so the next new-form session starts clean
  // and doesn't carry the edited form's context/slug.
  const doExit = () => {
    editingFormRef.current = null;
    historyRef.current = [{ role: "system", content: DESIGNER_SYSTEM }];
    publishedSlugRef.current = null;
    setEditingForm(null);
    setUpdateDone(false);
    setDiscardOpen(false);
    setEditBaseline("");
    modelRef.current = createFormModel();
    setMeta(null);
    setFields([]);
    setValuesState({});
    setPublished(false);
    setMessagesTracked([]);
  };

  // 退出: with unsaved changes confirm first (放弃本次编辑); otherwise leave directly.
  const exitEditing = () => {
    if (editDirty) {
      setDiscardOpen(true);
      return;
    }
    doExit();
  };

  const fieldCount = fields.length;
  // dirty = an active edit whose live content diverged from the loaded/last-saved baseline.
  const editDirty = !!editingForm && editSig(meta, fields) !== editBaseline;
  // Editing a CLOSED form: its display must NOT claim the online/收集中 context (chat13).
  const editingClosed = !!editingForm && editingForm.status === "closed";

  return (
    <React.Fragment>
      <DesignerShell
        brand={<BrandMark size={18} wordmark cursor={false} />}
        crumb="forms"
        split={t.split / 100}
        onSplitChange={(f) => setTweak("split", Math.round(f * 100))}
        minSplit={0.32}
        maxSplit={0.64}
        title={
          <React.Fragment>
            <span style={{ fontSize: "var(--text-md)", color: "var(--text-muted)" }}>
              {/* 编辑态用实时 meta.title(改名后立即跟随预览),非载入时的快照。 */}
              {editingForm
                ? meta?.title || L("未命名表单", "Untitled form")
                : L("活动报名 · 未命名表单", "Event sign-up · Untitled form")}
            </span>
            {editingForm ? (
              // 编辑态徽章随真实状态自洽 (chat13): 已发布→LIVE，已关闭→已关闭（绝不把关闭表单当在线展示）。
              <Badge variant={editingForm.status === "published" ? "ok" : "neutral"} dot>
                {editingForm.status === "published" ? "LIVE" : L("已关闭", "CLOSED")}
              </Badge>
            ) : (
              <Badge variant={published ? "ok" : "neutral"} dot>
                {published ? "LIVE" : "DRAFT"}
              </Badge>
            )}
          </React.Fragment>
        }
        actions={
          <React.Fragment>
            <IconButton
              label={L("切换主题", "Toggle theme")}
              onClick={() => setTweak("theme", t.theme === "dark" ? "light" : "dark")}
            >
              <Icon name={t.theme === "dark" ? "sun" : "moon"} size={15} />
            </IconButton>
            <Button
              variant="secondary"
              icon={<Icon name="share" size={14} />}
              onClick={() =>
                guard(
                  "share",
                  L(
                    "登录后即可分享表单并收集回复",
                    "Sign in to share your form and collect responses",
                  ),
                )
              }
            >
              {L("分享", "Share")}
            </Button>
            {editingForm ? (
              // 编辑态: 主按钮由「发布」变「更新」→ PATCH 写回 meta+fields。无改动时灰着。
              <Button
                variant="primary"
                icon={<Icon name={updateDone ? "check" : "save"} size={14} />}
                disabled={building || fieldCount === 0 || !editDirty}
                onClick={updateLiveForm}
              >
                {updateDone ? L("已更新", "Updated") : L("更新", "Update")}
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={<Icon name="spark" size={14} />}
                disabled={building || fieldCount === 0}
                onClick={() =>
                  guard("publish", L("登录后即可发布表单", "Sign in to publish your form"))
                }
              >
                {L("发布", "Publish")}
              </Button>
            )}
          </React.Fragment>
        }
        account={
          <AccountControl
            user={loggedIn ? { email: userEmail || "", name: userDisplayName || undefined } : null}
            onLogin={() => goSignIn({})}
            onLogout={doLogout}
            // The email row opens the 账户 tab (§17 个人资料); menu items below it match the
            // design handoff order: 集成设置 (plug) above 我的表单 (folder), with a separator.
            onProfile={() =>
              guard("account", L("登录后管理你的账户", "Sign in to manage your account"))
            }
            items={[
              {
                label: L("集成设置", "Integrations"),
                icon: <Icon name="plug" size={15} />,
                onSelect: () =>
                  guard("settings", L("登录后配置集成", "Sign in to configure integrations")),
              },
              { type: "separator" },
              {
                label: L("我的表单", "My forms"),
                icon: <Icon name="folder" size={15} />,
                onSelect: () =>
                  guard(
                    "forms",
                    L("登录后查看你发布的表单", "Sign in to view the forms you've published"),
                  ),
              },
            ]}
          />
        }
        mobileLabels={{
          chat: (
            <React.Fragment>
              <Icon name="message" size={15} /> {L("对话", "Chat")}
            </React.Fragment>
          ),
          preview: (
            <React.Fragment>
              <Icon name="eye" size={15} /> {L("预览", "Preview")}{" "}
              {fieldCount ? <span className="ax-dshell__mcount">{fieldCount}</span> : null}
            </React.Fragment>
          ),
        }}
        chat={
          // 对话级模型芯片 (§13.6): DS 0.11.0 的 ConversationThread 透传 onModelClick 给内部
          // Composer 的模型 pill,直接拿官方回调开锚定弹层 —— 不再用 wrapper 截内部类
          // `.ax-composer__model`。.cm-wrap 仍是弹层的定位容器 (position: relative);弹层锚定
          // 走纯 CSS (.cm-menu 左下,见 app.css)。SessionMenu 骑在 header `actions` 槽;模型
          // `pill` 反映当前选择。
          <div className="cm-wrap">
            <ConversationThread
              title={L("对话", "Chat")}
              model={chatModelPill(chatModel)}
              onModelClick={() => setModelMenuOpen((o) => !o)}
              actions={
                <SessionMenu
                  sessions={sessions}
                  activeId={sessionIdRef.current}
                  onNewChat={newChat}
                  onSelect={switchSession}
                  onDelete={removeSession}
                />
              }
              messages={messages}
              draft={draft}
              onDraftChange={setDraft}
              controller={controller}
              renderTurn={(m, i, ctx) => renderChatTurn(m, ctx, onSend)}
              emptyTitle={L("描述你想要的表单", "Describe the form you want")}
              hints={[
                L("做一个线下活动报名表", "Build an in-person event sign-up form"),
                L("收集一份客户满意度问卷", "Collect a customer satisfaction survey"),
                L("招聘投递表单", "A job application form"),
              ]}
              placeholder={L(
                "描述你想要的表单，例如：做一个活动报名表…",
                "Describe the form you want, e.g. build an event sign-up…",
              )}
              busyPlaceholder={L(
                "可继续输入，会收进缓冲区一起处理…",
                "Keep typing — it'll buffer and process together…",
              )}
              note={L(
                "AGENTAILY 会出错 · 发布前请核对字段",
                "AGENTAILY can make mistakes · review fields before publishing",
              )}
            />
            {modelMenuOpen ? (
              <React.Fragment>
                <div className="cm-scrim" onClick={() => setModelMenuOpen(false)} />
                <div className="cm-menu">
                  <div className="cm-menu__label ax-label">
                    {L("模型 · DeepSeek", "Model · DeepSeek")}
                  </div>
                  {CHAT_MODELS.map((m) => (
                    <button
                      type="button"
                      key={m.value}
                      className={"cm-opt" + (chatModel === m.value ? " is-on" : "")}
                      onClick={() => {
                        setChatModel(m.value);
                        setModelMenuOpen(false);
                      }}
                    >
                      <span className="cm-opt__body">
                        <span className="cm-opt__name">{m.label}</span>
                        <span className="cm-opt__desc">{m.hint}</span>
                      </span>
                      {chatModel === m.value ? <Icon name="check" size={14} /> : null}
                    </button>
                  ))}
                </div>
              </React.Fragment>
            ) : null}
          </div>
        }
        preview={
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            {/* 编辑态状态横幅 (PR-7, chat13): 低调发丝线条 — ■ EDITING mono 标签 + 状态点 + 一行
                文案 + 「详情」HoverCard + 「退出」。与下方「预览 / Schema」工具栏等高（共用 --bar-h）。
                文案/详情随表单真实状态自洽：已发布走「线上仍在收集」，已关闭走「未在收集」。 */}
            {editingForm ? (
              <div className="d-editbar" data-testid="edit-banner">
                <span className="ax-label d-editbar__tag">EDITING</span>
                <span className="d-editbar__txt">
                  {editingClosed
                    ? L(
                        "正在编辑已关闭的表单 · 表单未在收集，改动点「更新」保存",
                        "Editing a closed form · not collecting; click “Update” to save",
                      )
                    : L(
                        "正在编辑已发布表单 · 改动点「更新」后才对访问者生效",
                        "Editing a published form · changes go live only after you click “Update”",
                      )}
                </span>
                <HoverCard
                  side="bottom"
                  className="d-editbar__more"
                  trigger={<span className="d-editbar__moretxt">{L("详情", "Details")}</span>}
                >
                  <div className="d-editbar__pop">
                    {editingClosed ? (
                      <React.Fragment>
                        <p>{L("编辑已关闭的表单时", "When editing a closed form")}</p>
                        <ul>
                          <li>
                            {L(
                              "表单当前已关闭，不接收新提交",
                              "The form is closed and accepts no new submissions",
                            )}
                          </li>
                          <li>{L("改动在「更新」后保存", "Changes are saved after “Update”")}</li>
                          <li>
                            {L(
                              "重新发布后，访问者看到的是新版本",
                              "After republishing, visitors see the new version",
                            )}
                          </li>
                        </ul>
                      </React.Fragment>
                    ) : (
                      <React.Fragment>
                        <p>{L("编辑线上表单时", "When editing a live form")}</p>
                        <ul>
                          <li>{L("历史提交保留不变", "Past submissions stay unchanged")}</li>
                          <li>
                            {L(
                              "新增字段对旧提交显示「—」",
                              "New fields show “—” for old submissions",
                            )}
                          </li>
                          <li>
                            {L("编辑期间表单仍在收集", "The form keeps collecting while you edit")}
                          </li>
                        </ul>
                      </React.Fragment>
                    )}
                  </div>
                </HoverCard>
                <button type="button" className="d-editbar__exit" onClick={exitEditing}>
                  {L("退出", "Exit")}
                </button>
              </div>
            ) : null}
            <div className="ax-dshell__panebar">
              <div className="d-pvhead__tabs">
                <Tabs
                  items={[
                    { id: "preview", label: L("预览", "Preview") },
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
                    label={L("指向修改", "Point to edit")}
                    size="sm"
                    variant={markupOn ? "solid" : "outline"}
                    disabled={building || fieldCount === 0}
                    onClick={() => setMarkupOn((on) => !on)}
                  >
                    <Icon name="pen" size={13} />
                  </IconButton>
                  <span className="d-devtoggles">
                    <span className="d-seg__sep" />
                    <IconButton
                      label={L("桌面宽度", "Desktop width")}
                      size="sm"
                      variant={device === "full" ? "solid" : "outline"}
                      onClick={() => setDevice("full")}
                    >
                      <Icon name="monitor" size={13} />
                    </IconButton>
                    <IconButton
                      label={L("手机宽度", "Phone width")}
                      size="sm"
                      variant={device === "phone" ? "solid" : "outline"}
                      onClick={() => setDevice("phone")}
                    >
                      <Icon name="phone" size={13} />
                    </IconButton>
                  </span>
                </div>
              ) : null}
            </div>

            <div className="d-pvstage">
              <div
                className={
                  "d-pvbody ax-dotgrid" + (tab === "preview" && markupOn ? " is-markup" : "")
                }
              >
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
            </div>
          </div>
        }
      />

      {/* 邮箱未验证 banner (§23.6). Soft — it gates NOTHING (§23.1); it only nudges the owner
          to verify. A fixed strip floating over the DesignerShell frame. Shown when logged
          in AND the AUTHORITATIVE verified bit from GET /api/auth/me is false. */}
      {loggedIn && !emailVerified ? (
        <div className="d-verify-banner" data-testid="verify-banner">
          <Alert
            variant="warn"
            title={L("邮箱未验证", "Email unverified")}
            icon={<Icon name="mail" size={16} />}
          >
            <div className="d-verify-banner__row">
              <span>
                {L(
                  "验证你的邮箱可锁定它归你所有；在此之前所有功能照常可用。",
                  "Verify your email to lock it to your account; everything works as usual until then.",
                )}
              </span>
              {resendState === "sent" ? (
                <span className="ax-label d-verify-banner__sent">{L("已重新发送", "Resent")}</span>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={resendState === "sending"}
                  onClick={resendVerification}
                >
                  {resendState === "sending" ? L("发送中…", "Sending…") : L("重新发送", "Resend")}
                </Button>
              )}
            </div>
          </Alert>
        </div>
      ) : null}

      {/* 设置浮层 (§12/§14/§17) — since DS 0.8.0 it's a floating SettingsSheet over the designer
          (账户 + 集成 tabs), NOT a route page. Opened from the AccountControl (avatar → 账户;
          「集成设置」→ 集成) via guard → openSettings, which reflects a /settings URL via history.
          Mounted only while open so the 集成 fetch fires on open + the designer state is untouched
          underneath; ✕ / Esc → closeSettings restores the prior URL. */}
      {settingsOpen ? (
        <SettingsOverlay
          open
          section={settingsSection}
          onNavigate={setSettingsSection}
          onClose={closeSettings}
          user={{ email: userEmail || "", displayName: userDisplayName }}
          onLogout={doLogout}
          onNeedLogin={needLoginFromSettings}
          onProfileSaved={onProfileSaved}
          getConfig={getConfig}
          saveConfig={saveConfig}
          testConnections={testConnections}
          updateProfile={updateProfile}
        />
      ) : null}

      {/* 「我的表单」 management panel (§21). Mounted unconditionally (inert when closed). */}
      <FormsPanel
        open={formsOpen}
        onClose={() => setFormsOpen(false)}
        onNeedLogin={() => {
          setFormsOpen(false);
          needLogin(L("登录后查看你发布的表单", "Sign in to view the forms you've published"));
        }}
        listForms={listForms}
        updateForm={updateForm}
        deleteForm={deleteForm}
        getFormForEdit={getFormForEdit}
        onEditForm={loadFormForEdit}
        publicFormUrl={publicFormUrl}
        listSubmissions={listSubmissions}
      />

      {/* 放弃保护 (PR-7): 编辑态有未保存改动时退出 → 二次确认。继续编辑→留在编辑态；放弃改动→
          doExit 清回干净草稿（线上版本不受影响，已安全存在「我的表单」里）。 */}
      <AlertDialog
        open={discardOpen}
        tone="warn"
        title={L("放弃本次编辑？", "Discard these edits?")}
        description={L(
          `你对《${meta?.title || editingForm?.meta?.title || L("这份表单", "this form")}》的改动还没「更新」，退出后不会保存；已发布的版本保持不变。`,
          `Your changes to “${meta?.title || editingForm?.meta?.title || L("这份表单", "this form")}” haven't been saved. Exiting won't keep them; the published version stays unchanged.`,
        )}
        cancelLabel={L("继续编辑", "Keep editing")}
        confirmLabel={L("放弃改动", "Discard")}
        onCancel={() => setDiscardOpen(false)}
        onConfirm={doExit}
      />

      {/* Publish feedback (§16): opened by 发布/分享, publishes the live model and shows the
          public fill link. onPublished flips the header badge to LIVE; a 401 routes into login. */}
      <PublishFeedback
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        onNeedLogin={() => {
          setPublishOpen(false);
          needLogin(L("登录后即可发布表单", "Sign in to publish your form"));
        }}
        meta={meta}
        fields={fields}
        publishForm={publishForm}
        publicFormUrl={publicFormUrl}
        onPublished={(res) => {
          setPublished(true);
          // 发布把 slug 关联进会话行 (§26.2)，session id 不变：记下 slug 并立刻持久化一次，
          // 这样即便不再发新回合，刷新后会话也已带上该 slug。
          if (res && res.slug) {
            publishedSlugRef.current = res.slug;
            persistTurn();
          }
        }}
      />
    </React.Fragment>
  );
}
