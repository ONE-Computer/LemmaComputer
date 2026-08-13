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
  canAdministerConnector: true,
  accessPolicyVersion: 1,
  accessPolicyUpdatedAt: "2026-08-02T00:00:00.000Z",
};

const exaConnector = {
  id: "exa",
  serverName: "lemmacomputer_exa",
  name: "Exa",
  shortDescription: "Search the web",
  description: "Find current web information and read page content through Exa search.",
  category: "Search",
  services: ["Web search", "Page content", "Research"],
  policySupport: "automatic",
  source: "built-in",
  brand: "exa",
  available: true,
  state: "disconnected",
  connectedAt: null,
  expiresAt: null,
  account: null,
  enabled: true,
  membersCanManage: true,
  canManageConnection: true,
  accessPolicyVersion: 1,
  accessPolicyUpdatedAt: "2026-08-05T00:00:00.000Z",
  activation: {
    readiness: "ready",
    action: "connect",
    message: "This approved service is ready to connect.",
  },
};

const documentHash = "a".repeat(64);
const policy = {
  connectorId: connector.id,
  connectorName: connector.name,
  serverName: connector.serverName,
  accessPolicyVersion: 1,
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

const source = (kind: "protected_baseline" | "organization_policy" | "connector_policy", version: number, decision?: "allow" | "approval_required" | "deny") => ({
  kind,
  sourceId: `${kind}-${version}`,
  version,
  documentHash: String(version).repeat(64),
  ...(decision ? { decision } : {}),
});

const effectivePolicy = {
  connector: { id: connector.id, name: connector.name },
  access: {
    configuredEnabled: true,
    effectiveDecision: "allow",
    membersCanManage: false,
    accessPolicyVersion: 3,
    updatedAt: "2026-08-13T00:00:00.000Z",
    reason: "allowed",
    controllingSource: source("connector_policy", 3),
  },
  sources: [source("protected_baseline", 1), source("organization_policy", 2), source("connector_policy", 3)],
  tools: [
    {
      name: "search-reports",
      displayName: "Search reports",
      configuredDecision: "allow",
      effectiveDecision: "allow",
      reviewState: "current",
      observedDefinitionHash: "a".repeat(64),
      reviewedDefinitionHash: "a".repeat(64),
      sources: [source("protected_baseline", 1, "allow"), source("organization_policy", 2, "allow"), source("connector_policy", 3, "allow")],
    },
    {
      name: "export-report",
      displayName: "Export report",
      configuredDecision: "allow",
      effectiveDecision: "approval_required",
      reviewState: "current",
      observedDefinitionHash: "b".repeat(64),
      reviewedDefinitionHash: "b".repeat(64),
      sources: [source("protected_baseline", 1, "approval_required"), source("connector_policy", 3, "allow")],
    },
    {
      name: "delete-report",
      displayName: "Delete report",
      configuredDecision: "deny",
      effectiveDecision: "deny",
      reviewState: "current",
      observedDefinitionHash: "c".repeat(64),
      reviewedDefinitionHash: "c".repeat(64),
      sources: [source("protected_baseline", 1, "allow"), source("organization_policy", 2, "deny"), source("connector_policy", 3, "deny")],
    },
    {
      name: "upload-report",
      displayName: "Upload report",
      configuredDecision: "allow",
      effectiveDecision: "deny",
      reviewState: "awaiting_review",
      observedDefinitionHash: "e".repeat(64),
      reviewedDefinitionHash: "d".repeat(64),
      sources: [source("protected_baseline", 1, "allow"), source("connector_policy", 3, "allow")],
    },
  ],
  runtimeProjection: { scope: "requesting_administrator", state: "partially_available", allowed: 1, approvalRequired: 1, denied: 2 },
  policyApplication: {
    state: "mixed",
    currentVersion: { version: 4, documentHash: "4".repeat(64) },
    activeMembers: 3,
    currentMembers: 2,
    remediationRequiredMembers: 1,
    unassignedMembers: 0,
    versions: [
      { version: 4, documentHash: "4".repeat(64), memberCount: 2 },
      { version: 3, documentHash: "3".repeat(64), memberCount: 1 },
    ],
  },
  remediation: {
    required: true,
    reasons: ["member_policy_update_required", "tool_review_required"],
    workspaceGrantRefresh: { status: "not_observed", trigger: "automatic_after_policy_save" },
    restartRequired: false,
  },
  delivery: {
    changeEventId: "2b37cc2b-e2c3-4d48-a30e-1d4dfda64d88",
    policyVersion: 3,
    changedAt: "2026-08-13T01:15:00.000Z",
    changedBy: "admin-owner",
    members: [
      {
        userId: "jane",
        displayName: "Jane Tan",
        email: "jane@example.test",
        workspaces: [{ workspaceId: "d877e406-ab44-43ef-8fbc-e1afe09ff27e", grantId: "personal", state: "ready", delivery: "failed", failureCode: "CONNECTOR_GRANT_REFRESH_FAILED" }],
      },
      {
        userId: "mike",
        displayName: "Mike Lee",
        email: "mike@example.test",
        workspaces: [{ workspaceId: "a5982e38-8a52-4611-9644-d1a80d3e6982", grantId: "research", state: "stopped", delivery: "applies_on_next_start", failureCode: null }],
      },
    ],
  },
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
      assert.equal(body.expectedAccessPolicyVersion, 1);
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
  await page.getByRole("button", { name: "Policy" }).click();

  await expect(page.locator(".tool-policy-change-summary")).toContainText("1 added, 1 changed, 1 removed");
  await expect(page.getByText("New provider tool. Blocked until reviewed.")).toBeVisible();
  await page.getByText("View current provider definition").click();
  await expect(page.locator(".tool-definition-preview pre")).toContainText("export-report");

  await page.getByRole("button", { name: "Save tool permissions" }).click();
  await expect.poll(() => saved).toBe(true);
  await expect(page.locator(".tool-policy-change-summary")).toHaveCount(0);
});

