import { defineConfig } from "@playwright/test";

const fixturePort = Number(process.env.CUSTOMER_AUTH_FIXTURE_PORT ?? 4_409);
const webPort = Number(process.env.CUSTOMER_AUTH_FIXTURE_WEB_PORT ?? 24_975);
const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
const baseURL = `http://localhost:${webPort}`;
const proxyToken = "customer-auth-browser-fixture-proxy-token";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "customer-passkey.spec.ts",
  workers: 1,
  retries: 0,
  reporter: "line",
  outputDir: "test-results/customer-authentication",
  expect: { timeout: 8_000 },
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    locale: "en-US",
    timezoneId: "Asia/Singapore",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `CUSTOMER_AUTH_FIXTURE_PORT=${fixturePort} CUSTOMER_AUTH_FIXTURE_WEB_ORIGIN=${baseURL} node --import tsx tests/fixtures/customer-auth-server.ts`,
      url: `${fixtureUrl}/healthz`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: `LEMMACOMPUTER_CONTROL_URL=${fixtureUrl} LEMMACOMPUTER_WEB_PROXY_TOKEN=${proxyToken} npm run dev -w web -- --host 127.0.0.1 --port ${webPort}`,
      url: baseURL,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
