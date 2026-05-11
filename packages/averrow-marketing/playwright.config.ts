import { defineConfig, devices } from "@playwright/test";

/*
 * Playwright smoke tests for the Astro marketing site.
 *
 * Scope: this scaffold runs a small set of critical-path
 * assertions against every ported route — title present, key
 * headings rendered, no console errors, theme cycle works. R7
 * ships the scaffold; expand coverage as needed.
 *
 * Run modes:
 *   pnpm --filter @averrow/marketing test:e2e        — local
 *   pnpm --filter @averrow/marketing test:e2e:ui     — interactive
 *
 * Targets: tests hit the locally-served preview build by
 * default. Override with PLAYWRIGHT_BASE_URL to run against
 * staging or production.
 */
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:4321";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"] },
    },
  ],
  // When PLAYWRIGHT_BASE_URL isn't set, boot the Astro preview
  // server. CI typically deploys to staging and overrides BASE_URL,
  // so the webServer config only kicks in locally.
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "pnpm build && pnpm preview --host",
        url: BASE_URL,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
      },
});
