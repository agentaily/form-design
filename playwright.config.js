import { defineConfig, devices } from "@playwright/test";

// E2E against the real dev server in a real browser. Playwright auto-starts
// `npm run dev` before the suite. The port is overridable via PW_PORT so a run
// can avoid clashing with a dev server already on 5173 (e.g. a sibling worktree);
// in CI we never reuse a foreign server, so the suite always hits this checkout.
const PORT = process.env.PW_PORT ? Number(process.env.PW_PORT) : 5173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    // The designer settles via promises + a short timer; Chromium throttles timers
    // in backgrounded/occluded renderers under headless e2e. Disable that throttling.
    launchOptions: {
      args: [
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ],
    },
  },
  // Use the system-installed Google Chrome by default (no bundled-binary download
  // needed). Set PW_USE_BUNDLED=1 to use Playwright's own chromium instead.
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.PW_USE_BUNDLED ? {} : { channel: "chrome" }),
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
