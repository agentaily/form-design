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

The full product blueprint (client-side Agent loop, VFS, tool executor, iframe
rendering, BYOK, publish/collect) lives in **[`SPEC.md`](./SPEC.md)**.

## Run

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # production bundle to dist/
npm test          # Vitest: unit (TDD) + BDD (.feature) — jsdom
npm run test:e2e  # Playwright end-to-end (real browser)
```

## How it's wired

- `src/main.jsx` — entry; imports `@agentaily/design-system/styles.css` (tokens +
  fonts + motif utilities) once, then mounts the app.
- `src/App.jsx` — header, resizable split, scripted runner, Schema view, share dialog.
- `src/chat.jsx` — chat side: `Message` / `Reasoning` / `ToolCall` / `Composer` / `Suggestions`.
- `src/preview.jsx` — live form: `Field` / `Input` / `Textarea` / `Select` / `RadioGroup` / `Checkbox` / `Button`.
- `src/flow.jsx` — the scripted build sequence + keyword intent handling that drives the demo.
- `src/app.css` — layout-only styles (page chrome, split, form-card shell); all values reference DS tokens.
- `src/core/` — the **SPEC architecture's testable core**, implemented test-first
  (TDD) and framework-agnostic: `vfs.js` (virtual file system), `schema.js`
  (form schema ops + validation), `tools.js` (Anthropic tool defs + executor),
  `queue.js` (single-consumer message queue + batch merge), `srcdoc.js`
  (VFS → iframe srcdoc), `agentLoop.js` (ReAct turn with self-healing). These
  are the building blocks for the live-LLM product described in `SPEC.md`; the
  current app UI is still the scripted prototype.

## Testing

BDD + TDD, runnable today:

- **TDD unit** (`tests/unit/`) — Vitest specs for every `src/core/` module
  (VFS CRUD, schema field ops, tool dispatch, queue batching, srcdoc assembly,
  agent loop stop/self-heal/max-iters) plus the prototype's pure logic.
- **BDD** (`tests/bdd/`) — Gherkin `.feature` files run by
  `@amiceli/vitest-cucumber` + Testing Library: building a form, fill &
  validate & submit, and the agent self-healing a failed edit.
- **E2E** (`e2e/`) — Playwright drives the real designer in a real browser
  (build → validate → publish). Uses system Chrome via `channel: "chrome"`;
  set `PW_USE_BUNDLED=1` to use Playwright's bundled chromium instead.

```bash
npm test          # unit + BDD
npm run test:e2e  # Playwright
npm run test:all  # both
```

## Note on the agent

The conversation is a **scripted demo**, not a live LLM: the first brief plays a
fixed reasoning → `add_field` sequence, and follow-ups use keyword matching
(`必填`, `餐食`, `发布`, …). The `src/core/` modules + `SPEC.md` describe the path
to a real model-driven loop; swap `src/flow.jsx` (or wire `src/core/agentLoop.js`
to `callLLM`) to respond to free-form input.
