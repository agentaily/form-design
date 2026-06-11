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
// Test environment for the owner-auth feature (SPEC.md §17):
//   - OWNER_PASSWORD: the owner login password the route compares against. Fixed
//                     throwaway value (prod is a `wrangler secret`).
//   - AUTH_SECRET   : the HMAC key for the session JWT (sign / verify). Fixed
//                     throwaway value (prod is a `wrangler secret`).
// Both are injected here the same way CONFIG_KEY is, so the auth route /
// requireAuth can read `c.env.OWNER_PASSWORD` / `c.env.AUTH_SECRET` in tests.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          // Throwaway test key — base64 of 32 random bytes. NOT a prod secret.
          CONFIG_KEY: "P3Kapkxk/Sr/CyvCHLlIVmRUqVvBuxghj596WmWLdoc=",
          // Throwaway owner-auth secrets — fixed test values, NOT prod secrets.
          OWNER_PASSWORD: "test-owner-password-correct-horse-battery-staple",
          AUTH_SECRET: "test-auth-secret-hmac-key-do-not-use-in-prod-9f3a",
        },
      },
    }),
  ],
  test: {},
});
