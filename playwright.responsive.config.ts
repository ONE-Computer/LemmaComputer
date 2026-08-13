import { defineConfig } from "@playwright/test";

const fixturePort = Number(process.env.LEMMACOMPUTER_RESPONSIVE_FIXTURE_PORT ?? 24_480);
const webPort = Number(process.env.LEMMACOMPUTER_RESPONSIVE_WEB_PORT ?? 24_481);
const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: [
    "responsive-remediation.spec.ts",
    "customer-authentication.spec.ts",
    "chat-composer-docking.spec.ts",
    "activity-panel.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "line",
  outputDir: "test-results/responsive-remediation",
  expect: { timeout: 8_000 },
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "Asia/Singapore",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: `UI_FIXTURE_PORT=${fixturePort} npm run dev:ui-fixture`,
      url: `${fixtureUrl}/v1/auth/session`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: `LEMMACOMPUTER_CONTROL_URL=${fixtureUrl} npm run dev -w web -- --config ../../scripts/vite-responsive-audit.config.mjs --host 127.0.0.1 --port ${webPort}`,
      url: baseURL,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
