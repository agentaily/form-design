// Global test setup (vitest `setupFiles`): clear the public-endpoint rate-limit
// KV counters (§25) before EVERY test, across every suite.
//
// Why this is global rather than per-suite: SELF.fetch carries no
// `CF-Connecting-IP`, so every request the outer-loop harness makes lands in the
// single constant UNKNOWN_IP_BUCKET (§25.3). The fixed-window counts live in the
// miniflare RATE_LIMIT KV, which PERSISTS across tests in the shared isolate —
// so the many register / login / submit / password-reset calls the existing
// suites make would accumulate past the limits and start 429ing setup helpers.
// Wiping the `rl:` keys before each test gives every scenario a fresh window
// (mirroring distinct real visitors) WITHOUT touching production rate-limit
// behavior. Runs in the same isolate as the Worker (cloudflare:test guarantee),
// so it can reach `env.RATE_LIMIT` directly.
import { beforeEach } from "vitest";
import { resetRateLimit } from "./helpers";

beforeEach(async () => {
  await resetRateLimit();
});
