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
  DesignerShell,
  ConversationThread,
  AccountControl,
  MarkupLayer,
} from "@agentaily/design-system";

import { Icon, renderChatTurn } from "./chat.jsx";
import { FormPreview } from "./preview.jsx";
import { SettingsScreen } from "./settings.jsx";
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
  matchSettings,
  currentPathname,
  currentSearch,
  SIGNIN_PATH,
  SETTINGS_PATH,
} from "./core/router";
import { MessageQueue } from "./core/queue";
import { createFormModel, applyDesignerTool, uid, DESIGNER_SYSTEM } from "./core/designerTools";
import { runDesignerTurn } from "./core/designerLoop";
import { streamDesignerChat } from "./core/designerChat";
import { ApiError } from "./core/apiClient";
import {
  getOrCreateDesignSessionId,
  loadChatSession as loadChatSessionClient,
  saveChatTurns as saveChatTurnsClient,
  toPersistedTurns,
} from "./core/chatSessionClient";
import {
  isLoggedIn as authIsLoggedIn,
  logout as authLogout,
  requestEmailVerification as authRequestEmailVerification,
  getCurrentUser as authGetCurrentUser,
} from "./core/auth";

// gated actions resumed after a round-trip to the standalone /signin page, keyed by a
// serializable id (a function can't survive a full-page navigation).
const AUTH_INTENT_KEY = "agentaily_auth_intent";

// Fixed follow-up prompt chips surfaced once a form exists (a product affordance, not
// model output) — keeps "继续改" discoverable. ConversationThread has no persistent
// followups slot, so they ride the closing assistant turn and render via the DS
// Suggestions in renderChatTurn; clicking one routes back through onSend → the queue.
const FOLLOWUPS = ["加一个备注字段", "把手机号设为必填", "换个封面文案"];

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

