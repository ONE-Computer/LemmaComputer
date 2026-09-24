import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// These tests render the operator HTML directly and mock its network requests.
export default defineConfig({
  ...base,
  testMatch: "platform-operator-ui.spec.ts",
  reporter: [["line"], ["html", { open: "never", outputFolder: "./reports/operator" }]],
  outputDir: "./results/operator",
  webServer: [],
});