test("administrators can remove a customer-added connector from Connections", async ({ page }) => {
  let deleted = false;
  await page.route("**/api/v1/connections", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: deleted ? [] : [connector] }) });
  });
  await page.route("**/api/v1/admin/connectors/reports", async (route) => {
    assert.equal(route.request().method(), "DELETE");
    deleted = true;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ deleted: true }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connections" }).click();
  await page.getByRole("button", { name: "Manage" }).click();
  await expect(page.getByRole("heading", { name: "Remove connector" })).toBeVisible();
  await page.getByRole("button", { name: "Remove connector" }).click();
  await expect(page.getByRole("dialog")).toContainText("revokes everyone’s connection and workspace access");
  await page.getByRole("dialog").getByRole("button", { name: "Remove connector" }).click();

  await expect.poll(() => deleted).toBe(true);
  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
  await expect(page.getByText("Reports")).toHaveCount(0);
});

test("a stale tool-policy save fails visibly instead of overwriting a newer version", async ({ page }) => {
  await page.route("**/api/v1/connections", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: [connector] }) });
  });
  await page.route("**/api/v1/admin/connectors/reports/tool-policy", async (route) => {
    if (route.request().method() === "PUT") {
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      assert.equal(body.expectedAccessPolicyVersion, 1);
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({
        code: "CONNECTOR_POLICY_VERSION_CONFLICT",
        message: "This connector policy changed while you were editing it. Refresh and review the latest version before saving again.",
      }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(policy) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connections" }).click();
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByRole("button", { name: "Policy" }).click();
  await page.getByRole("button", { name: "Save tool permissions" }).click();

  await expect(page.getByText("This connector policy changed while you were editing it. Refresh and review the latest version before saving again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save tool permissions" })).toBeEnabled();
});

test("Exa appears as an available built-in connector in the Search category", async ({ page }) => {
  await page.route("**/api/v1/connections", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: [exaConnector] }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connections" }).click();

  const search = page.getByRole("region", { name: "Search" });
  await expect(search).toBeVisible();
  await expect(search.getByRole("heading", { name: "Exa" })).toBeVisible();
  await expect(search.getByText("Search the web")).toBeVisible();
  await expect(search.locator(".connector-mark.exa img")).toHaveAttribute("src", "/connector-icons/exa.png");
  await expect(search.getByRole("button", { name: "Connect" })).toBeEnabled();
});

test("administrators can read member controls, mixed tool decisions, drift, and honest remediation state", async ({ page }) => {
  let deliveryRetries = 0;
  await page.route("**/api/v1/connections", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      connections: [{ ...connector, membersCanManage: false }],
    }) });
  });
  await page.route("**/api/v1/admin/connectors/reports/effective-policy", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ policy: effectivePolicy }) });
  });
  await page.route("**/api/v1/admin/connectors/reports/tool-policy", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      ...policy,
      changes: { added: [], changed: [], removed: [] },
      tools: effectivePolicy.tools.map((tool) => ({
        name: tool.name,
        definitionHash: tool.observedDefinitionHash,
        displayName: tool.displayName,
        description: `${tool.displayName} through the Reports connector.`,
        service: "tools",
        risk: "reviewed",
        decision: tool.configuredDecision,
        reviewRequired: tool.reviewState !== "current",
      })),
    }) });
  });
  await page.route("**/api/v1/admin/connectors/reports/policy-delivery/retry", async (route) => {
    deliveryRetries += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspaceGrants: { refreshed: 1, failed: 0, appliesOnNextStart: 1, members: [] } }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connections" }).click();
  await page.getByRole("button", { name: "Manage" }).click();
  await expect(page.getByRole("heading", { name: "Connection ready" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connector access" })).toHaveCount(0);
  await page.getByRole("button", { name: "Policy" }).click();

  await expect(page.getByRole("heading", { name: "Control access and tool permissions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connector access" })).toBeVisible();
  const effective = page.getByRole("region", { name: "Application and workspace delivery" });
  await expect(effective).toBeVisible();
  await expect(effective.getByText("Members cannot manage connections")).toBeVisible();
  await expect(effective.getByText("Members cannot connect or disconnect their own account.")).toBeVisible();
  await expect(effective.getByRole("table", { name: "Effective connector tool policy" })).toHaveCount(0);
  const tools = page.locator(".tool-policy-list");
  await expect(tools.locator("label").filter({ hasText: "Search reports" })).toContainText("Effective nowAllowed");
  await expect(tools.locator("label").filter({ hasText: "Export report" })).toContainText("Effective nowApproval required");
  await expect(tools.locator("label").filter({ hasText: "Delete report" })).toContainText("Effective nowBlocked");
  await expect(tools.locator("label").filter({ hasText: "Upload report" })).toContainText("Review required");
  await expect(effective.getByText("1 of 3 active members need the current policy version.", { exact: true })).toBeVisible();
  await expect(effective.getByRole("region", { name: "Workspace delivery" })).toContainText("Jane Tan");
  await expect(effective.getByRole("region", { name: "Workspace delivery" })).toContainText("personal");
  await expect(effective.getByRole("region", { name: "Workspace delivery" })).toContainText("Retry needed");
  await expect(effective.getByRole("region", { name: "Workspace delivery" })).toContainText("Applies on next start");
  await effective.getByRole("button", { name: "Retry failed delivery" }).click();
  await expect.poll(() => deliveryRetries).toBe(1);
  await expect(effective.getByText(/records each workspace delivery attempt/)).toBeVisible();
  await expect(effective.getByText(/does not require a restart/)).toBeVisible();
  await page.setViewportSize({ width: 600, height: 900 });
  const mobileRow = tools.locator("label").filter({ hasText: "Search reports" });
  await expect(mobileRow.locator(".tool-policy-effective")).toBeVisible();
  await expect(mobileRow.locator(".select-menu-trigger")).toBeVisible();
});

test("the effective view makes a disabled connector and its denied tools explicit", async ({ page }) => {
  const disabledPolicy = {
    ...effectivePolicy,
    access: {
      ...effectivePolicy.access,
      configuredEnabled: false,
      effectiveDecision: "deny",
      membersCanManage: false,
      reason: "connector_disabled",
    },
    tools: effectivePolicy.tools.map((tool) => ({ ...tool, effectiveDecision: "deny" })),
    runtimeProjection: { ...effectivePolicy.runtimeProjection, state: "excluded", allowed: 0, approvalRequired: 0, denied: 4 },
    policyApplication: { ...effectivePolicy.policyApplication, state: "not_applicable", currentVersion: null, activeMembers: 0, currentMembers: 0, remediationRequiredMembers: 0, versions: [] },
    remediation: { ...effectivePolicy.remediation, reasons: ["policy_change_required"] },
  };
  await page.route("**/api/v1/connections", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      connections: [{ ...connector, enabled: false, membersCanManage: false }],
    }) });
  });
  await page.route("**/api/v1/admin/connectors/reports/effective-policy", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ policy: disabledPolicy }) });
  });
  await page.route("**/api/v1/admin/connectors/reports/tool-policy", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(policy) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connections" }).click();
  await page.getByRole("button", { name: "Manage" }).click();

  await expect(page.getByRole("heading", { name: "Disabled by your organization" })).toBeVisible();
  await page.getByRole("button", { name: "Policy" }).click();
  const effective = page.getByRole("region", { name: "Application and workspace delivery" });
  await expect(effective.locator(".connector-effective-access")).toHaveText("Blocked");
  await expect(page.locator(".tool-policy-list label").filter({ hasText: "Search reports" })).toContainText("Blocked");
  await expect(page.getByRole("checkbox", { name: "Connector enabled" })).not.toBeChecked();
});
