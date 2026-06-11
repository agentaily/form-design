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
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          // Throwaway test key — base64 of 32 random bytes. NOT a prod secret.
          CONFIG_KEY: "P3Kapkxk/Sr/CyvCHLlIVmRUqVvBuxghj596WmWLdoc=",
        },
      },
    }),
  ],
  test: {},
});
