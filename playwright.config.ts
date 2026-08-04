import { defineConfig } from "@playwright/test";

const fixturePort = Number(process.env.LEMMACOMPUTER_E2E_FIXTURE_PORT ?? 4_399);
const webPort = Number(process.env.LEMMACOMPUTER_E2E_WEB_PORT ?? 24_965);
const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["line"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  outputDir: "test-results",
  expect: {
    timeout: 8_000,
    toHaveScreenshot: {
      animations: "disabled",
      maxDiffPixelRatio: 0.01,
    },
  },
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
      command: `LEMMACOMPUTER_CONTROL_URL=${fixtureUrl} npm run dev -w web -- --host 127.0.0.1 --port ${webPort}`,
      url: baseURL,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