// ── 路由分流挂载点 (第 6 步, SPEC §16.4.1 / §17 / §23.6 / §24.5) ─────────────────
// The app's ONE route split (no react-router — see src/core/router.ts). App reads the
// current pathname + search (injectable for tests) and mounts ONE bare page when a
// public/auth route matches, else the full designer:
//   • /f/:slug             → <PublicFormPage>   — the bare answerer view (公开填写).
//   • /signin              → <SignInScreen>     — the standalone owner login page (§17).
//   • /settings            → <SettingsScreen>   — the owner 集成设置 page (§12 + §14).
//   • /reset-password?token= → <ResetPasswordPage> — set a new password (§24.5).
//   • /verify-email?status=  → <VerifyEmailPage>    — show the verify result (§23.6).
//   • anything else        → the full designer (<DesignerApp>) below.
// Each landing page is chrome-less: NO chat / preview / publish frame, and (except the
// owner-only /settings page, which DOES carry the owner Bearer to read/write config) NO
// token held on the page (reset/verify I/O is public). This wrapper decides with no hooks
// before the branch, so routes never share hook order. Tests drive the split by passing
// explicit `pathname` / `search` (and may inject per-route seams).
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
  if (matchSettings(pathname)) {
    // The 集成设置 page (§12 + §14) — owner-only. Thread the config seams + navigate so
    // App-level tests drive getConfig/saveConfig/testConnections and the 401 → /signin.
    return (
      <SettingsScreen
        getConfig={rest.getConfig}
        saveConfig={rest.saveConfig}
        testConnections={rest.testConnections}
        navigate={rest.navigate}
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
  // Forms publish + management client (SPEC §16/§21). Defaults to the real formsClient
  // inside FormsPanel/PublishFeedback; injectable here for the publish/401 flow.
  publishForm,
  listForms,
  updateForm,
  deleteForm,
  publicFormUrl,
  // 数据后台「看提交」(§18). Defaults to the real submissionsClient; injectable for tests.
  listSubmissions,
  // 设计对话持久化 (§26, owner-only). Defaults to the real chatSessionClient; injectable so
  // the load-on-mount / save-at-turn-end wiring is driven deterministically in tests.
  loadChatSession = loadChatSessionClient,
  saveChatTurns = saveChatTurnsClient,
  // 邮箱未验证 banner 的「重新发送」(§23.3 owner-only). Defaults to the real
  // core/auth.requestEmailVerification (POST with Bearer); injectable for tests.
  requestEmailVerification = authRequestEmailVerification,
  // Authoritative 邮箱验证状态 + 账户 read (§23.6 owner-only): GET /api/auth/me →
  // { email, emailVerified }, fail-soft to null. Injectable so banner/account tests stay
  // deterministic.
  getCurrentUser = authGetCurrentUser,
  // logout seam — drops the owner session. Defaults to the real core/auth.logout.
  logout = authLogout,
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
  // Publish feedback (§16) + 「我的表单」 management panel (§21).
  const [publishOpen, setPublishOpen] = useState(false);
  const [formsOpen, setFormsOpen] = useState(false);
  // owner session (SPEC §17): logged-in unlocks the owner-only /api/chat proxy. `loggedIn`
  // is the token-presence bit (read on mount); `userEmail` is filled from GET /api/auth/me.
  const [loggedIn, setLoggedIn] = useState(() => authIsLoggedIn());
  const [userEmail, setUserEmail] = useState(null);
  // 邮箱验证状态 (§23.6). AUTHORITATIVE bit from GET /api/auth/me — fetched on mount (when
  // logged in). Defaults to `true` (no banner) so a failed/null `me` never flashes a banner.
  const [emailVerified, setEmailVerified] = useState(true);
  // 重新发送 反馈: "" | "sending" | "sent".
  const [resendState, setResendState] = useState("");
  // continuous-send buffer (SPEC §4.1): pending messages shown above the composer.
  const [queueItems, setQueueItems] = useState([]);
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
      if (e.status === 401) return "请先登录 owner 后再使用对话设计。";
      return e.message || `对话服务出错（${e.status}）。`;
    }
    return "无法连接到对话服务，请检查网络或后端地址（VITE_API_BASE）。";
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
  // A 401 mid-action means the owner session lapsed — drop it and route into login.
  const needLogin = (reason) => {
    setLoggedIn(false);
    goSignIn(reason ? { reason } : {});
  };
  // Run a resolved intent now (signed-in). Mirrors the gated actions below. 集成设置 is a
  // full navigation to its own /settings page (since DS 0.6.0 dropped the in-app modal);
  // publish/share/forms stay in-app overlays.
  const dispatchIntent = (id) => {
    if (id === "publish" || id === "share") setPublishOpen(true);
    else if (id === "forms") setFormsOpen(true);
    else if (id === "settings") navigate(SETTINGS_PATH);
  };
  // Gate an action behind auth: signed-in → run now; signed-out → bounce through /signin.
  // 集成设置 is its own page, so a signed-out owner is sent to /signin?return=/settings and
  // lands straight on the settings page after login (no stashed intent needed). The in-app
  // overlays (publish/share/forms) instead stash the intent and resume on the same page.
  const guard = (intentId, reason) => {
    if (loggedIn) {
      dispatchIntent(intentId);
      return;
    }
    if (intentId === "settings") {
      goSignIn({ return: SETTINGS_PATH, ...(reason ? { reason } : {}) });
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
    // logging out drops the session — hide the banner (no owner to verify).
    setEmailVerified(true);
    setResendState("");
  };

  // Pull the AUTHORITATIVE 验证状态 + 账户邮箱 from GET /api/auth/me (§23.6). getCurrentUser
  // is fail-soft (resolves null on 401 / network), so on a null we leave state as-is.
  const refreshMe = useCallback(async () => {
    const me = await getCurrentUser();
    if (me) {
      setEmailVerified(me.emailVerified);
      setUserEmail(me.email);
    }
  }, [getCurrentUser]);

  // On mount (when logged in) read me once so the banner + account control reflect the
  // real session. Logged-out sessions have nothing to read, so we skip.
  useEffect(() => {
    if (loggedIn) refreshMe();
  }, [loggedIn, refreshMe]);

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
        if (Array.isArray(session.turns) && session.turns.length > 0) {
          setMessagesTracked(session.turns.map((tn) => ({ ...tn })));
        }
        if (Array.isArray(session.history) && session.history.length > 0) {
          // Re-seed the loop's LLM history verbatim (incl. the system message) so the
          // Agent continues with full context (§26.6 / 「Agent 记得之前的上下文」).
          historyRef.current = session.history.map((h) => ({ ...h }));
        }
        if (session.formSlug) publishedSlugRef.current = session.formSlug;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) needLogin("登录后恢复你的设计对话");
        // else: best-effort — leave the empty thread; the next save re-establishes the row.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn]);

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
      if (e instanceof ApiError && e.status === 401) needLogin("登录后重新发送验证邮件");
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
      if (e instanceof ApiError && e.status === 401) needLogin("登录后继续对话设计");
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
    const input = {
      turns: toPersistedTurns(messagesRef.current),
      history: historyRef.current,
      ...(publishedSlugRef.current ? { formSlug: publishedSlugRef.current } : {}),
    };
    Promise.resolve(saveChatTurns(sessionIdRef.current, input)).catch((e) => {
      if (e instanceof ApiError && e.status === 401) needLogin("登录后继续对话设计");
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

  const fieldCount = fields.length;

  return (
    <React.Fragment>
      <DesignerShell
        crumb="forms"
        split={t.split / 100}
        onSplitChange={(f) => setTweak("split", Math.round(f * 100))}
        minSplit={0.32}
        maxSplit={0.64}
        title={
          <React.Fragment>
            <span style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
              活动报名 · 未命名表单
            </span>
            <Badge variant={published ? "ok" : "neutral"} dot>
              {published ? "LIVE" : "DRAFT"}
            </Badge>
          </React.Fragment>
        }
        actions={
          <React.Fragment>
            <IconButton
              label="切换主题"
              onClick={() => setTweak("theme", t.theme === "dark" ? "light" : "dark")}
            >
              <Icon name={t.theme === "dark" ? "sun" : "moon"} size={15} />
            </IconButton>
            <Button
              variant="secondary"
              icon={<Icon name="share" size={14} />}
              onClick={() => guard("share", "登录后即可分享表单并收集回复")}
            >
              分享
            </Button>
            <Button
              variant="primary"
              icon={<Icon name="spark" size={14} />}
              disabled={building || fieldCount === 0}
              onClick={() => guard("publish", "登录后即可发布表单")}
            >
              发布
            </Button>
          </React.Fragment>
        }
        account={
          <AccountControl
            user={loggedIn ? { email: userEmail || "" } : null}
            onLogin={() => goSignIn({})}
            onLogout={doLogout}
            items={[
              {
                label: "我的表单",
                icon: <Icon name="folder" size={15} />,
                onSelect: () => guard("forms", "登录后查看你发布的表单"),
              },
              {
                label: "集成设置",
                icon: <Icon name="settings" size={15} />,
                onSelect: () => guard("settings", "登录后配置集成"),
              },
            ]}
          />
        }
        mobileLabels={{
          chat: (
            <React.Fragment>
              <Icon name="message" size={15} /> 对话
            </React.Fragment>
          ),
          preview: (
            <React.Fragment>
              <Icon name="eye" size={15} /> 预览{" "}
              {fieldCount ? <span className="ax-dshell__mcount">{fieldCount}</span> : null}
            </React.Fragment>
          ),
        }}
        chat={
          <ConversationThread
            title="对话"
            model="agentaily-2 · forms"
            messages={messages}
            draft={draft}
            onDraftChange={setDraft}
            controller={controller}
            renderTurn={(m, i, ctx) => renderChatTurn(m, ctx, onSend)}
            emptyTitle="描述你想要的表单"
            hints={["做一个线下活动报名表", "收集一份客户满意度问卷", "招聘投递表单"]}
            placeholder="描述你想要的表单，例如：做一个活动报名表…"
            busyPlaceholder="可继续输入，会收进缓冲区一起处理…"
            note="AGENTAILY 会出错 · 发布前请核对字段"
          />
        }
        preview={
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div className="ax-dshell__panebar">
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
                    <Icon name="pen" size={13} />
                  </IconButton>
                  <span className="d-devtoggles">
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

      {/* 集成设置 (§12/§14) is no longer an in-app modal — since DS 0.6.0 it's a standalone
          /settings page (matchSettings in the App route split → <SettingsScreen>). The
          account-menu「集成设置」item navigates there via guard("settings"). */}

      {/* 「我的表单」 management panel (§21). Mounted unconditionally (inert when closed). */}
      <FormsPanel
        open={formsOpen}
        onClose={() => setFormsOpen(false)}
        onNeedLogin={() => {
          setFormsOpen(false);
          needLogin("登录后查看你发布的表单");
        }}
        listForms={listForms}
        updateForm={updateForm}
        deleteForm={deleteForm}
        publicFormUrl={publicFormUrl}
        listSubmissions={listSubmissions}
      />

      {/* Publish feedback (§16): opened by 发布/分享, publishes the live model and shows the
          public fill link. onPublished flips the header badge to LIVE; a 401 routes into login. */}
      <PublishFeedback
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        onNeedLogin={() => {
          setPublishOpen(false);
          needLogin("登录后即可发布表单");
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
