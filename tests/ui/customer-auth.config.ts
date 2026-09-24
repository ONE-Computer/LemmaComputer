import { defineConfig } from "@playwright/test";
import base, { repositoryRoot } from "./playwright.config";

const fixturePort = Number(process.env.CUSTOMER_AUTH_FIXTURE_PORT ?? 4_409);
const webPort = Number(process.env.CUSTOMER_AUTH_FIXTURE_WEB_PORT ?? 24_975);
const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
const baseURL = `http://localhost:${webPort}`;
const proxyToken = "customer-auth-browser-fixture-proxy-token";

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: "customer-passkey.spec.ts",
  retries: 0,
  reporter: [["line"], ["html", { open: "never", outputFolder: "./reports/auth" }]],
  outputDir: "./results/auth",
  use: { ...base.use, baseURL },
  webServer: [
    {
      cwd: repositoryRoot,
      command: `CUSTOMER_AUTH_FIXTURE_PORT=${fixturePort} CUSTOMER_AUTH_FIXTURE_WEB_ORIGIN=${baseURL} node --import tsx tests/ui/fixtures/customer-auth-server.ts`,
      url: `${fixtureUrl}/healthz`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      cwd: repositoryRoot,
      command: `LEMMACOMPUTER_CONTROL_URL=${fixtureUrl} LEMMACOMPUTER_WEB_PROXY_TOKEN=${proxyToken} npm run dev -w web -- --host 127.0.0.1 --port ${webPort}`,
      url: baseURL,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
