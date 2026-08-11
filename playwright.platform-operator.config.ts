import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "platform-operator-ui.spec.ts",
  workers: 1,
  reporter: "line",
  outputDir: "test-results/platform-operator",
  use: {
    browserName: "chromium",
    headless: true,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "Asia/Singapore",
  },
});
