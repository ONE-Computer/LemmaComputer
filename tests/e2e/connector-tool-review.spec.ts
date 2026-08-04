import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";

const connector = {
  id: "reports",
  serverName: "lemmacomputer_reports",
  name: "Reports",
  shortDescription: "Company reports",
  description: "Use approved reports.",
  category: "Productivity",
  services: ["Tools"],
  policySupport: "automatic",
  source: "custom",
  brand: "generic",
  available: true,
  state: "connected",
  connectedAt: "2026-08-02T00:00:00.000Z",
  expiresAt: null,
  account: null,
  enabled: true,
  membersCanManage: true,
  canManageConnection: true,
  accessPolicyVersion: 1,
  accessPolicyUpdatedAt: "2026-08-02T00:00:00.000Z",
};

const documentHash = "a".repeat(64);
const policy = {
  connectorId: connector.id,
  connectorName: connector.name,
  serverName: connector.serverName,
  version: 1,
  documentHash,
  changes: {
    added: ["export-report"],
    changed: ["search-reports"],
    removed: ["old-tool"],
  },
  tools: [
    {
      name: "export-report",
      definitionHash: "b".repeat(64),
      displayName: "Export report",
      description: "New provider tool. Blocked until reviewed.",
      definitionPreview: '{"name":"export-report","inputSchema":{"type":"object"}}',
      service: "tools",
      risk: "unknown",
      decision: "deny",
      reviewRequired: true,
    },
    {
      name: "search-reports",
      definitionHash: "c".repeat(64),
      displayName: "Search reports",
      description: "Changed provider tool. Blocked until reviewed.",
      service: "tools",
      risk: "unknown",
      decision: "deny",
      reviewRequired: true,
    },
  ],
};

test("custom connector tools stay blocked until the administrator reviews and saves their exact definition", async ({ page }) => {
  let saved = false;
  await page.route("**/api/v1/connections", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: [connector] }) });
  });
  await page.route("**/api/v1/admin/connectors/reports/tool-policy", async (route) => {
    if (route.request().method() === "PUT") {
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      assert.equal(body.expectedDocumentHash, documentHash);
      assert.deepEqual(body.tools, {
        "export-report": "deny",
        "search-reports": "deny",
      });
      saved = true;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      ...policy,
      changes: saved ? { added: [], changed: [], removed: [] } : policy.changes,
      tools: policy.tools.map((tool) => ({ ...tool, reviewRequired: !saved })),
    }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connections" }).click();
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByRole("button", { name: "Tools & approvals" }).click();

  await expect(page.locator(".tool-policy-change-summary")).toContainText("1 added, 1 changed, 1 removed");
  await expect(page.getByText("New provider tool. Blocked until reviewed.")).toBeVisible();
  await page.getByText("View current provider definition").click();
  await expect(page.locator(".tool-definition-preview pre")).toContainText("export-report");

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => saved).toBe(true);
  await expect(page.locator(".tool-policy-change-summary")).toHaveCount(0);
});
