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
rendering, BYOK, publish/collect) lives in **[`SPEC.md`](./SPEC.md)**; day-to-day
ops (hooks, CI/CD, Pages deploy, releases) are in **[`OPERATIONS.md`](./OPERATIONS.md)**.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle to dist/
npm run typecheck  # tsc --noEmit (src/core is TypeScript)
npm test           # Vitest: unit (TDD) + BDD (.feature) — jsdom
npm run test:e2e   # Playwright end-to-end (real browser)
```

## How it's wired

- `src/main.jsx` — entry; imports `@agentaily/design-system/styles.css` (tokens +
  fonts + motif utilities) once, then mounts the app.
- `src/App.jsx` — header, resizable split, scripted runner, Schema view, share dialog.
- `src/chat.jsx` — chat side: `Message` / `Reasoning` / `ToolCall` / `Composer` / `Suggestions`.
- `src/preview.jsx` — live form: `Field` / `Input` / `Textarea` / `Select` / `RadioGroup` / `Checkbox` / `Button`.
- `src/flow.jsx` — the scripted build sequence + keyword intent handling that drives the demo.
- `src/app.css` — layout-only styles (page chrome, split, form-card shell); all values reference DS tokens.
- `src/core/` — the **SPEC architecture's testable core** (TypeScript, strict),
  implemented test-first (TDD) and framework-agnostic: `vfs.ts` (virtual file
  system), `schema.ts` (form schema ops + validation), `tools.ts` (Anthropic
  tool defs + executor), `queue.ts` (single-consumer message queue + batch
  merge), `srcdoc.ts` (VFS → iframe srcdoc), `agentLoop.ts` (ReAct turn with
  self-healing). These are the typed building blocks for the live-LLM product
  described in `SPEC.md`; the current app UI is still the scripted prototype.

## Testing

**BDD is the methodology, not a layer.** `features/` holds the Gherkin behavior
specs (living documentation); the test levels below each _realize_ those
behaviors at the right altitude (double-loop TDD: BDD/acceptance outer loop +
unit TDD inner loop). Behavior and level are orthogonal axes.

- **`features/`** — global behavior spec (`*.feature`, Given/When/Then). The
  single source of truth for what the system does; referenced by every level.
- **`tests/unit/`** — inner-loop unit tests for every `src/core/` module (VFS
  CRUD, schema ops, tool dispatch, queue batching, srcdoc, agent loop) + the
  prototype's pure logic. Behavior-styled `describe/it`, no Gherkin (Gherkin per
  micro-assertion is high-ceremony / low-value).
- **`tests/integration/`** — component & cross-module tests that realize the
  features via `@amiceli/vitest-cucumber` + Testing Library (build a form, fill
  & validate & submit, agent self-heal).
- **`e2e/`** — Playwright realizes feature scenarios in a real browser
  (build → validate → publish). Uses system Chrome via `channel: "chrome"`; set
  `PW_USE_BUNDLED=1` for Playwright's bundled chromium.

```bash
npm test          # Vitest: unit + integration (jsdom)
npm run test:e2e  # Playwright
npm run test:all  # both
```

## Note on the agent

The conversation is a **scripted demo**, not a live LLM: the first brief plays a
fixed reasoning → `add_field` sequence, and follow-ups use keyword matching
(`必填`, `餐食`, `发布`, …). The `src/core/` modules + `SPEC.md` describe the path
to a real model-driven loop; swap `src/flow.jsx` (or wire `src/core/agentLoop.js`
to `callLLM`) to respond to free-form input.
