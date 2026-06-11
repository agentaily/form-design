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
import { vi } from "vitest";
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

// --- Upstream (DeepSeek) fetch mock ----------------------------------------
//
// vitest-pool-workers 0.16.14 no longer exports `fetchMock` from `cloudflare:test`
// (the old undici MockAgent surface is gone). The supported, fully test-local
// mechanism is a global `fetch` stub: the cloudflare:test docs guarantee the
// `main` Worker reached via `SELF.fetch` runs in the SAME isolate as the test, so
// "any global mocks will apply to it too". We exploit that to intercept the
// Worker's outbound call to https://api.deepseek.com without ever touching the
// network.
//
// `installUpstreamMock` is default-deny: it throws on any origin other than the
// configured upstream, so a missing/broken proxy implementation can never silently
// reach the real api.deepseek.com — it fails loudly instead.

/** The OpenAI-compatible upstream the proxy must call (SPEC.md §13.1). */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** One captured outbound request to the upstream. */
export interface UpstreamCall {
  url: string;
  method: string;
  /** Lower-cased header lookups via the captured Headers. */
  headers: Headers;
  /** Raw request body text (the JSON the proxy sent upstream). */
  bodyText: string;
  /** Parsed body, or `undefined` when the body was not valid JSON. */
  body: unknown;
}

/** What the mocked upstream should reply with for the next call(s). */
export interface UpstreamReply {
  status?: number;
  /** Response body bytes (e.g. an SSE transcript, or a JSON error string). */
  body?: string;
  /** Response headers (defaults to text/event-stream for the success path). */
  headers?: Record<string, string>;
}

/** Handle returned by {@link installUpstreamMock} for per-test assertions. */
export interface UpstreamMock {
  /** Every outbound request the Worker made to the upstream, in order. */
  readonly calls: UpstreamCall[];
  /** Convenience: was the upstream contacted at all? */
  called(): boolean;
  /** Restore the real global fetch (call in afterEach). */
  restore(): void;
}

/**
 * Stub the global `fetch` so the Worker's outbound call to the DeepSeek upstream
 * is captured and answered locally.
 *
 * - Requests whose origin is {@link DEEPSEEK_BASE_URL} are recorded and answered
 *   with `reply` (defaults to a 200 `text/event-stream`).
 * - Requests to ANY other origin throw — guaranteeing tests never hit the real
 *   network, and surfacing an unexpected fan-out as a hard failure.
 *
 * The reply body is returned verbatim so the success-path test can assert the
 * proxy透传ed the upstream SSE bytes unchanged.
 */
export function installUpstreamMock(reply: UpstreamReply = {}): UpstreamMock {
  const calls: UpstreamCall[] = [];
  const status = reply.status ?? 200;
  const body = reply.body ?? "";
  const headers = reply.headers ?? { "content-type": "text/event-stream" };

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    if (!req.url.startsWith(DEEPSEEK_BASE_URL)) {
      // Default-deny: the proxy must only ever talk to the configured upstream.
      throw new Error(
        `unexpected outbound fetch to ${req.url} (only ${DEEPSEEK_BASE_URL} is mocked)`,
      );
    }
    const bodyText = await req.clone().text();
    let parsed: unknown;
    try {
      parsed = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
    } catch {
      parsed = undefined;
    }
    calls.push({
      url: req.url,
      method: req.method,
      headers: new Headers(req.headers),
      bodyText,
      body: parsed,
    });
    return new Response(body, { status, headers });
  });

  return {
    calls,
    called: () => calls.length > 0,
    restore: () => vi.unstubAllGlobals(),
  };
}
