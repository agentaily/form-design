// chat.jsx — chat-side rendering for the DS ConversationThread.
//
// Since 0.4.0 the design system ships the chat surface itself (ConversationThread,
// pure-render + external controller) plus the unified Lucide `Icon` set, so this
// file no longer hand-rolls a thread/composer or an icon path table. It now only:
//   • re-exports the DS `Icon` (the local ICON_PATHS set moved upstream), so the
//     many `import { Icon } from "./chat.jsx"` call-sites keep working unchanged;
//   • exports `renderChatTurn`, the per-turn renderer fed to <ConversationThread
//     renderTurn>, mapping our message model onto the DS chat/ai atoms.
import React from "react";
import {
  Message,
  Markdown,
  Reasoning,
  ToolCall,
  Suggestions,
  Alert,
} from "@agentaily/design-system";

// The local Lucide table is gone — every icon now resolves through the upstream
// unified set (`Icon.names` lists them all). Re-exported so call-sites don't change.
export { Icon } from "@agentaily/design-system";

// One thread turn → a DS node, dispatched by role/kind. `ctx.streaming` is the
// per-message streaming flag surfaced by ConversationThread; `onSuggest` runs a
// suggestion-chip click (routes back through the same send/enqueue path).
//   • user                       → <Message role="user">
//   • assistant · reasoning      → <Reasoning> (思考块)
//   • assistant · tool           → <ToolCall>  (add_field 等工具卡)
//   • assistant · error          → <Alert variant="danger"> (对话失败)
//   • assistant · text (default) → <Message role="assistant"> with prose rendered
//                                   through the DS <Markdown> primitive (lists / bold /
//                                   links / code / headings typeset, never raw source) +
//                                   optional <Suggestions>
export function renderChatTurn(m, ctx, onSuggest) {
  if (m.role === "user") {
    return (
      <Message role="user">
        <p>{m.text}</p>
      </Message>
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
  // assistant prose (+ optional suggestion chips once the turn has settled). The text
  // is model output that routinely carries markdown (lists / bold / links / code), so
  // it goes through the DS <Markdown> primitive — typeset, theme-aware, and XSS-safe
  // (parsed to a node tree, never dangerouslySetInnerHTML; link schemes sanitized).
  // Passing React-node children keeps the <Suggestions> sibling intact (the Message
  // `markdown` prop would override children, so we render <Markdown> explicitly).
  return (
    <Message role="assistant" streaming={ctx.streaming}>
      <Markdown content={m.text} />
      {m.suggestions && !ctx.streaming ? (
        <div style={{ marginTop: 12 }}>
          <Suggestions items={m.suggestions} onSelect={onSuggest} />
        </div>
      ) : null}
    </Message>
  );
}
