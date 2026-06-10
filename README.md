# Agentaily Forms · 对话式表单设计器

A conversational form designer — left pane is the Agent chat, right pane is the
live form preview. Describe the form you want; the Agent reasons, streams in
`add_field()` tool calls, and mounts each field into the preview in real time.
The preview is fillable end-to-end (required-field validation → success state),
with a Schema view and desktop/phone width toggles. Publish/Share opens a
QR-code dialog.

Built on the **[`@agentaily/design-system`](https://github.com/agentaily/design-system)**
npm package — every UI surface (chat, inputs, dialog, tabs, schema tree) is a
real design-system component, so upstream changes flow through automatically.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production bundle to dist/
```

## How it's wired

- `src/main.jsx` — entry; imports `@agentaily/design-system/styles.css` (tokens +
  fonts + motif utilities) once, then mounts the app.
- `src/App.jsx` — header, resizable split, scripted runner, Schema view, share dialog.
- `src/chat.jsx` — chat side: `Message` / `Reasoning` / `ToolCall` / `Composer` / `Suggestions`.
- `src/preview.jsx` — live form: `Field` / `Input` / `Textarea` / `Select` / `RadioGroup` / `Checkbox` / `Button`.
- `src/flow.jsx` — the scripted build sequence + keyword intent handling that drives the demo.
- `src/app.css` — layout-only styles (page chrome, split, form-card shell); all values reference DS tokens.

## Note on the agent

The conversation is a **scripted demo**, not a live LLM: the first brief plays a
fixed reasoning → `add_field` sequence, and follow-ups use keyword matching
(`必填`, `餐食`, `发布`, …). Swap `src/flow.jsx` for real model calls to make it
respond to free-form input.
