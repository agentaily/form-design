---
name: workers-alter-add-column-applyschema
description: In workers/, a non-idempotent ALTER TABLE ADD COLUMN migration crashes test/helpers.ts applySchema() when a test file has multiple describe blocks each re-applying the schema
metadata:
  type: project
---

In `workers/`, any migration that uses `ALTER TABLE ... ADD COLUMN` (e.g. `0004_owner_display_name.sql`) is **non-idempotent** — SQLite has no column-level `IF NOT EXISTS`, so applying it twice throws `duplicate column name: SQLITE_ERROR`.

**Why this bites tests:** vitest-pool-workers storage isolation is **per test file, not per `describe`**. A file with several `describe` blocks that each call `applySchema()` in their own `beforeAll` (e.g. `test/rate-limit-api.test.ts` has ~8) re-runs every migration against the SAME storage. Migrations 0001–0003 are fine (`CREATE TABLE/INDEX IF NOT EXISTS`), but an ADD COLUMN crashes the 2nd+ apply — and it surfaces as the WHOLE describe block failing in `beforeAll` (looks like unrelated rate-limit flakiness, but it's the schema apply).

**How to apply:** `test/helpers.ts` `applySchema()` now swallows ONLY `duplicate column name` on repeated apply (any other SQL error still propagates). So new ADD COLUMN migrations just work. The migration file itself stays prod-correct — prod runs each migration exactly once via the `d1_migrations` tracker, never hitting the duplicate path. Do NOT add `IF NOT EXISTS` to a column (unsupported); rely on the helper's tolerance instead. Symptom to recognize: a green new-test run but `npx vitest run` (full suite) shows a multi-describe file failing with `duplicate column name` in `applySchema`.
