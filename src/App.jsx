// App.jsx — App shell: header, split layout, scripted runner, schema, share dialog.
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
} from "@agentaily/design-system";

import { buildScript, intentReply, uid, INITIAL_META } from "./flow.jsx";
import { Icon, ChatThread, ChatComposer } from "./chat.jsx";
import { FormPreview } from "./preview.jsx";
import { MarkupLayer } from "./markup.jsx";
import { MessageQueue } from "./core/queue";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export default function App() {
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
  // single-column mobile layout (≤720px): one pane at a time via the sub-bar.
  const isMobile = useMediaQuery("(max-width: 720px)");
  const [mobileView, setMobileView] = useState("chat");
  // continuous-send buffer (SPEC §4.1): pending messages shown above the composer.
  const [queueItems, setQueueItems] = useState([]);
  const draggingRef = useRef(false);
  // Latest fields, read inside async turns so a buffered batch sees current state.
  const fieldsRef = useRef(fields);
  // Whether the first message has bootstrapped the form (single scripted build).
  const initRef = useRef(false);
  // Always points at the latest onSend. The scripted runner stores suggestion
  // handlers in message state at build time; routing them through this ref keeps
  // them from capturing a stale onSend (one that still sees fields=[]/meta=null).
  const onSendRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", t.theme === "light" ? "light" : "dark");
  }, [t.theme]);
  useEffect(() => {
    fieldsRef.current = fields;
  }, [fields]);

  const setValue = useCallback((id, v) => setValuesState((s) => ({ ...s, [id]: v })), []);
  const pushMsg = (m) => {
    const id = uid("msg");
    setMessages((ms) => [...ms, { id, ...m }]);
    return id;
  };
  const patchMsg = (id, patch) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  const clearNew = (fid) =>
    setTimeout(
      () => setFields((fs) => fs.map((f) => (f.id === fid ? { ...f, _new: false } : f))),
      600,
    );

  const runBuild = async (brief) => {
    for (const step of buildScript(brief)) {
      if (step.t === "reasoning") {
        const id = pushMsg({
          role: "assistant",
          kind: "reasoning",
          steps: step.steps,
          duration: step.duration,
          streaming: true,
        });
        await sleep(1500);
        patchMsg(id, { streaming: false });
        await sleep(350);
      } else if (step.t === "text") {
        const id = pushMsg({
          role: "assistant",
          kind: "text",
          text: step.text,
          streaming: true,
          suggestions: step.suggestions,
          onSuggest: (s) => onSendRef.current(s),
        });
        await sleep(Math.min(1100, 350 + step.text.length * 14));
        patchMsg(id, { streaming: false });
        await sleep(250);
      } else if (step.t === "meta") {
        setMeta(INITIAL_META);
        await sleep(500);
      } else if (step.t === "field") {
        const fld = { ...step.field, id: uid("fld"), _new: true };
        const tid = pushMsg({
          role: "assistant",
          kind: "tool",
          name: "add_field",
          args: {
            type: fld.type,
            label: fld.label,
            ...(fld.options ? { options: fld.options } : {}),
            required: !!fld.required,
          },
          result: fld._say,
          status: "running",
        });
        await sleep(360);
        setFields((fs) => [...fs, fld]);
        clearNew(fld.id);
        patchMsg(tid, { status: "done" });
        await sleep(300);
      }
    }
  };

  // apply a single resolved intent to form state (no chat side-effects)
  const applyIntent = (r) => {
    if (r.kind === "add") {
      const fld = { ...r.field, id: uid("fld"), _new: true };
      setFields((fs) => {
        const ci = fs.findIndex((x) => x.type === "consent");
        if (ci >= 0) {
          const n = [...fs];
          n.splice(ci, 0, fld);
          return n;
        }
        return [...fs, fld];
      });
      clearNew(fld.id);
    } else if (r.kind === "remove") {
      setFields((fs) => fs.slice(0, -1));
    } else if (r.kind === "require") {
      setFields((fs) =>
        fs.map((f) =>
          r.match && f.label.includes(r.match) ? { ...f, required: true, _new: true } : f,
        ),
      );
      if (r.match) setTimeout(() => setFields((fs) => fs.map((f) => ({ ...f, _new: false }))), 700);
    } else if (r.kind === "meta") {
      setMeta((m) => ({ ...m, ...r.set }));
    } else if (r.kind === "publish") {
      setPublished(true);
    }
  };

  // process a BUFFER of follow-up prompts together: one set of tool calls, one
  // combined reply (not one reply per message).
  const runBatch = async (texts) => {
    await sleep(280);
    const results = texts.map((tx) => intentReply(tx, { fields: fieldsRef.current }));
    for (const r of results) {
      if (!r.tool) continue;
      const tid = pushMsg({
        role: "assistant",
        kind: "tool",
        name: r.tool.name,
        args: r.tool.args,
        result: r.tool.result,
        status: "running",
      });
      await sleep(420);
      applyIntent(r);
      patchMsg(tid, { status: "done" });
      await sleep(160);
    }
    const text =
      results.length === 1
        ? results[0].text
        : "好，这几处我一起改好了：" + results.map((r) => r.text).join(" ");
    const id = pushMsg({ role: "assistant", kind: "text", text, streaming: true });
    await sleep(Math.min(1100, 400 + text.length * 14));
    patchMsg(id, { streaming: false });
    if (results.some((r) => r.kind === "publish")) setShareOpen(true);
  };

  // One message queue for the whole session: connect-send N times → exactly one
  // consumer loop; the first message bootstraps the form (single scripted build),
  // everything after is drained as a BUFFER — whatever accumulated flushes together.
  // `bufferRef` mirrors the queue's atomic flush so the scripted runner can render
  // the exact per-message texts the consumer is processing this turn.
  const queueRef = useRef(null);
  const bufferRef = useRef([]);
  if (!queueRef.current) {
    const q = new MessageQueue(async () => {
      const texts = bufferRef.current;
      bufferRef.current = [];
      texts.forEach((tx) => pushMsg({ role: "user", text: tx }));
      setBuilding(true);
      try {
        if (!initRef.current) {
          initRef.current = true;
          // first turn: bootstrap from the first prompt only; any extras buffered
          // in the same flush get handled as a follow-up batch right after.
          await runBuild(texts[0]);
          if (texts.length > 1) await runBatch(texts.slice(1));
        } else {
          await runBatch(texts);
        }
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
  onSendRef.current = onSend;

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
            onClick={() => onSend("发布并生成链接")}
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
