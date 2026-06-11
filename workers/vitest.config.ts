import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// vitest-pool-workers 0.16 (vitest 4): the workers pool is wired via the
// cloudflareTest Vite plugin — the old defineWorkersConfig / "./config" entry
// was removed. Tests run in the real workerd runtime with D1/KV bindings read
// from wrangler.toml.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
  test: {},
});
