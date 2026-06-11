// App.jsx — App shell: header, split layout, live agent loop (streamed prose +
// tool-call cards over POST /api/chat), schema view, share dialog.
// All chrome composed from @agentaily/design-system.
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Badge,
  IconButton,
  Button,
  Tabs,
  Dialog,
  SchemaDisplay,
  Queue,
  Suggestions,
} from "@agentaily/design-system";

import { Icon, ChatThread, ChatComposer } from "./chat.jsx";
import { FormPreview } from "./preview.jsx";
import { MarkupLayer } from "./markup.jsx";
import { LoginDialog } from "./auth.jsx";
import { SettingsDialog } from "./settings.jsx";
import { MessageQueue } from "./core/queue";
import { createFormModel, applyDesignerTool, uid, DESIGNER_SYSTEM } from "./core/designerTools";
import { runDesignerTurn } from "./core/designerLoop";
import { streamDesignerChat } from "./core/designerChat";
import { ApiError } from "./core/apiClient";
import { isLoggedIn as authIsLoggedIn } from "./core/auth";

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

export default function App({
  chat = streamDesignerChat,
  login,
  logout,
  // Integration-settings client (SPEC §12/§14). Defaults to the real configClient
  // functions inside SettingsDialog; injectable here so App-level tests can drive
  // the 401 → close-settings + open-login wiring deterministically (same seam as
  // chat/login/logout). Left undefined → SettingsDialog uses its own defaults.
  getConfig,
  saveConfig,
  testConnections,
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
  const [shareOpen, setShareOpen] = useState(false);
  const [published, setPublished] = useState(false);
  // owner session (SPEC §17): logged-in unlocks the owner-only /api/chat proxy.
  const [loggedIn, setLoggedIn] = useState(() => authIsLoggedIn());
  const [loginOpen, setLoginOpen] = useState(false);
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
            <IconButton label="分享" onClick={() => setShareOpen(true)}>
              <Icon name="share" size={15} />
            </IconButton>
          ) : (
            <Button
              variant="secondary"
              icon={<Icon name="share" size={14} />}
              onClick={() => setShareOpen(true)}
            >
              分享
            </Button>
          )}
          <Button
            variant="primary"
            icon={<Icon name="spark" size={14} />}
            disabled={building || fieldCount === 0}
            onClick={() => {
              setPublished(true);
              setShareOpen(true);
            }}
          >
            发布
          </Button>
        </div>
      </header>

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
        logout={logout}
        onClose={() => setLoginOpen(false)}
        onLoggedIn={() => setLoggedIn(true)}
        onLoggedOut={() => setLoggedIn(false)}
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

      <Dialog
        open={shareOpen}
        title={published ? "表单已发布" : "分享这份表单"}
        onClose={() => setShareOpen(false)}
        footer={
          <Button
            variant="primary"
            icon={<Icon name="check" size={14} />}
            onClick={() => setShareOpen(false)}
          >
            复制链接
          </Button>
        }
      >
        <div className="d-share-body">
          <div className="d-qr">
            <Icon name="qr" size={92} />
          </div>
          <div className="d-share">
            <div className="ax-label">公开链接</div>
            <div className="d-share__url">forms.agentaily.dev/agentaily-salon-sh</div>
            <p className="d-share__note">
              任何拿到链接的人都可以填写。提交将实时进入「数据」后台。
            </p>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
