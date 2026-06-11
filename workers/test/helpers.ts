// Shared test helpers for the owner-config outer-loop specs.
//
// Test environment notes (see vitest.config.ts / wrangler.toml):
//   - `DB`        : local miniflare D1, bound from wrangler.toml [[d1_databases]].
//                   vitest-pool-workers gives each test a fresh, isolated copy of
//                   storage, so we (re)apply the schema in a per-suite setup.
//   - `CONFIG_KEY`: throwaway base64 256-bit AES key, injected as a miniflare
//                   binding in vitest.config.ts.
//
// schema.sql is the single source of truth for the table shape — we import it
// raw and apply it here rather than duplicating the DDL.

import { env } from "cloudflare:test";
import schemaSql from "../schema.sql?raw";

/** The bindings the owner-config feature relies on, surfaced for the tests. */
export interface TestEnv {
  DB: D1Database;
  CONFIG_KEY: string;
}

export const testEnv = env as unknown as TestEnv;

/**
 * Strip SQL line comments and split into individual statements.
 *
 * `D1Database.exec` is line-oriented: it splits on newlines and chokes on both
 * the `--` comment block and the multi-line `CREATE TABLE` in schema.sql. We
 * strip comments, then collapse each statement onto a single line so `exec`
 * sees one complete statement per call.
 */
function toStatements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return (i === -1 ? line : line.slice(0, i)).trim();
    })
    .filter((line) => line.length > 0)
    .join(" ")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Apply schema.sql to the test D1 (idempotent — schema uses
 * `CREATE TABLE IF NOT EXISTS`). Call in `beforeAll`.
 */
export async function applySchema(): Promise<void> {
  for (const stmt of toStatements(schemaSql)) {
    await testEnv.DB.exec(stmt);
  }
}

/** Empty the single-row config table between scenarios. */
export async function resetConfig(): Promise<void> {
  await testEnv.DB.exec("DELETE FROM owner_config");
}
