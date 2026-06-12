# Agentaily Forms · 对话式表单设计器

A conversational form designer — left pane is the Agent chat, right pane is the
live form preview. Describe the form you want; the Agent (a real DeepSeek model,
proxied through the backend) **streams** its reply and calls form tools
(`add_field` / `update_field` / `remove_field` / `duplicate_field` /
`reorder_fields` / `set_form_meta`), mounting each change into the preview in
real time. You can keep typing while a turn runs — extra messages collect in a **buffer**
(shown above the composer) and flush together on the next turn. The preview is
fillable end-to-end, with validation driven by the design system's
`Form.useForm` hook (required + email + 11-digit phone format → focus-first
error → success state), a Schema view, and desktop/phone width toggles. The
layout is **responsive**: ≤720px collapses to a single column with a
chat/preview segmented switcher. Publish/Share opens a QR-code dialog.

Built on the **[`@agentaily/design-system`](https://github.com/agentaily/design-system)**
npm package — every UI surface (chat, inputs, dialog, tabs, schema tree) is a
real design-system component, so upstream changes flow through automatically.

The full product blueprint (client-side Agent loop, VFS, tool executor, iframe
rendering, BYOK, publish/collect) lives in **[`SPEC.md`](./SPEC.md)**; day-to-day
ops (hooks, CI/CD, Pages deploy, releases) are in **[`OPERATIONS.md`](./OPERATIONS.md)**.
How the project is **driven** — the layered R&D paradigm (roadmap → spec/BDD/contract →
double-loop TDD by sub agents → parallel topology) — is in **[`METHODOLOGY.md`](./METHODOLOGY.md)**.

## Run

```bash
npm install
cp .env.example .env   # set VITE_API_BASE to the backend; empty = same-origin /api/*
npm run dev        # http://localhost:5173
npm run build      # production bundle to dist/
npm run typecheck  # tsc --noEmit (src/core is TypeScript)
npm test           # Vitest: unit (TDD) + BDD (.feature) — jsdom
npm run test:e2e   # Playwright end-to-end (real browser; PW_PORT overrides 5173)
```

The designer talks to the Cloudflare Workers backend over `VITE_API_BASE`
(`POST /api/chat`, etc. — see `SPEC.md` §12–§21). Leave it empty for same-origin
`/api/*`; point it at a local backend with `cd workers && npx wrangler dev` then
`VITE_API_BASE=http://127.0.0.1:8787`. `/api/chat` is owner-only, so the owner
logs in (`POST /api/auth/login`) and the session token rides every owner-only
request as a Bearer header (`core/auth` + the account dialog in `src/auth.jsx`).

## How it's wired

- `src/main.jsx` — entry; imports `@agentaily/design-system/styles.css` (tokens +
  fonts + motif utilities) once, then mounts the app.
- `src/App.jsx` — header, resizable split (single-column ≤720px via the mobile
  sub-bar), the live agent turn (streamed prose + tool-call cards) driven through
  `core/queue` (continuous-send buffer + `Queue` UI), Schema view, share dialog.
- `src/chat.jsx` — chat side: `Message` / `Reasoning` / `ToolCall` / `Composer` / `Suggestions` / `Alert`.
- `src/auth.jsx` — owner login / account dialog (`Dialog` / `Input` / `Button` / `Alert`); password form when logged out, confirmation + logout when logged in.
- `src/preview.jsx` — live form: `Field` / `Input` / `Textarea` / `Select` / `RadioGroup` / `Checkbox` / `Button`, with validation via the DS `Form.useForm` hook.
- `src/app.css` — layout-only styles (page chrome, split, form-card shell); all values reference DS tokens.
- `src/core/` — the **SPEC architecture's testable core** (TypeScript, strict),
  implemented test-first (TDD) and framework-agnostic. The backend seam +
  designer agent: `apiClient.ts` (fetch wrapper, `VITE_API_BASE`, Bearer token,
  typed `ApiError`), `sse.ts` (SSE decoder), `openaiStream.ts` (OpenAI/DeepSeek
  stream assembly), `designerTools.ts` (UI field model + tool defs + system
  prompt), `designerLoop.ts` (ReAct turn, OpenAI shape, self-healing),
  `designerChat.ts` (the real `POST /api/chat` caller), `auth.ts` (owner login →
  session token via `POST /api/auth/login`, stored in `apiClient`). Plus the original blocks:
  `vfs.ts`, `schema.ts`, `tools.ts` (Anthropic tool defs/executor), `queue.ts`
  (single-consumer queue + batch merge), `srcdoc.ts`, `agentLoop.ts` — the VFS →
  iframe rendering path described in `SPEC.md`.

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

The conversation is a **live DeepSeek model**, not a script: `src/core/designerLoop`
runs a single-turn ReAct loop (SPEC §4) in OpenAI message shape, streaming from the
backend proxy `POST /api/chat` (SPEC §13) via `designerChat`. The model calls the
form tools in `designerTools` (`set_form_meta`, `add_field`, …), which mutate the
live form model that `preview.jsx` renders; failed tool calls backfill as errors so
the model self-heals. Tests inject a fake `chat` into `<App chat={…} />` for
deterministic builds. `/api/chat` is owner-only — the owner-login/Bearer flow is
wired (`core/auth` + `src/auth.jsx`; a 401 auto-opens the login dialog). The owner
also connects DeepSeek + 飞书 through the integration-settings dialog (`src/settings.jsx`

- `core/configClient`, SPEC §12/§14): open → `GET /api/config` echoes the masked
  config, save → `POST /api/config`, test → `POST /api/config/test`; a 401 routes back
  into the login flow. The publish/submit endpoints land in later phases (see `ROADMAP.md`).
