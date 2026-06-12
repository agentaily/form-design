import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// vitest-pool-workers 0.16 (vitest 4): the workers pool is wired via the
// cloudflareTest Vite plugin — the old defineWorkersConfig / "./config" entry
// was removed. Tests run in the real workerd runtime with D1/KV bindings read
// from wrangler.toml.
//
// Test environment for the owner-config feature:
//   - DB        : local miniflare D1 (from the wrangler.toml [[d1_databases]]
//                 binding); each test's setup applies schema.sql to it.
//   - CONFIG_KEY: a throwaway base64 256-bit AES-GCM master key, injected here
//                 as a miniflare binding so `c.env.CONFIG_KEY` is readable in
//                 tests. The prod key is a `wrangler secret`, never committed.
//
// Test environment for the owner-auth feature (SPEC.md §17, multi-user):
//   - AUTH_SECRET: the HMAC key for the session JWT (sign / verify). Fixed throwaway
//                  value (prod is a `wrangler secret`), injected the same way
//                  CONFIG_KEY is so the auth routes / requireAuth can read it.
// OWNER_PASSWORD is GONE post multi-user rework: there is no single shared owner
// password — every owner is a real `users` row (email + per-user password hash),
// so register/login derive the token from the users table, not an env binding.
//
// Test environment for the transactional-email feature (SPEC.md §22–§24):
//   - RESEND_API_KEY: the Resend send-email secret. A FIXED throwaway value injected
//                     here (prod is a `wrangler secret`, never committed). Email tests
//                     stub global fetch (no real send / no key egress), so this value
//                     never leaves the isolate.
//   - EMAIL_FROM / APP_BASE_URL: non-secret [vars] — read from wrangler.toml directly,
//                     so they're already on c.env in tests; no miniflare override needed.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          // Throwaway test key — base64 of 32 random bytes. NOT a prod secret.
          CONFIG_KEY: "P3Kapkxk/Sr/CyvCHLlIVmRUqVvBuxghj596WmWLdoc=",
          // Throwaway owner-auth secret — fixed test value, NOT a prod secret.
          AUTH_SECRET: "test-auth-secret-hmac-key-do-not-use-in-prod-9f3a",
          // Throwaway Resend key — fixed test value, NOT a prod secret. Email tests
          // mock fetch so this never hits the network / never leaves the isolate.
          RESEND_API_KEY: "re_test_THROWAWAY_resend_key_do_not_use_in_prod",
        },
      },
    }),
  ],
  test: {},
});
