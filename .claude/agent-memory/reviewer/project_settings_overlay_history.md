---
name: settings-overlay-history-state-machine
description: PR #52 turned /settings into a route-reflected floating overlay; the history push/back/popstate logic is the riskiest surface to re-review on settings changes
metadata:
  type: project
---

Since DS 0.8.0 (PR #51) + PR #52, 设置 is NOT a route page — it is a floating `SettingsOverlay`
(DS `SettingsSheet`, 账户 + 集成 tabs) that `DesignerApp` opens over itself in `src/App.jsx`,
reflecting a `/settings` URL via `history.pushState` WITHOUT unmounting the designer.

**Why:** DS 0.8.0 restructured settings into a floating sheet; the team wanted deep-linkable
`/settings` + browser Back/Esc/✕ to close-and-restore the prior page state, without losing the
designer's in-memory state underneath.

**How to apply:** When reviewing any future change to settings open/close, re-verify the
state machine in `App.jsx` (`openSettings` / `closeSettings` / the `popstate` effect +
`settingsPushedRef`):

- `openSettings` guards the `pushState` on `currentPathname() !== SETTINGS_PATH` so re-open /
  deep-link / resume-intent never stacks duplicate history entries.
- `closeSettings` branches: WE-pushed → `history.back()`; deep-link (no push) on `/settings` →
  normalize to "/" via pushState (never `history.back()` out of the app).
- The `return=/settings` re-login flow + `dispatchIntent("settings")` resume correctly avoids a
  duplicate push because on re-mount the path is already `/settings`.
- `matchSettings` in `core/router.ts` is now an orphan from App's route split but kept as a
  tested pure helper (documented). Don't flag it as dead code.

PR #52 was reviewed clean (ship). Frontend typecheck clean, 97 changed-spec tests + 28 backend
profile/users tests green. `PUT /api/auth/profile` is owner-only (session.sub, never body id),
trims/NULLs/400s correctly, projects only `{email, emailVerified, displayName}` (no password\_\*).
displayName rendered as plain text (no dangerouslySetInnerHTML). Monitor toggle uses an inline
SVG because the DS Icon set genuinely has no "monitor" glyph (verified) — legitimate, documented.
`applySchema` swallows ONLY `duplicate column name` for the non-idempotent 0004 ADD COLUMN
(needed because rate-limit-api.test.ts calls applySchema 8x per file).
