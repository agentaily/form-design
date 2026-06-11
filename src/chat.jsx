// chat.jsx — chat side, composed entirely from @agentaily/design-system components.
// Exports: Icon, ChatThread, ChatComposer
import React, { useRef, useEffect } from "react";
import {
  Message,
  Reasoning,
  ToolCall,
  Composer,
  Suggestions,
  Alert,
} from "@agentaily/design-system";

// ---- Lucide-geometry icons (brand-sanctioned: copy paths, never freehand) ----
const ICON_PATHS = {
  send: (
    <g>
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </g>
  ),
  spark: <path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3z" />,
  share: (
    <g>
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13" />
    </g>
  ),
  sun: (
    <g>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </g>
  ),
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  eye: (
    <g>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </g>
  ),
  code: <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />,
  check: <path d="M20 6 9 17l-5-5" />,
  layout: (
    <g>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </g>
  ),
  phone: (
    <g>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </g>
  ),
  qr: (
    <g>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3M21 14v.01M14 21h.01M21 17v4" />
    </g>
  ),
  x: <path d="M18 6 6 18M6 6l12 12" />,
  arrow: <path d="M5 12h14M12 5l7 7-7 7" />,
  lock: (
    <g>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </g>
  ),
  user: (
    <g>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </g>
  ),
  markup: (
    <g>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" />
    </g>
  ),
  target: (
    <g>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 1v3M12 20v3M1 12h3M20 12h3" />
    </g>
  ),
};

export function Icon({ name, size = 16, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {ICON_PATHS[name] || null}
    </svg>
  );
}

// ---- one thread turn, mapped onto DS components ----
function Turn({ m }) {
  if (m.role === "user") {
    return (
      <div className="d-turn--user">
        <Message role="user">
          <p>{m.text}</p>
        </Message>
      </div>
    );
  }
  if (m.kind === "reasoning") {
    return (
      <Reasoning
        steps={m.steps}
        duration={m.duration}
        streaming={m.streaming}
        defaultOpen={m.streaming}
      />
    );
  }
  if (m.kind === "tool") {
    return <ToolCall name={m.name} args={m.args} result={m.result} status={m.status} />;
  }
  if (m.kind === "error") {
    return (
      <Alert variant="danger" title="对话出错">
        {m.text}
      </Alert>
    );
  }
  // assistant prose
  return (
    <Message role="assistant" streaming={m.streaming}>
      <p>{m.text}</p>
      {m.suggestions && !m.streaming ? (
        <div style={{ marginTop: 12 }}>
          <Suggestions items={m.suggestions} onSelect={(v) => m.onSuggest && m.onSuggest(v)} />
        </div>
      ) : null}
    </Message>
  );
}

// ---- thread ----
export function ChatThread({ messages, empty, onStarter, density }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  if (empty) {
    return (
      <div className="d-thread ax-dotgrid" ref={ref}>
        <div className="d-empty">
          <div className="d-empty__inner">
            <div className="d-empty__mark">
              <Icon name="spark" size={22} />
            </div>
            <h2 className="d-empty__h">描述你想要的表单</h2>
            <p className="d-empty__p">
              用一句话说明用途和要收集的信息，Agent 会边想边把字段搭到右侧预览。
            </p>
            <div className="d-empty__chips">
              <Suggestions
                items={["做一个线下活动报名表", "收集一份客户满意度问卷", "招聘投递表单"]}
                onSelect={onStarter}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={"d-thread" + (density === "compact" ? " is-compact" : "")} ref={ref}>
      <div className="d-thread__col">
        {messages.map((m) => (
          <Turn key={m.id} m={m} />
        ))}
      </div>
    </div>
  );
}

// ---- composer (DS) ----
export function ChatComposer({ value, onChange, onSend, disabled, placeholder }) {
  return (
    <Composer
      value={value}
      onChange={onChange}
      onSend={onSend}
      disabled={disabled}
      model="agentaily-2 · forms"
      placeholder={placeholder}
    />
  );
}
