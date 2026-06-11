import { defineConfig, devices } from "@playwright/test";

// E2E against the real dev server in a real browser. Playwright auto-starts
// `npm run dev` (reusing an already-running one) before the suite.
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    // The scripted build runs on chained setTimeout; Chromium throttles timers in
    // backgrounded/occluded renderers, which stalls the build under headless e2e and
    // makes 发布/指向修改 take far longer than ~12s to enable. Disable that throttling.
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
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
