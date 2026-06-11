// App.jsx — App shell: header, split layout, scripted runner, schema, share dialog.
// All chrome composed from @agentaily/design-system.
import React, { useState, useEffect, useRef, useCallback } from "react";
import { Badge, IconButton, Button, Tabs, Dialog, SchemaDisplay } from "@agentaily/design-system";

import { buildScript, intentReply, uid, INITIAL_META } from "./flow.jsx";
import { Icon, ChatThread, ChatComposer } from "./chat.jsx";
import { FormPreview } from "./preview.jsx";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// UI state for the designer. In the design prototype these were exposed through a
// Tweaks panel; here they're plain app state — theme + split are user-driven, the
// rest are fixed product defaults.
const UI_DEFAULTS = {
  theme: "dark",
  split: 46,
  density: "comfortable",
  formStyle: "card",
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
  const [shareOpen, setShareOpen] = useState(false);
  const [published, setPublished] = useState(false);
  const draggingRef = useRef(false);
  // Always points at the latest onSend. The scripted runner stores suggestion
  // handlers in message state at build time; routing them through this ref keeps
  // them from capturing a stale onSend (one that still sees fields=[]/meta=null).
  const onSendRef = useRef(null);

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
  const clearNew = (fid) =>
    setTimeout(
      () => setFields((fs) => fs.map((f) => (f.id === fid ? { ...f, _new: false } : f))),
      600,
    );

  const runBuild = async (brief) => {
    setBuilding(true);
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
    setBuilding(false);
  };

  const runFollowup = async (text) => {
    setBuilding(true);
    await sleep(250);
    const r = intentReply(text, { fields });
    if (r.tool) {
      const tid = pushMsg({
        role: "assistant",
        kind: "tool",
        name: r.tool.name,
        args: r.tool.args,
        result: r.tool.result,
        status: "running",
      });
      await sleep(500);
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
        if (r.match)
          setTimeout(() => setFields((fs) => fs.map((f) => ({ ...f, _new: false }))), 700);
      } else if (r.kind === "meta") {
        setMeta((m) => ({ ...m, ...r.set }));
      } else if (r.kind === "publish") {
        setPublished(true);
      }
      patchMsg(tid, { status: "done" });
      await sleep(250);
    }
    const id = pushMsg({ role: "assistant", kind: "text", text: r.text, streaming: true });
    await sleep(Math.min(1000, 350 + r.text.length * 16));
    patchMsg(id, { streaming: false });
    setBuilding(false);
    if (r.kind === "publish") setShareOpen(true);
  };

  const onSend = (override) => {
    const text = (override != null ? override : draft).trim();
    if (!text || building) return;
    setDraft("");
    pushMsg({ role: "user", text });
    if (fields.length === 0 && !meta) runBuild(text);
    else runFollowup(text);
  };
  onSendRef.current = onSend;

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
          <span className="d-top__mark">◆</span>
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
          <Button
            variant="secondary"
            icon={<Icon name="share" size={14} />}
            onClick={() => setShareOpen(true)}
          >
            分享
          </Button>
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

      <div className="d-split">
        <section className="d-pane d-pane--chat" style={{ width: t.split + "%" }}>
          <ChatThread
            messages={messages}
            empty={empty}
            onStarter={(c) => onSend(c)}
            density={t.density}
          />
          <div className="d-foot">
            <ChatComposer
              value={draft}
              onChange={setDraft}
              onSend={() => onSend()}
              disabled={building}
              placeholder={
                empty ? "描述你想要的表单，例如：做一个活动报名表…" : "继续描述要怎么改…"
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
              </div>
            ) : null}
          </div>

          <div className="d-pvbody ax-dotgrid">
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
