// App.jsx — App shell. Since the design system shipped its full page/chat surfaces
// (0.4.0), the two-pane frame is the DS DesignerShell, the chat column is the DS
// ConversationThread (pure render + external controller), the account control is the
// DS AccountControl, and 指向修改 is the DS MarkupLayer — the hand-written shell /
// thread / composer / markup are gone. The real engineering stays: the live agent loop
// (streamed prose + tool-call cards over POST /api/chat), the §4.1 continuous-send
// MessageQueue (wrapped as the ConversationThread controller), the publish surface
// (发布 = 直接动作 → POST /api/forms → ShareDialog；分享 = 只读取链接), integration settings, forms mgmt,
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

import { ThemeProvider, useTheme } from "@agentaily/design-system";
import { L, getLocale, setLocale } from "./core/i18n";
import { Icon, renderChatTurn } from "./chat.jsx";
import { FormPreview } from "./preview.jsx";
import { SettingsOverlay } from "./settings.jsx";
import { FormsPanel } from "./forms-panel.jsx";
import { ShareDialog } from "./share-dialog.jsx";
import { PublicFormPage } from "./public-form.jsx";
import { ResetPasswordPage } from "./reset-password.jsx";
import { VerifyEmailPage } from "./verify-email.jsx";
import { SignInScreen } from "./signin.jsx";
import {
  matchPublicForm,
  matchResetPassword,
  matchVerifyEmail,
  matchSignIn,
  matchSettings,
  settingsPath,
  readSessionId,
  withSessionId,
  readProjectId,
  projectBasePath,
  currentPathname,
  currentSearch,
  SIGNIN_PATH,
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
  publishForm as defaultPublishForm,
  publicFormUrl as defaultPublicFormUrl,
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
  renameChatSession as renameChatSessionClient,
  toPersistedTurns,
} from "./core/chatSessionClient";
import {
  readStoredProjectId,
  setActiveProjectId,
  newProjectId,
  loadProject as loadProjectClient,
  saveProjectWorkspace as saveProjectWorkspaceClient,
  listProjects as listProjectsClient,
} from "./core/projectClient";
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
  validateSession as authValidateSession,
} from "./core/auth";
import { AuthGate } from "./auth-gate.jsx";

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
// Tweaks panel; here they're plain app state — split is the only user-driven one, the
// rest are fixed product defaults. NOTE: theme is NOT here — it's owned by design-system's
// <ThemeProvider> (cross-subdomain persistence + FOUC), read/written via useTheme().
const UI_DEFAULTS = {
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
//   • anything else (incl. /settings) → the full designer, BEHIND the entry guard (<AuthGate>).
// Each landing page is chrome-less: NO chat / preview / publish frame, and NO token held on
// the page (reset/verify I/O is public). 集成/账户设置 (§12 + §14 + §17) is NO LONGER a bare
// route page since DS 0.8.0 — it is a FLOATING OVERLAY (<SettingsOverlay>) that DesignerApp
// opens over itself, reflecting a /settings URL via history WITHOUT unmounting the designer.
// So /settings falls through to the gated designer, which opens the overlay on that path
// (deep-link) and restores the prior page on close. This wrapper decides with no hooks before
// the branch, so routes never share hook order. Tests drive the split by passing explicit
// `pathname` / `search` (and may inject per-route seams).
//
// 未登录守卫 (设计源 _QB7NM8v, SPEC §17/§23.6): the designer is a PROTECTED page, so it mounts
// behind <AuthGate> — a single client-side guard that runs a real GET /api/auth/me (via
// {@link checkSession}) BEFORE instantiating any designer content, and routes on the result:
// 401/无 token → in-place 登录视图 (reuse <SignInScreen>, no white-flash redirect); 5xx/网络
// → neutral 重试 placeholder; 200 → the designer (其内 emailVerified 决定软提醒条,§23.6 不硬墙).
// Zero protected-content flash for unauthorized users. The public/auth routes above are NOT
// gated (they ARE the login / public surfaces). 行为级 401 兜底 (会话中途失效) 仍由 DesignerApp 的
// guard()/needLogin 处理 (bounce to /signin → re-login → 守卫原地重跑); the entry guard is additive.
// App shell entry. Wrap the whole route tree in design-system's <ThemeProvider> so the persisted
// theme (cross-subdomain cookie `agentaily:theme`, default dark; localhost falls back to
// localStorage) drives `data-theme` on EVERY route, and the designer's theme toggle (useTheme)
// has its context. The matching FOUC inline script is injected into index.html at build/dev
// (vite.config themeInitScript({defaultTheme:"dark"})), byte-identical to the marketing site —
// so first paint is already correct and ThemeProvider only re-affirms it (no flash).
export default function App(props) {
  return (
    <ThemeProvider defaultTheme="dark">
      <AppRoutes {...props} />
    </ThemeProvider>
  );
}

function AppRoutes({
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
  // 入口守卫的会话校验 seam (未登录守卫): default = the real discriminated validateSession
  // (真 GET /api/auth/me → authed | unauthed | error). Injectable so outer-loop specs drive the
  // three entry paths deterministically without mocking the network layer.
  checkSession = authValidateSession,
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
  // /settings (and /settings/:tab) fall through here: DesignerApp opens the settings overlay when
  // the path is a settings route (deep-link) and reflects it via history on open/close/switch.
  // `pathname` + `search` are threaded so the overlay's initial tab AND the active design session
  // (?s=<id>) both match the URL on mount (PR #76). Mounted behind the entry guard: a signed-out /
  // expired owner never sees the designer (zero-flash), only the in-place 登录视图; a check error
  // shows the neutral 重试 placeholder. On 登录成功 the guard re-validates IN PLACE (no full reload).
  return (
    <AuthGate
      check={checkSession}
      renderSignIn={(onSignedIn) => <SignInScreen search="" navigate={() => onSignedIn()} />}
    >
      {() => <DesignerApp pathname={pathname} search={search} {...rest} />}
    </AuthGate>
  );
}

function DesignerApp({
  chat = streamDesignerChat,
  // Forms publish + management client (SPEC §16/§21). 发布是 App 顶栏「发布」的直接动作
  // (POST /api/forms)，故默认拿真 formsClient；listForms/updateForm/deleteForm 仍透传给
  // FormsPanel（其内部各自默认）。injectable here for the publish/401 flow.
  publishForm = defaultPublishForm,
  listForms,
  updateForm,
  deleteForm,
  // 载回设计器编辑 (PR-7): FormsPanel pulls a form's full meta+fields via getFormForEdit,
  // App writes edits back via updateFormDefinition (PATCH meta+fields). Default to the real
  // formsClient; injectable so the edit/load/写回-401 flow is driven deterministically.
  getFormForEdit = defaultGetFormForEdit,
  updateFormDefinition = defaultUpdateFormDefinition,
  publicFormUrl = defaultPublicFormUrl,
  // 数据后台「看提交」(§18). Defaults to the real submissionsClient; injectable for tests.
  listSubmissions,
  // 设计对话持久化 (§26, owner-only). Defaults to the real chatSessionClient; injectable so
  // the load-on-mount / save-at-turn-end wiring is driven deterministically in tests.
  loadChatSession = loadChatSessionClient,
  saveChatTurns = saveChatTurnsClient,
  // 多会话列表 + 删除 + 重命名 (§26.9/§26.10, owner-only). Same injection pattern: default to the
  // real client; injectable so the SessionMenu (list / new / switch / delete / rename) wiring是 driven
  // by fakes.
  listChatSessions = listChatSessionsClient,
  deleteChatSession = deleteChatSessionClient,
  renameChatSession = renameChatSessionClient,
  // 项目级工作区 (A' 项目↔对话, §26.10, owner-only). The form workspace (meta + fields) belongs to
  // the PROJECT, loaded/saved independently of the conversation (replaces #76's snapshot turn).
  // Injectable so the「载项目填工作区 / 切对话工作区不变 / 刷新恢复」wiring is driven deterministically.
  loadProject = loadProjectClient,
  saveProjectWorkspace = saveProjectWorkspaceClient,
  listProjects = listProjectsClient,
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
  testConnection,
  updateProfile = authUpdateProfile,
  // Initial path (from App's route split). When it is a /settings/:tab route the overlay opens
  // on mount (deep-link) on that tab; otherwise the overlay starts closed.
  pathname = currentPathname(),
  // Initial query string (from App's route split). Carries the active design session id
  // (?s=<id>, PR #76) restored on mount; defaults to the live location for production.
  search = currentSearch(),
  // navigation seam for the standalone /signin redirect (full nav by default; injectable
  // so tests assert the target without a real reload).
  navigate = (url) => {
    window.location.href = url;
  },
} = {}) {
  const [t, setTweak] = useUiState(UI_DEFAULTS);
  // Theme is owned by design-system's <ThemeProvider> (cross-subdomain persistence + FOUC); the
  // header toggle reads/writes it here. resolvedTheme is the concrete light|dark in effect.
  const { resolvedTheme, setTheme } = useTheme();
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
  // 发布 / 分享浮层 (§16, N-_ayo8x): 仅链接、无二维码。发布是顶栏「发布」的直接动作 (doPublish)
  // —— POST /api/forms 直接上线，成功后以 "publish" 模式弹「表单已发布」；分享是只读 (openShare)，
  // 以 "share" 模式取当前已发布表单的公开链接，不改状态、不发任何对话消息。
  const [shareOpen, setShareOpen] = useState(false);
  const [shareMode, setShareMode] = useState("publish");
  const [shareUrl, setShareUrl] = useState("");
  // 发布进行中(防连点) + 后端拒绝发布时的「对话外」提示(如缺标题 400)。不往对话发消息(N-_ayo8x)。
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");
  // 「我的表单」 management panel (§21).
  const [formsOpen, setFormsOpen] = useState(false);
  // 设置浮层 (§12 + §14 + §17) — a floating SettingsSheet over the designer (NOT a route page).
  // Opening reflects a /settings/:tab URL via history WITHOUT unmounting the designer; a deep-link
  // to /settings/account|integrations starts it open ON THAT TAB (PR #76). `settingsSection` is the
  // active tab (账户 / 集成), now ALSO reflected in the URL (path segment), so a refresh / deep-link
  // / Back-Forward lands on the right tab. The designer stays mounted underneath, so closing
  // restores the prior page (incl. the active session ?s=).
  const initialSettings = matchSettings(pathname);
  const [settingsOpen, setSettingsOpen] = useState(() => !!initialSettings);
  const [settingsSection, setSettingsSection] = useState(
    () => initialSettings?.section ?? "integrations",
  );
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
  // 重新发送 反馈: "" | "sending"（"sent" 终态已由下面的冷却倒计时取代,见新顶部 .vb 设计 §23.6）。
  const [resendState, setResendState] = useState("");
  // 重新发送冷却秒数 (§23.6 新设计 .vb / .acct-verify): 一次成功重发后置 30,逐秒 -1,期间按钮禁用并
  // 显示「重新发送 · {n}s」,防连点。0 表示可再次发送。
  const [cooldown, setCooldown] = useState(0);
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

  // 项目进 URL (A' 项目↔对话, §26.10). The stable, client-minted design PROJECT id (keyed
  // (owner_id, projectId)) — the container for the shared form workspace. Resolution order on mount,
  // mirroring the session-id resolution below:
  //   1. the URL's /p/:projectId path (a refresh / deep-link / shared link names the project) — make
  //      it active (localStorage + mirror) so a subsequent reload without touching the URL resumes it.
  //   2. else the prior active project from localStorage (resume where the owner left off).
  //   3. else mint a FRESH project — but mark it (freshProjectRef) so the logged-in mount restore can
  //      first try to RESUME the owner's most-recent SERVER project (listProjects, §A' cutover): an
  //      existing / just-migrated owner opening a bare URL should land on their data, not an empty new
  //      project. Only when the owner truly has no projects does the fresh one stick.
  const projectIdRef = useRef(null);
  // Marks "projectIdRef was freshly minted (no URL, no prior localStorage)" → the mount restore tries
  // listProjects() to resume the most-recent server project before committing to this fresh id.
  const freshProjectRef = useRef(false);
  if (!projectIdRef.current) {
    const fromUrl = readProjectId(pathname);
    if (fromUrl) {
      setActiveProjectId(fromUrl);
      projectIdRef.current = fromUrl;
    } else {
      const stored = readStoredProjectId();
      if (stored) {
        setActiveProjectId(stored);
        projectIdRef.current = stored;
      } else {
        projectIdRef.current = newProjectId();
        freshProjectRef.current = true;
      }
    }
  }

  // 设计对话持久化 (§26) + 会话进 URL (PR #76 + A'). The stable, client-minted design session id
  // (keyed (owner_id, projectId, sessionId)) — a conversation thread UNDER the active project.
  // Resolution order on first mount:
  //   1. the URL's ?s=<id> (a refresh / deep-link / shared link names the conversation) — make it
  //      active (localStorage + mirror) so a subsequent reload without touching the URL still resumes.
  //   2. else getOrCreate (a localStorage-backed PLACEHOLDER until the mount restore resolves the
  //      project's most-recent conversation — A':「进项目载最近对话」, see the restore effect).
  // A blank/invalid ?s= falls through to getOrCreate (degrade, never throw).
  const sessionIdRef = useRef(null);
  if (!sessionIdRef.current) {
    const fromUrl = readSessionId(search);
    if (fromUrl) {
      setActiveDesignSessionId(fromUrl);
      sessionIdRef.current = fromUrl;
    } else {
      sessionIdRef.current = getOrCreateDesignSessionId();
    }
  }
  // The published form's slug once this session's form is published (§26.2): carried on every
  // subsequent turn-end save so the session row gets associated; null before publish.
  const publishedSlugRef = useRef(null);
  // Guard so the load-on-mount restore runs exactly once per logged-in mount (§26 restore).
  const restoredRef = useRef(false);
  // Monotonic load-sequence token (PR #76): every async session load (mount restore + switch +
  // popstate) bumps this and captures its own number; after the await it applies its result ONLY if
  // it is still the latest load. Without it, two overlapping loads that resolve out of order let a
  // STALE result win — rendering (and then persisting via persistTurn) one session's transcript +
  // workspace under another session's id (a 不串会话 violation). See the out-of-order test.
  const loadSeqRef = useRef(0);
  // Always-current mirror of `messages` so the turn-end save reads the latest thread
  // without a stale closure (and without abusing a setState updater as a getter).
  const messagesRef = useRef([]);
  // Always-current mirror of `editingForm` (PR-7). The §4.1 queue consumer closure captures
  // the FIRST render's runTurn → persistTurn, so a state read there is stale; persistTurn must
  // check this ref to skip §26 persistence while editing (an edit conversation is ephemeral and
  // must NOT overwrite the form's design session — kept in sync by loadFormForEdit / doExit).
  const editingFormRef = useRef(null);

  // (theme → data-theme is applied by design-system's ThemeProvider; no local useEffect needed.)

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

  // ── 会话进 URL (?s=<id>, PR #76 + A') ───────────────────────────────────────────
  // Reflect the active design-session id in the URL, PRESERVING the rest of the query and the
  // current path (so the /p/:id project path + any /settings overlay are kept). pushState by default
  // (so Back returns to the prior conversation); replaceState for normalizations (not a nav). This is
  // the SESSION-only reflect — switching conversations changes only ?s= (A': workspace/path unchanged).
  const reflectSessionUrl = useCallback((id, { replace = false } = {}) => {
    if (typeof window === "undefined" || !window.history) return;
    const target = currentPathname() + withSessionId(currentSearch(), id);
    try {
      if (replace) window.history.replaceState(window.history.state, "", target);
      else window.history.pushState({}, "", target);
    } catch {
      /* history unavailable — sessionIdRef still drives this page */
    }
  }, []);

  // ── 项目 + 会话进 URL (/p/:projectId?s=<sessionId>, A') ───────────────────────────
  // Reflect BOTH the active project (path /p/:id) AND the active conversation (?s=) in one history
  // op, preserving the rest of the query. Used when ENTERING a project (mount restore / popstate /
  // 继续编辑) — switching projects reloads the workspace, so the path changes. pushState by default;
  // replaceState for mount-time normalization. A blank projectId keeps the current path (degrade).
  const reflectDesignerUrl = useCallback((projectId, sessionId, { replace = false } = {}) => {
    if (typeof window === "undefined" || !window.history) return;
    // Re-anchor the project in the path WITHOUT clobbering an open /settings/:tab overlay: when the
    // current path is a settings route, rebuild it nested under this project (/p/:id/settings/:tab);
    // otherwise the bare designer base (/p/:id). A blank projectId keeps the current path (degrade).
    let base;
    if (!projectId) base = currentPathname();
    else {
      const settingsRoute = matchSettings(currentPathname());
      base = settingsRoute
        ? settingsPath(settingsRoute.section, projectId)
        : projectBasePath(projectId);
    }
    const target = base + withSessionId(currentSearch(), sessionId);
    try {
      if (replace) window.history.replaceState(window.history.state, "", target);
      else window.history.pushState({}, "", target);
    } catch {
      /* history unavailable — projectIdRef/sessionIdRef still drive this page */
    }
  }, []);

  // On first mount, normalize the URL to /p/:projectId?s=:sessionId so a fresh "/" load (or a
  // localStorage-resumed project/session) becomes shareable/bookmarkable. A deep-link that already
  // names both (path + ?s= match) is left untouched. replaceState — a normalization, not a nav.
  // (When logged in, the restore effect re-reflects after resolving the project's most-recent
  // conversation; this initial pass covers the signed-out case + the first paint.)
  useEffect(() => {
    if (typeof window === "undefined" || !window.history) return;
    const pathHasProject = readProjectId(currentPathname()) === projectIdRef.current;
    const queryHasSession = readSessionId(currentSearch()) === sessionIdRef.current;
    if (!pathHasProject || !queryHasSession) {
      reflectDesignerUrl(projectIdRef.current, sessionIdRef.current, { replace: true });
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 设置浮层 open/close/switch (路由反映 /settings/:tab, 不卸载设计器, §12/§14/§17 + PR #76) ──
  // Track whether WE pushed the /settings history entry, so closing can step back to the prior
  // page (history.back) rather than stranding the owner. A deep-link (no push) closes to "/" + ?s=.
  const settingsPushedRef = useRef(false);
  // Reflect the active settings tab in the URL (/settings/:tab), PRESERVING ?s=. Entering settings
  // from a non-settings page pushes a new entry (so close can step back); switching tabs while
  // already in settings replaces in place (a tab toggle isn't a navigation).
  const reflectSettingsUrl = useCallback((section) => {
    if (typeof window === "undefined" || !window.history) return;
    // A': nest settings under the active project (/p/:id/settings/:tab) so the project stays in the
    // URL while the overlay is open; currentSearch keeps ?s=.
    const target = settingsPath(section, projectIdRef.current) + currentSearch();
    try {
      if (!matchSettings(currentPathname())) {
        window.history.pushState({ settings: true }, "", target);
        settingsPushedRef.current = true;
      } else {
        window.history.replaceState({ settings: true }, "", target);
      }
    } catch {
      /* history unavailable — the overlay still opens; just not URL-reflected */
    }
  }, []);
  const openSettings = useCallback(
    (sectionId) => {
      const section = sectionId === "account" ? "account" : "integrations";
      setSettingsSection(section);
      setSettingsOpen(true);
      reflectSettingsUrl(section);
    },
    [reflectSettingsUrl],
  );
  // Switch tab while the overlay is open (DS SettingsSheet onNavigate) → update state + URL in place.
  const navigateSettings = useCallback(
    (sectionId) => {
      const section = sectionId === "account" ? "account" : "integrations";
      setSettingsSection(section);
      reflectSettingsUrl(section);
    },
    [reflectSettingsUrl],
  );
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    if (typeof window === "undefined" || !window.history) return;
    if (settingsPushedRef.current) {
      settingsPushedRef.current = false;
      window.history.back(); // restore the pre-overlay URL (the designer never unmounted; ?s= returns)
    } else if (matchSettings(currentPathname())) {
      // Deep-linked straight to /settings/:tab (no prior entry to pop) → normalize to the designer at
      // /p/:projectId, preserving the active session in the URL (A').
      window.history.pushState({}, "", projectBasePath(projectIdRef.current) + currentSearch());
    }
  }, []);
  // Keep the overlay, the active PROJECT, AND the active conversation in sync with the URL for
  // Back/Forward (PR #76 + A'): the overlay follows /settings/:tab; the project follows the /p/:id
  // path (Back/Forward between projects reloads the workspace + that project's conversation); the
  // conversation follows ?s= (Back/Forward between conversations reloads only the thread — workspace
  // unchanged). PROJECT change takes precedence (it subsumes the conversation reload). Neither ever
  // crosses transcripts: each load applies its OWN target's turns under the load-sequence token.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPop = () => {
      const route = matchSettings(currentPathname());
      setSettingsOpen(!!route);
      if (route) setSettingsSection(route.section);
      else settingsPushedRef.current = false;
      const urlProject = readProjectId(currentPathname());
      const urlSession = readSessionId(currentSearch());
      if (urlProject && urlProject !== projectIdRef.current) {
        // The project changed (this IS the popstate) → reload workspace + the named/recent
        // conversation, without re-pushing the entry we just navigated to.
        enterProject(urlProject, { preferredSessionId: urlSession, urlMode: "none" });
      } else if (urlSession && urlSession !== sessionIdRef.current) {
        // Same project, different conversation → switch the thread only (workspace unchanged).
        switchSession(urlSession, { fromPopstate: true });
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // enterProject / switchSession are first-render closures (stable seams/refs), mirroring the queue
    // consumer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Return to the SAME settings tab after login (the stashed intent reopens it; the path makes
    // the post-login landing deterministic regardless of the current location).
    goSignIn({ return: settingsPath(settingsSection), ...(reason ? { reason } : {}) });
  };
  // Run a resolved intent now (signed-in). publish/share/forms stay in-app overlays; 集成设置 /
  // 账户 open the floating settings overlay on the matching tab (§12/§14/§17).
  const dispatchIntent = (id) => {
    // 发布 = 直接动作(直接上线 + 弹「已发布」分享浮层)；分享 = 只读(取已发布链接)。二者都不再开
    // 旧的「发布反馈」两步浮层、不往对话发消息。doPublish/openShare 定义在下方,运行时(用户点击)闭包可达。
    if (id === "publish") doPublish();
    else if (id === "share") openShare();
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
    setCooldown(0);
    closeSettings();
    // Drop the prior owner's in-memory workspace + conversation, and re-arm mount-restore (PR #76):
    // without this, a DIFFERENT owner logging in on the same tab would keep seeing the prior owner's
    // thread/form (the [loggedIn] restore effect is restoredRef-guarded, so it wouldn't re-run). Bump
    // loadSeqRef so any in-flight load can't apply after logout. `resetWorkspace` clears the live
    // model/thread; resetting restoredRef lets the next login restore the new owner's session.
    loadSeqRef.current++;
    resetWorkspace();
    restoredRef.current = false;
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

  // Apply a loaded persisted CONVERSATION onto the live thread (A'): rebuild the visible thread
  // (`messages`) AND re-seed the loop's LLM history (`historyRef`, incl. the leading system prompt)
  // so the owner resumes the same thread AND the Agent keeps the prior context (§26.6). Under A' this
  // touches ONLY the conversation — the form workspace (meta + fields) belongs to the PROJECT and is
  // restored separately by {@link applyProjectWorkspace}, so switching conversations never disturbs
  // the right pane (切对话工作区不变). Null/empty turns → an empty thread. Shared by the mount restore,
  // switchSession, and 继续编辑.
  const applyRestoredSession = (session) => {
    if (!session) return;
    const realTurns = Array.isArray(session.turns) ? session.turns : [];
    setMessagesTracked(realTurns.map((tn) => ({ ...tn })));
    historyRef.current =
      Array.isArray(session.history) && session.history.length > 0
        ? session.history.map((h) => ({ ...h }))
        : [{ role: "system", content: DESIGNER_SYSTEM }];
  };

  // Apply a loaded PROJECT workspace onto the live form model (A', §26.10): rebuild the right-pane
  // meta + fields from the project row, advance the uid counter past the loaded field ids (so a
  // freshly added field never collides with them), and carry the project's published slug. This is
  // the workspace half of restore — decoupled from the conversation, so 进项目载工作区 / 刷新恢复 /
  // 切项目换工作区 all flow through here while switchSession leaves it untouched. Tolerant of a
  // null/absent project (leaves the current model). Field shapes are defensively guarded (a stored
  // field may be malformed; never throw on restore).
  const applyProjectWorkspace = (project) => {
    if (!project) return;
    const loadedFields = Array.isArray(project.fields) ? project.fields : [];
    modelRef.current.meta = project.meta ? { ...project.meta } : null;
    modelRef.current.fields = loadedFields.map((f) => ({ ...f }));
    reserveUidsFrom(loadedFields.map((f) => f && f.id).filter(Boolean));
    publishedSlugRef.current = project.formSlug || null;
    setPublished(!!project.formSlug);
    // 刷新/进项目恢复『编辑态』(#87, #86 follow-up): 项目行带 formSlug ⇒ 它是对一份已发布表单的编辑,
    // 故同步重建 editingForm —— 顶栏 EDITING 横幅 + 主按钮『更新』(updateLiveForm → PATCH 原 slug)。
    // 不重建会让刷新后 editingForm 丢失 → 主按钮回『发布』(doPublish → POST 新表单),点击把这份已发布
    // 表单当新表单重发(新 slug)。项目行不存 form status(只有 formSlug),故 owner 可见态默认 published
    // (主流场景:继续编辑 / 刚发布的 LIVE 表单;更新 PATCH 不分 status);baseline = 刚载入的工作区(与
    // loadFormForEdit 同语义:刚载入即未脏,更新按钮到下一次改动才点亮)。无 formSlug ⇒ 草稿,清掉编辑态。
    if (project.formSlug) {
      const ef = { slug: project.formSlug, status: "published", meta: modelRef.current.meta };
      editingFormRef.current = ef;
      setEditingForm(ef);
      setEditBaseline(editSig(modelRef.current.meta, modelRef.current.fields));
      setUpdateDone(false);
    } else {
      editingFormRef.current = null;
      setEditingForm(null);
    }
    syncModel();
  };

  // Reset ONLY the conversation to a clean, empty thread (A'): empty thread + fresh LLM history. Does
  // NOT touch the form workspace (it belongs to the project — 新对话 / 切到空对话 keep编同一份表单) nor
  // editingForm/published. Used by 新对话, by switching to a never-persisted session, and by deleting
  // the active conversation.
  const resetConversation = () => {
    historyRef.current = [{ role: "system", content: DESIGNER_SYSTEM }];
    setMessagesTracked([]);
  };

  // Resolve the active conversation for a project and load it onto the thread (A'「进项目载最近对话」):
  // a deep-linked ?s= names it; else the project's MOST-RECENT conversation; else a fresh empty one.
  // Guarded by the caller's load-sequence token (`myLoad`) so an out-of-order arrival across the
  // project + conversation async chain can never clobber a newer load (§4.3 乱序防护覆盖两路异步).
  // Returns the resolved session id, or null if superseded mid-flight.
  const resolveAndLoadConversation = async (
    projectId,
    preferredSessionId,
    myLoad,
    fallbackSessionId = "",
  ) => {
    let sid = (preferredSessionId || "").trim();
    if (!sid) {
      const { sessions: list } = await listChatSessions(projectId);
      if (loadSeqRef.current !== myLoad) return null;
      // Most-recent conversation if any; else the caller's fallback (mount reuses the already-resolved
      // sessionIdRef so a bare load doesn't MINT a new session each time — no URL churn, and refresh
      // resumes the SAME conversation deterministically); else mint a fresh one.
      sid =
        Array.isArray(list) && list.length > 0
          ? list[0].sessionId
          : (fallbackSessionId || "").trim() || newDesignSessionId();
    }
    sessionIdRef.current = sid;
    setActiveDesignSessionId(sid);
    const { session } = await loadChatSession(projectId, sid);
    if (loadSeqRef.current !== myLoad) return null;
    if (session) applyRestoredSession(session);
    else resetConversation();
    return sid;
  };

  // 进项目 (A' core): make `projectId` active, load its workspace, resolve + load its active
  // conversation, and reflect /p/:id?s= in the URL. Used by the mount restore, by Back/Forward
  // between projects (popstate), and as the shared spine of restore. The whole flow shares ONE
  // load-sequence token so a superseding enter/switch/restore can't apply a stale workspace OR
  // conversation (covers both async legs). best-effort: a 401 routes into login; other failures
  // leave the prior state.
  //   urlMode: "replace" (mount normalization) | "push" (an explicit navigation) | "none" (popstate,
  //   the URL already changed → don't re-write it).
  const enterProject = async (
    projectId,
    { preferredSessionId = "", fallbackSessionId = "", urlMode = "replace" } = {},
  ) => {
    setActiveProjectId(projectId);
    projectIdRef.current = projectId;
    restoredRef.current = true; // we restore explicitly here, not via the mount effect
    const myLoad = ++loadSeqRef.current;
    try {
      const { project } = await loadProject(projectId);
      if (loadSeqRef.current !== myLoad || projectIdRef.current !== projectId) return;
      // Hit → rebuild the workspace; miss ({ project: null }) → a fresh empty workspace (a brand-new
      // or never-persisted project), NOT the prior one.
      if (project) applyProjectWorkspace(project);
      else {
        modelRef.current = createFormModel();
        publishedSlugRef.current = null;
        setPublished(false);
        syncModel();
      }
      const sid = await resolveAndLoadConversation(
        projectId,
        preferredSessionId,
        myLoad,
        fallbackSessionId,
      );
      if (sid == null) return; // superseded mid-flight
      if (urlMode !== "none")
        reflectDesignerUrl(projectId, sid, { replace: urlMode === "replace" });
      refreshSessions();
    } catch (e) {
      if (loadSeqRef.current !== myLoad) return; // superseded → ignore the stale error too
      if (e instanceof ApiError && e.status === 401)
        needLogin(L("登录后恢复你的设计项目", "Sign in to restore your design project"));
      // else: best-effort — leave the prior state; the next turn-end save re-establishes the rows.
    }
  };

  // 设计项目 + 对话恢复 (A' restore): when logged in, ENTER the active project ONCE — load its
  // workspace (right pane) AND its active conversation (left pane, named by ?s= or the most-recent),
  // then normalize the URL to /p/:id?s=. A never-persisted project → empty workspace; a never-
  // persisted conversation → empty thread. Signed-out owners never load (§26.5). A 401 routes into
  // /signin. restoredRef (set inside enterProject) keeps StrictMode's double-invoke + the empty-deps
  // effect from re-entering.
  useEffect(() => {
    if (!loggedIn || restoredRef.current) return;
    restoredRef.current = true; // guard StrictMode's double-invoke + the empty-deps re-fire (we resolve once)
    (async () => {
      let projectId = projectIdRef.current;
      // A' cutover: a FRESHLY-minted project (no URL, no prior localStorage) → first try to RESUME the
      // owner's most-recent SERVER project (updated_at DESC), so an existing / just-migrated owner
      // opening a bare URL lands on their data instead of an empty new project. Keep the fresh id only
      // when the owner truly has no projects (or the lookup fails — best-effort).
      if (freshProjectRef.current) {
        try {
          const { projects } = await listProjects();
          if (Array.isArray(projects) && projects.length > 0) {
            projectId = projects[0].projectId;
            projectIdRef.current = projectId;
            setActiveProjectId(projectId);
          }
        } catch {
          /* best-effort — keep the freshly-minted project */
        }
      }
      enterProject(projectId, {
        preferredSessionId: readSessionId(search),
        // Bare load (no ?s=, no sessions yet) reuses the first-render-resolved session id (the
        // localStorage-backed designSessionId) instead of minting a fresh one — no URL churn on mount,
        // and a refresh resumes the SAME conversation deterministically (fixes an e2e flake). When we
        // resumed a different project above, that project's own most-recent session wins (list lookup
        // inside enterProject), so this fallback only applies to a genuinely empty project.
        fallbackSessionId: sessionIdRef.current,
        urlMode: "replace",
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn]);

  // 会话列表 (§26.9 + A'): pull THIS PROJECT's conversations for the SessionMenu (project-scoped).
  // best-effort — a load failure (incl. transient) just keeps the prior list; a 401 routes into
  // /signin.
  const refreshSessions = useCallback(async () => {
    if (!loggedIn) return;
    try {
      const { sessions: list } = await listChatSessions(projectIdRef.current);
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

  // ── 多会话 新建 / 切换 / 删除 / 重命名 (§26.9 + A') ──────────────────────────────
  // Reset the WHOLE live workspace to a clean, empty designer (form model + conversation): used by
  // logout (drop the prior owner's everything) and by doExit's fresh-draft start. `restoredRef` is
  // set so the mount-restore effect never re-fires.
  const resetWorkspace = () => {
    restoredRef.current = true; // a fresh project has nothing to restore
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

  // 新对话 (A'): mint + activate a brand-new conversation id UNDER the current project (so turn-end
  // saves write a NEW session row), clear ONLY the conversation — the form workspace stays (继续编同一
  //份表单). Reflect the new ?s= in the URL (pushState → Back returns to the prior conversation),
  // refresh the list.
  const newChat = () => {
    sessionIdRef.current = newDesignSessionId();
    restoredRef.current = true;
    resetConversation();
    reflectSessionUrl(sessionIdRef.current);
    refreshSessions();
  };

  // 切换对话 (A' core): make `id` the active conversation, load + apply ITS transcript, reflect ?s=,
  // refresh the list. The workspace is UNTOUCHED — switching conversations only swaps the left pane
  // (切对话工作区不变). A 401 routes into login; any other failure leaves the prior thread.
  // `fromPopstate`: the URL already names `id` → don't re-push (would clobber the navigated entry).
  const switchSession = async (id, { fromPopstate = false } = {}) => {
    if (!id || id === sessionIdRef.current) return;
    setActiveDesignSessionId(id);
    sessionIdRef.current = id;
    restoredRef.current = true; // we restore explicitly here, not via the mount effect
    const myLoad = ++loadSeqRef.current; // claim the latest-load slot (不串会话)
    if (!fromPopstate) reflectSessionUrl(id);
    try {
      const { session } = await loadChatSession(projectIdRef.current, id);
      // Bail if a NEWER switch/restore superseded this one while we awaited — applying a stale load
      // would render (then persist) this conversation's turns under whatever session is now active.
      if (loadSeqRef.current !== myLoad) return;
      // Hit → rebuild that conversation. Miss ({ session: null }, e.g. a stale list row) → reset to
      // an EMPTY conversation (NOT the workspace): sessionIdRef already moved to `id`, so leaving the
      // prior thread visible would let the next save write the OLD transcript under the new id.
      if (session) applyRestoredSession(session);
      else resetConversation();
    } catch (e) {
      if (loadSeqRef.current !== myLoad) return; // superseded → ignore the stale error too
      if (e instanceof ApiError && e.status === 401)
        needLogin(L("登录后切换你的设计对话", "Sign in to switch your design conversation"));
      // else: best-effort — leave the prior thread.
    }
    refreshSessions();
  };

  // 删除对话 (A'): remove the conversation server-side (project-scoped); if it was the ACTIVE one,
  // open a fresh empty conversation IN THE SAME PROJECT (workspace stays). Refresh the list either
  // way. A 404 (foreign / never-existed) is swallowed (the row drops off on refresh); a 401 routes
  // into login.
  const removeSession = async (id) => {
    if (!id) return;
    try {
      await deleteChatSession(projectIdRef.current, id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        needLogin(L("登录后管理你的设计对话", "Sign in to manage your design conversations"));
        return;
      }
      // 404 / other: best-effort — fall through to a list refresh (the row drops off).
    }
    if (id === sessionIdRef.current) {
      // deleting the open conversation → start a fresh one (workspace stays). replaceState so the
      // deleted conversation doesn't linger as a forward-navigable entry.
      sessionIdRef.current = newDesignSessionId();
      resetConversation();
      reflectSessionUrl(sessionIdRef.current, { replace: true });
    }
    refreshSessions();
  };

  // 重命名对话 (§26.10 A'): PATCH the conversation's title, then refresh the list so the new label
  // shows. best-effort — a 404 (foreign / never-existed) is swallowed; a 401 routes into login.
  const renameSession = async (id, title) => {
    const next = (title || "").trim();
    if (!id || !next) return;
    try {
      await renameChatSession(projectIdRef.current, id, next);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        needLogin(L("登录后重命名你的设计对话", "Sign in to rename your design conversation"));
        return;
      }
      // 404 / other: best-effort — fall through to a list refresh.
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

  // 重新发送冷却倒计时 (§23.6 新设计 .vb / .acct-verify): cooldown>0 时每秒 -1 直到 0。
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // 重新发送验证邮件 (§23.3, owner-only). Always succeeds when authenticated; on resolve we
  // start a 30s 冷却 (the new 顶部 .vb / acct-verify design surfaces 「重新发送 · {n}s」 instead of
  // a terminal「已重新发送」). A 401 means the session lapsed — route into login.
  const resendVerification = async () => {
    if (resendState === "sending" || cooldown > 0) return;
    setResendState("sending");
    try {
      await requestEmailVerification();
      setResendState("");
      setCooldown(30);
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

  // Persist the current turn-end snapshot (A', §26.3/§26.4 + §26.10) as TWO decoupled writes:
  //   1) the CONVERSATION → the project-scoped session row: the complete UI thread (serialized to
  //      PersistedTurn[], `streaming` stripped) + the loop's LLM history (incl. system). Reads the
  //      latest thread from `messagesRef` so a just-settled turn is included.
  //   2) the WORKSPACE → the PROJECT row: the current form model (meta + fields, `_new` stripped) +
  //      the published slug. This REPLACES PR #76's snapshot-turn-on-turns_json — the workspace now
  //      lives on its own project row so 切对话 leaves it untouched and 刷新 restores it via loadProject.
  // Under A' editing is NO LONGER skipped: an edit conversation IS the project's conversation, so it
  // persists like any other (this fixes the「继续编辑后刷新对话丢」bug — the old editingFormRef skip
  // dropped every edit-mode turn). best-effort: a non-401 failure does NOT break the page (the next
  // turn's full PUT overwrites idempotently); a 401 routes into /signin (§26.4 失败不阻断 + 401 例外).
  const persistTurn = () => {
    if (!loggedIn) return; // 未登录不持久化 (§26.5)
    const projectId = projectIdRef.current;
    const sessionId = sessionIdRef.current;
    const slug = publishedSlugRef.current;
    const onError = (e) => {
      if (e instanceof ApiError && e.status === 401)
        needLogin(L("登录后继续对话设计", "Sign in to continue conversational design"));
      // else: best-effort, swallow — the next turn-end PUT overwrites (§26.4).
    };
    // 1) conversation → session row (project-scoped).
    const convoInput = {
      turns: toPersistedTurns(messagesRef.current),
      history: historyRef.current,
      ...(slug ? { formSlug: slug } : {}),
    };
    Promise.resolve(saveChatTurns(projectId, sessionId, convoInput)).catch(onError);
    // 2) workspace → project row (only when non-empty — an empty model has nothing to restore, mirrors
    // #76's「空模型不写快照」; strip the transient `_new` animation flag so persisted JSON is stable).
    const meta = modelRef.current.meta ?? null;
    const cleanFields = (modelRef.current.fields ?? []).map(({ _new, ...rest }) => rest);
    if (meta || cleanFields.length > 0) {
      Promise.resolve(
        saveProjectWorkspace(projectId, {
          meta,
          fields: cleanFields,
          ...(slug ? { formSlug: slug } : {}),
        }),
      ).catch(onError);
    }
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

  // ── 表单编辑入口 (PR-7 + A' 进项目) ──────────────────────────────────────────────
  // 「继续编辑」a stored form = ENTER that form's PROJECT (A', §4.4). Resolve the project by reverse-
  // looking the published slug up in listProjects; if none exists (a form published BEFORE A', no
  // project yet) mint a fresh project and associate the slug. Then: load the form's current
  // definition into the project workspace (authoritative for editing) + persist it to the project,
  // and load the project's MOST-RECENT conversation as the real chat (A':「去掉合成『已载入』开场白」).
  // The edit-mode UI (banner + 更新/重新发布 button + dirty baseline) is kept; what's GONE under A' is
  // the persistence skip — an edit conversation IS the project's conversation now (fixes the「继续编辑
  // 后刷新对话丢」bug). The canonical model is replaced so agent tool calls mutate THIS form; field
  // ids are kept verbatim (so a write-back matches a changed label as a rename, not delete+add).
  const loadFormForEdit = async (form) => {
    if (!form) return;
    setFormsOpen(false);
    const loadedMeta = form.meta ? { ...form.meta } : null;
    const loadedFields = (form.fields || []).map((f) => ({ ...f }));
    reserveUidsFrom(loadedFields.map((f) => f.id).filter(Boolean));
    // Resolve the project for this form (reverse-lookup by slug; else mint + associate, §4.4 兜底).
    let projectId = null;
    try {
      const { projects } = await listProjects();
      projectId = (Array.isArray(projects) ? projects : []).find(
        (p) => p.formSlug === form.slug,
      )?.projectId;
    } catch {
      /* best-effort — fall through to mint a fresh project for this form */
    }
    if (projectId) setActiveProjectId(projectId);
    else projectId = newProjectId();
    projectIdRef.current = projectId;
    restoredRef.current = true; // we set the project up explicitly, not via the mount restore
    const myLoad = ++loadSeqRef.current; // claim the latest-load slot (covers the conversation load)
    // Workspace = the form's current definition (authoritative). Replace the canonical model + mirror.
    modelRef.current.meta = loadedMeta ? { ...loadedMeta } : null;
    modelRef.current.fields = loadedFields.map((f) => ({ ...f }));
    publishedSlugRef.current = form.slug;
    // Edit-mode UI (banner + 更新 button + dirty baseline) — NO persistence skip under A'.
    const ef = { slug: form.slug, status: form.status, meta: loadedMeta };
    editingFormRef.current = ef;
    setEditingForm(ef);
    setMeta(loadedMeta);
    setFields(loadedFields);
    setValuesState({});
    setPublished(form.status === "published");
    setUpdateDone(false);
    setDiscardOpen(false);
    setPublishError("");
    setEditBaseline(editSig(loadedMeta, loadedFields));
    setTab("preview");
    // Persist the workspace to the project BEFORE we reflect /p/:projectId in the URL — and AWAIT it
    // (was fire-and-forget). 漏网 bug: on the mint path (no existing project for this slug) this PUT is
    // the ONLY workspace write; if the URL advanced to /p/:id while it was still in flight, a refresh
    // navigated to /p/:id and ABORTED the pending PUT → the project row was never written → loadProject
    // read back null → 工作台空. Awaiting here means the URL only ever exposes /p/:id AFTER the row is
    // durable, so any refresh into /p/:id restores the workspace. A 401 routes into login; other
    // failures stay best-effort (the next turn-end save re-establishes the row) but we still tried
    // synchronously before exposing the URL.
    try {
      await saveProjectWorkspace(projectId, {
        meta: loadedMeta,
        fields: loadedFields.map(({ _new, ...rest }) => rest),
        formSlug: form.slug,
      });
    } catch (e) {
      if (loadSeqRef.current !== myLoad) return; // superseded mid-flight → drop the stale error too
      if (e instanceof ApiError && e.status === 401) {
        needLogin(L("登录后继续编辑你的表单", "Sign in to continue editing your form"));
        return;
      }
      /* best-effort — the next turn-end save re-establishes the project row */
    }
    if (loadSeqRef.current !== myLoad) return; // a newer load superseded us during the save
    // Load the project's most-recent conversation as the REAL chat (no synthetic「已载入」note).
    try {
      const { sessions: list } = await listChatSessions(projectId);
      if (loadSeqRef.current !== myLoad) return; // superseded
      if (Array.isArray(list) && list.length > 0) {
        sessionIdRef.current = list[0].sessionId;
        setActiveDesignSessionId(sessionIdRef.current);
        const { session } = await loadChatSession(projectId, sessionIdRef.current);
        if (loadSeqRef.current !== myLoad) return;
        if (session) applyRestoredSession(session);
        else resetConversation();
      } else {
        sessionIdRef.current = newDesignSessionId();
        resetConversation();
      }
    } catch (e) {
      if (loadSeqRef.current !== myLoad) return;
      if (e instanceof ApiError && e.status === 401) {
        needLogin(L("登录后继续编辑你的表单", "Sign in to continue editing your form"));
        return;
      }
      // best-effort — fall back to a fresh empty conversation in this project.
      sessionIdRef.current = newDesignSessionId();
      resetConversation();
    }
    reflectDesignerUrl(projectId, sessionIdRef.current); // push /p/:id?s= (Back returns to my-forms)
    refreshSessions();
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

  // ── 发布 = 直接动作 (N-_ayo8x) ────────────────────────────────────────────────────
  // 点顶栏「发布」不再开「发布反馈」浮层让人在里面再点一次发布,而是直接把当前设计器表单上线
  // (POST /api/forms → 高熵 slug),它即刻出现在「我的表单」并开始收集；随后把这份刚发布的表单
  // 置为「正在编辑的已发布表单」—— 复用既有的 编辑态横幅 + 「更新」机制 (editingForm/editBaseline),
  // 让作者可以继续改并点「更新」写回；最后弹「表单已发布」分享浮层 (仅链接)。全程不往对话发任何消息。
  //
  // 读 modelRef (canonical model) 而非 React 的 meta/fields:对话驱动发布时 §4.1 队列消费闭包捕获
  // 的是首渲染的 state,会过期；canonical model 始终最新。
  const doPublish = async () => {
    const m = modelRef.current.meta;
    const fs = modelRef.current.fields;
    if (building || publishing || !fs || fs.length === 0) return;
    setPublishing(true);
    setPublishError("");
    try {
      const res = await publishForm(m, fs);
      setPublished(true);
      const url = (res && res.url) || publicFormUrl(res.slug);
      // A' (§4.1): associate the slug onto the active PROJECT (+ its conversation) and persist once.
      // persistTurn now writes BOTH the conversation row AND the project workspace row carrying the
      // slug, so「我的表单 → 继续编辑」reverse-resolves back to this project by slug.
      publishedSlugRef.current = res.slug;
      persistTurn();
      // 接上既有 编辑/更新 机制:把刚发布的表单设为当前编辑目标(已发布态),记下内容基线 →
      // 顶栏主按钮从「发布」变「更新」,编辑态横幅出现,「更新」按钮在有改动时可点。带上已解析的
      // 公开 url(优先后端 ready-to-open url),这样事后「分享」取的链接与发布弹窗显示一致。
      const ef = { slug: res.slug, status: "published", meta: m ? { ...m } : null, url };
      editingFormRef.current = ef;
      setEditingForm(ef);
      setEditBaseline(editSig(m, fs));
      setUpdateDone(false);
      // 弹「表单已发布」分享浮层(庆祝式,仅链接)。
      setShareUrl(url);
      setShareMode("publish");
      setShareOpen(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        needLogin(L("登录后即可发布表单", "Sign in to publish your form"));
      } else {
        // 后端拒绝(如缺标题 400)→ 顶栏下方「对话外」提示后端原话,顶栏状态仍为草稿(不发对话消息)。
        setPublishError(
          e instanceof ApiError
            ? e.message
            : L("发布失败，请稍后重试。", "Publish failed — please try again."),
        );
      }
    } finally {
      setPublishing(false);
    }
  };

  // 分享 = 只读 (N-_ayo8x): 取当前已发布表单的公开填写链接弹「分享这份表单」浮层,不改任何状态、
  // 不发任何对话消息。仅在有「正在编辑的已发布表单」时可用(顶栏分享按钮也只在编辑态出现)。
  const openShare = () => {
    if (!editingForm) return;
    // 优先用发布时解析好的 url(可能是后端自定义域),否则按 slug 拼 —— 与发布弹窗显示一致。
    setShareUrl(editingForm.url || publicFormUrl(editingForm.slug));
    setShareMode("share");
    setShareOpen(true);
  };

  // 退出编辑 (A'): leave the edited form's project and start a FRESH DRAFT project (the edited form is
  // safe in 我的表单). Mint a new project + conversation, clear the workspace + thread, and reflect the
  // new /p/:id?s= in the URL. Clearing the editing ref re-arms the (now always-on) persistence for
  // the fresh draft; resetting history + slug keeps the new project clean of the edited form's context.
  const doExit = () => {
    editingFormRef.current = null;
    setEditingForm(null);
    setUpdateDone(false);
    setDiscardOpen(false);
    setEditBaseline("");
    setPublishError("");
    // Start a fresh draft PROJECT + conversation (new ids → next saves write new rows).
    projectIdRef.current = newProjectId();
    sessionIdRef.current = newDesignSessionId();
    restoredRef.current = true; // a fresh project has nothing to restore
    publishedSlugRef.current = null;
    historyRef.current = [{ role: "system", content: DESIGNER_SYSTEM }];
    modelRef.current = createFormModel();
    setMeta(null);
    setFields([]);
    setValuesState({});
    setPublished(false);
    setMessagesTracked([]);
    reflectDesignerUrl(projectIdRef.current, sessionIdRef.current);
    refreshSessions();
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
      <div className="app-stack">
        {/* 邮箱未验证条 (§23.6) — 新设计:贴 app 最顶的「内联条」(不是底部浮层),把下面的设计器往下推。
            登录且 AUTHORITATIVE 验证位为 false 时显示:脉冲「待验证」点 + 「验证邮件已发送至 <email>…」+
            带冷却的「重新发送」。消费 DS Button,i18n 走 L()。见 DESIGN.md 的 .vb。 */}
        {loggedIn && !emailVerified ? (
          <div className="vb" data-testid="verify-banner">
            <span className="vb__tag">
              <span className="vb__dot" />
              {L("待验证", "UNVERIFIED")}
            </span>
            <span className="vb__txt">
              {L("验证邮件已发送至 ", "A verification email was sent to ")}
              <strong className="vb__email">{userEmail}</strong>
              {L("，点击邮件中的链接以完成验证。", " — click the link inside to finish verifying.")}
            </span>
            <span className="vb__actions">
              <Button
                size="sm"
                variant="secondary"
                disabled={resendState === "sending" || cooldown > 0}
                onClick={resendVerification}
              >
                {resendState === "sending"
                  ? L("发送中…", "Sending…")
                  : cooldown > 0
                    ? L("重新发送 · ", "Resend · ") + cooldown + "s"
                    : L("重新发送", "Resend")}
              </Button>
            </span>
          </div>
        ) : null}
        {/* 发布失败提示 (N-_ayo8x): 发布是直接动作,失败(如缺标题 400)时不发对话消息,而是在这里贴一条
            可关闭的「对话外」提示,显示后端原话;顶栏状态保持草稿。消费 DS Alert + Button。 */}
        {publishError ? (
          <div className="d-publish-error" data-testid="publish-error">
            <Alert
              variant="danger"
              title={L("发布失败", "Publish failed")}
              icon={<Icon name="warn" size={16} />}
            >
              <div className="d-publish-error__row">
                <span>{publishError}</span>
                <Button size="sm" variant="secondary" onClick={() => setPublishError("")}>
                  {L("知道了", "Dismiss")}
                </Button>
              </div>
            </Alert>
          </div>
        ) : null}
        <div className="app-stack__main">
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
                {/* 语言快切 (handoff P9-DW3zm header) — 主题/分享旁的一键切换:zh 显示「EN」、en 显示
                    「中」(点了去到的那个语言)。setLocale → i18n.js 写 localStorage + reload。 */}
                <IconButton
                  label={L("切换语言", "Switch language")}
                  onClick={() => setLocale(getLocale() === "en" ? "zh" : "en")}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: "0.04em",
                    }}
                  >
                    {L("EN", "中")}
                  </span>
                </IconButton>
                <IconButton
                  label={L("切换主题", "Toggle theme")}
                  onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
                >
                  <Icon name={resolvedTheme === "dark" ? "sun" : "moon"} size={15} />
                </IconButton>
                {editingForm ? (
                  // 分享 = 只读 (N-_ayo8x): 仅在已发布/编辑态出现,取当前表单的公开链接弹分享浮层,
                  // 不改任何状态、不发任何对话消息(故无需 guard —— 进编辑态本就已登录)。
                  <Button
                    variant="secondary"
                    icon={<Icon name="share" size={14} />}
                    onClick={openShare}
                  >
                    {L("分享", "Share")}
                  </Button>
                ) : null}
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
                  // 发布 = 直接动作: guard 先把未登录的弹去 /signin(回来后 resume → doPublish),已登录直接
                  // doPublish(上线 + 进编辑态 + 弹「已发布」分享浮层)。disabled 仍守空表单/构建中/发布中。
                  <Button
                    variant="primary"
                    icon={<Icon name="spark" size={14} />}
                    disabled={building || fieldCount === 0 || publishing}
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
                user={
                  loggedIn ? { email: userEmail || "", name: userDisplayName || undefined } : null
                }
                onLogin={() => goSignIn({})}
                onLogout={doLogout}
                // DS 0.14 headless 化了 AccountControl 的可见文案(默认翻成英文);中文产品需用
                // 现成 L() DSL 把 copy 传回来(还原 DS 0.13 中文,行为零变化)。signInLabel 略 → 走 copy.signIn。
                copy={{
                  signIn: L("登录", "Sign in"),
                  menuLabel: L("账户菜单", "Account menu"),
                  signedIn: L("已登录账户", "Signed in"),
                  signOut: L("退出登录", "Sign out"),
                }}
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
                  title={
                    // A' (§5): the header title is the ACTIVE conversation's name (rename-able via the
                    // SessionMenu row). Falls back to「对话」for an unnamed/never-listed thread.
                    sessions.find((s) => s.sessionId === sessionIdRef.current)?.title ||
                    L("对话", "Chat")
                  }
                  model={chatModelPill(chatModel)}
                  onModelClick={() => setModelMenuOpen((o) => !o)}
                  actions={
                    <SessionMenu
                      sessions={sessions}
                      activeId={sessionIdRef.current}
                      onNewChat={newChat}
                      onSelect={switchSession}
                      onDelete={removeSession}
                      onRename={renameSession}
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
                              <li>
                                {L("改动在「更新」后保存", "Changes are saved after “Update”")}
                              </li>
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
                                {L(
                                  "编辑期间表单仍在收集",
                                  "The form keeps collecting while you edit",
                                )}
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
        </div>
      </div>

      {/* 设置浮层 (§12/§14/§17) — since DS 0.8.0 it's a floating SettingsSheet over the designer
          (账户 + 集成 tabs), NOT a route page. Opened from the AccountControl (avatar → 账户;
          「集成设置」→ 集成) via guard → openSettings, which reflects a /settings URL via history.
          Mounted only while open so the 集成 fetch fires on open + the designer state is untouched
          underneath; ✕ / Esc → closeSettings restores the prior URL. */}
      {settingsOpen ? (
        <SettingsOverlay
          open
          section={settingsSection}
          onNavigate={navigateSettings}
          onClose={closeSettings}
          user={{ email: userEmail || "", displayName: userDisplayName }}
          onLogout={doLogout}
          onNeedLogin={needLoginFromSettings}
          onProfileSaved={onProfileSaved}
          getConfig={getConfig}
          saveConfig={saveConfig}
          testConnection={testConnection}
          updateProfile={updateProfile}
          // 邮箱验证状态 (§23.6) — 账户 tab 的 acct-verify 内联卡 + 验证 Badge 用。
          emailVerified={emailVerified}
          onResendVerification={resendVerification}
          resendCooldown={cooldown}
          resending={resendState === "sending"}
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

      {/* 发布 / 分享浮层 (§16, N-_ayo8x): 仅链接、无二维码。"publish" = 刚「发布」直接上线(庆祝式
          标题「表单已发布」),"share" = 已发布事后只读取链接(标题「分享这份表单」)。开合 + 模式 + 链接
          由上面的 doPublish / openShare 设置;复制按钮行内反馈,不关闭浮层。 */}
      <ShareDialog
        open={shareOpen}
        mode={shareMode}
        url={shareUrl}
        onClose={() => setShareOpen(false)}
      />
    </React.Fragment>
  );
}
