import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// Smoke test: proves the Hono app boots in workerd and routes work — the
// scaffold is alive. Real features get their own specs.
describe("health", () => {
  it("GET /health returns ok", async () => {
    const res = await SELF.fetch("https://api.local/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "form-design-api" });
  });
});
