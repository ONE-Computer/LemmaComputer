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

const figmaConnector = {
  ...exaConnector,
  id: "figma",
  serverName: "lemmacomputer_figma",
  name: "Figma",
  shortDescription: "Use design context from Figma files",
  category: "Productivity",
  brand: "figma",
};

const officeAndFinanceConnectors = [
  {
    ...exaConnector,
    id: "gmail",
    serverName: "lemmacomputer_gmail",
    name: "Gmail",
    shortDescription: "Search mail and prepare follow-ups",
    category: "Productivity",
    brand: "google",
  },
  {
    ...exaConnector,
    id: "canva",
    serverName: "lemmacomputer_canva",
    name: "Canva",
    shortDescription: "Create and update designs with approved assets",
    category: "Productivity",
    brand: "canva",
  },
  {
    ...exaConnector,
    id: "alpha-vantage",
    serverName: "lemmacomputer_alpha_vantage",
    name: "Alpha Vantage",
    shortDescription: "Research market prices, fundamentals, and macro data",
    category: "Data and analytics",
    brand: "alpha-vantage",
  },
];

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
  await page.getByRole("button", { name: "Connectors" }).click();
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

test("administrators can remove a customer-added connector from Connectors", async ({ page }) => {
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
  await page.getByRole("button", { name: "Connectors" }).click();
  await page.getByRole("button", { name: "Manage" }).click();
  await expect(page.getByRole("heading", { name: "Remove connector" })).toBeVisible();
  await page.getByRole("button", { name: "Remove connector" }).click();
  await expect(page.getByRole("dialog")).toContainText("revokes everyone’s connection and workspace access");
  await page.getByRole("dialog").getByRole("button", { name: "Remove connector" }).click();

  await expect.poll(() => deleted).toBe(true);
  await expect(page.getByRole("heading", { name: "Connectors" })).toBeVisible();
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
  await page.getByRole("button", { name: "Connectors" }).click();
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByRole("button", { name: "Policy" }).click();
  await page.getByRole("button", { name: "Save tool permissions" }).click();

  await expect(page.getByText("This connector policy changed while you were editing it. Refresh and review the latest version before saving again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save tool permissions" })).toBeEnabled();
});

test("Exa and Figma use their locally served official marks", async ({ page }) => {
  await page.route("**/api/v1/connections", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: [exaConnector, figmaConnector] }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connectors" }).click();

  const search = page.getByRole("region", { name: "Search" });
  await expect(search).toBeVisible();
  await expect(search.getByRole("heading", { name: "Exa" })).toBeVisible();
  await expect(search.getByText("Search the web")).toBeVisible();
  await expect(search.locator(".connector-mark.exa img")).toHaveAttribute("src", "/connector-icons/exa.svg");
  await expect(search.getByRole("button", { name: "Connect" })).toBeEnabled();

  const productivity = page.getByRole("region", { name: "Productivity" });
  await expect(productivity.getByRole("heading", { name: "Figma" })).toBeVisible();
  await expect(productivity.locator(".connector-mark.figma img")).toHaveAttribute("src", "/connector-icons/figma.svg");
});

test("office and finance catalog cards are available in their respective categories", async ({ page }) => {
  await page.route("**/api/v1/connections", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: officeAndFinanceConnectors }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connectors" }).click();

  const productivity = page.getByRole("region", { name: "Productivity" });
  await expect(productivity.getByRole("heading", { name: "Gmail" })).toBeVisible();
  await expect(productivity.locator(".connector-mark.google img")).toHaveAttribute("src", "/connector-icons/google.svg");
  await expect(productivity.getByRole("heading", { name: "Canva" })).toBeVisible();
  await expect(productivity.getByRole("button", { name: "Connect" })).toHaveCount(2);

  const analytics = page.getByRole("region", { name: "Data and analytics" });
  await expect(analytics.getByRole("heading", { name: "Alpha Vantage" })).toBeVisible();
  await expect(analytics.getByText("Research market prices, fundamentals, and macro data")).toBeVisible();
  await expect(analytics.getByRole("button", { name: "Connect" })).toBeEnabled();
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
  await page.getByRole("button", { name: "Connectors" }).click();
  await page.getByRole("button", { name: "Manage" }).click();
  await expect(page.getByRole("heading", { name: "Connection ready" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connector access" })).toHaveCount(0);
  await page.getByRole("button", { name: "Policy" }).click();

  await expect(page.getByRole("heading", { name: "Control access and tool permissions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connector access" })).toBeVisible();
  const effective = page.getByRole("region", { name: "Connector policy and workspace delivery" });
  await expect(effective).toBeVisible();
  await expect(effective.getByText("Members cannot manage connections")).toBeVisible();
  await expect(effective.getByText("Members cannot connect or disconnect their own account.")).toBeVisible();
  await expect(effective.getByRole("table", { name: "Effective connector tool policy" })).toHaveCount(0);
  const tools = page.locator(".tool-policy-list");
  await expect(tools.locator("label").filter({ hasText: "Search reports" })).toContainText("Effective nowAllowed");
  await expect(tools.locator("label").filter({ hasText: "Export report" })).toContainText("Effective nowApproval required");
  await expect(tools.locator("label").filter({ hasText: "Delete report" })).toContainText("Effective nowBlocked");
  await expect(tools.locator("label").filter({ hasText: "Upload report" })).toContainText("Review required");
  await expect(effective.getByText("1 member with a workspace uses an older workspace policy.", { exact: true })).toBeVisible();
  await expect(effective.getByRole("button", { name: "Review workspace policies" })).toBeVisible();
  await expect(effective.getByRole("region", { name: "Workspace delivery" })).toContainText("Jane Tan");
  await expect(effective.getByRole("region", { name: "Workspace delivery" })).toContainText("personal");
  await expect(effective.getByRole("region", { name: "Workspace delivery" })).toContainText("Retry needed");
  await expect(effective.getByRole("region", { name: "Workspace delivery" })).toContainText("Waiting for start");
  await effective.getByRole("button", { name: "Retry failed delivery" }).click();
  await expect.poll(() => deliveryRetries).toBe(1);
  await expect(effective.getByText(/receives the current policy when it next starts/)).toBeVisible();
  await expect(effective.getByText(/does not require another restart/)).toBeVisible();
  await page.setViewportSize({ width: 600, height: 900 });
  const mobileRow = tools.locator("label").filter({ hasText: "Search reports" });
  await expect(mobileRow.locator(".tool-policy-effective")).toBeVisible();
  await expect(mobileRow.locator(".select-menu-trigger")).toBeVisible();
  await effective.getByRole("button", { name: "Review workspace policies" }).click();
  await expect(page).toHaveURL(/view=home.*section=policies/);
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
  await page.getByRole("button", { name: "Connectors" }).click();
  await page.getByRole("button", { name: "Manage" }).click();

  await expect(page.getByRole("heading", { name: "Disabled by your organization" })).toBeVisible();
  await page.getByRole("button", { name: "Policy" }).click();
  const effective = page.getByRole("region", { name: "Connector policy and workspace delivery" });
  await expect(effective.locator(".connector-effective-access")).toHaveText("Blocked");
  await expect(page.locator(".tool-policy-list label").filter({ hasText: "Search reports" })).toContainText("Blocked");
  await expect(page.getByRole("checkbox", { name: "Connector enabled" })).not.toBeChecked();
});

test("an administrator sets up a provider application for their own organization", async ({ page }) => {
  const gmail = {
    ...exaConnector,
    id: "gmail",
    serverName: "lemmacomputer_gmail",
    name: "Gmail",
    shortDescription: "Search mail and prepare follow-ups",
    description: "Use the Gmail messages, drafts, and mailbox context your Google Workspace account authorizes.",
    services: ["Mail", "Drafts", "Search"],
    brand: "gmail",
    canAdministerConnector: true,
    activation: {
      readiness: "setup_required",
      action: "view_setup",
      message: "This service needs an OAuth application from your organization before anyone can connect it.",
    },
    credentials: {
      required: true,
      mode: "deployment",
      deploymentConfigured: false,
      clientId: null,
      updatedAt: null,
      redirectUri: "http://localhost:4174/oauth/mcp/callback",
      setup: {
        console: "Google Cloud console",
        consoleUrl: "https://console.cloud.google.com/auth/clients",
        clientType: "Web application",
        steps: ["Select or create a project in the Google Cloud console.", "Enable the Gmail API for that project."],
        scopes: ["https://mail.google.com/", "https://www.googleapis.com/auth/gmail.modify"],
        scopesNote: "Add these under Data Access.",
      },
    },
  };
  const configured = {
    ...gmail,
    serverName: "lemmacomputer_gmail_2f1c8b7a4d6e4f2b8c0a9d3e5f7b1c2d",
    activation: { readiness: "ready", action: "connect", message: "This approved service is ready to connect." },
    credentials: {
      required: true,
      mode: "tenant",
      deploymentConfigured: false,
      clientId: "acme-client.apps.googleusercontent.com",
      updatedAt: "2026-08-16T09:00:00.000Z",
    },
  };
  let saved: Record<string, unknown> | null = null;
  await page.route("**/api/v1/connections", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: [saved ?? gmail] }) });
  });
  await page.route("**/api/v1/admin/connectors/gmail/credentials", async (route) => {
    assert.equal(route.request().method(), "PUT");
    assert.deepEqual(route.request().postDataJSON(), {
      clientId: "acme-client.apps.googleusercontent.com",
      clientSecret: "acme-client-secret",
    });
    saved = configured;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connector: configured }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connectors" }).click();
  // Nothing is configured, so the card offers setup rather than a Connect that
  // could only fail at the provider's authorize endpoint.
  await page.getByRole("button", { name: "View setup" }).click();
  await expect(page.getByRole("heading", { name: "Organization setup required" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Gmail" })).toHaveCount(0);

  const application = page.getByRole("region", { name: "Provider application" });
  await expect(application).toContainText("No application is configured yet");

  // The console steps, the scopes, and the redirect URI are the three things
  // people get wrong, and each fails at the provider with an error that says
  // nothing about the cause. They stay collapsed until asked for.
  const help = application.getByText("How to create this application in Google Cloud console");
  await expect(application.getByRole("listitem").first()).toBeHidden();
  await help.click();
  await expect(application.getByText("Enable the Gmail API for that project.")).toBeVisible();
  await expect(application.getByText("https://www.googleapis.com/auth/gmail.modify")).toBeVisible();
  await expect(application.getByLabel("Redirect URI for the Web application"))
    .toHaveValue("http://localhost:4174/oauth/mcp/callback");
  await application.getByLabel("Client ID").fill("acme-client.apps.googleusercontent.com");
  await application.getByLabel("Client secret").fill("acme-client-secret");
  await application.getByRole("button", { name: "Save application" }).click();

  await expect(application).toContainText("acme-client.apps.googleusercontent.com");
  await expect(page.getByRole("heading", { name: "Connect Gmail" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Gmail" })).toBeEnabled();
  // The secret is write-only: it is never rendered back into the page.
  await expect(page.locator("body")).not.toContainText("acme-client-secret");
});

test("an employee who cannot approve Microsoft 365 gets a link to send to their administrator", async ({ page }) => {
  const microsoft = {
    ...exaConnector,
    id: "microsoft-365",
    serverName: "lemmacomputer_ms365",
    name: "Microsoft 365",
    shortDescription: "Mail, calendar, files, and Teams",
    description: "Use approved Microsoft 365 tools through the LemmaComputer AI gateway.",
    services: ["Outlook Mail", "Calendar", "OneDrive", "Teams"],
    policySupport: "governed",
    brand: "microsoft",
    canAdministerConnector: false,
    credentials: null,
    adminConsent: { required: true, available: true, grantedAt: null, providerTenantId: null },
  };
  const consentUrl = "https://login.microsoftonline.com/organizations/v2.0/adminconsent"
    + "?client_id=11111111-2222-3333-4444-555555555555"
    + "&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default"
    + "&redirect_uri=http%3A%2F%2Flocalhost%3A4174%2Fapi%2Fv1%2Fconnections%2Fmicrosoft-365%2Fadmin-consent%2Fcallback"
    + "&state=signed-state-value";
  await page.route("**/api/v1/connections", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: [microsoft] }) });
  });
  await page.route("**/api/v1/connections/microsoft-365/admin-consent", async (route) => {
    assert.equal(route.request().method(), "GET");
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      connectorId: "microsoft-365",
      connectorName: "Microsoft 365",
      consentUrl,
      redirectUri: "http://localhost:4174/api/v1/connections/microsoft-365/admin-consent/callback",
      expiresAt: "2026-09-15T00:00:00.000Z",
    }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connectors" }).click();
  // Connect is still offered, because a directory that already approved the
  // application out of band can use it. What was missing is any route to the
  // approval for a person in a directory that has not.
  await expect(page.locator(".connector-catalog-action").getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approval" }).click();

  // The employee is told what is blocking them and why they cannot fix it
  // themselves, instead of being sent to a Microsoft page they cannot act on.
  const approval = page.getByRole("region", { name: "Administrator approval" });
  await expect(approval).toContainText("no individual can approve for themselves");
  // A single-tenant installation whose operator already consented in the Entra
  // portal must not be told it is blocked, so the copy covers both directories.
  await expect(approval).toContainText("already approved it there, you can connect now");
  await approval.getByRole("button", { name: "Get approval link" }).click();
  await expect(approval.getByLabel("Approval link")).toHaveValue(consentUrl);
  // Clearing the record is an administrator action, and this person is not one.
  await expect(approval.getByRole("button", { name: "Clear approval record" })).toHaveCount(0);
});

test("Microsoft 365 administrators can grant and verify a selected SharePoint site", async ({ page }) => {
  const microsoft = {
    ...exaConnector,
    id: "microsoft-365",
    serverName: "lemmacomputer_ms365",
    name: "Microsoft 365",
    shortDescription: "Mail, calendar, files, SharePoint, and Teams",
    description: "Use approved Microsoft 365 tools through the LemmaComputer AI gateway.",
    services: ["Outlook Mail", "Calendar", "OneDrive", "SharePoint", "Teams"],
    policySupport: "governed",
    brand: "microsoft",
    state: "connected",
    connectedAt: "2026-08-25T01:00:00.000Z",
    account: { displayName: "Alex Morgan", email: "alex@acme.example", userPrincipalName: "alex@acme.example" },
    canAdministerConnector: true,
    canManageConnection: true,
    adminConsent: { required: true, available: true, grantedAt: "2026-08-24T01:00:00.000Z", providerTenantId: "11111111-2222-3333-4444-555555555555" },
  };
  let sites: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/connections", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: [microsoft] }) });
  });
  await page.route("**/api/v1/connections/microsoft-365", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(microsoft) });
  });
  await page.route("**/api/v1/admin/connectors/microsoft-365/sharepoint-sites", async (route) => {
    if (route.request().method() === "POST") {
      const input = JSON.parse(route.request().postData() ?? "{}") as { displayName: string; siteUrl: string };
      sites = [{
        id: "2b37cc2b-e2c3-4d48-a30e-1d4dfda64d88",
        displayName: input.displayName,
        siteUrl: input.siteUrl,
        hostname: "contoso.sharepoint.com",
        sitePath: "sites/Finance",
        status: "pending",
        microsoftAccessStatus: "granted",
        microsoftGrantedAt: "2026-08-25T02:00:00.000Z",
        microsoftLastError: null,
        lastVerifiedAt: null,
        lastVerificationError: null,
        createdAt: "2026-08-25T02:00:00.000Z",
      }];
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ site: sites[0] }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ microsoftSiteAdministrationAvailable: true, sites }) });
  });
  await page.route("**/api/v1/admin/connectors/microsoft-365/sharepoint-sites/*/verify", async (route) => {
    sites = sites.map((site) => ({ ...site, status: "verified", lastVerifiedAt: "2026-08-25T02:01:00.000Z" }));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ site: sites[0] }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connectors" }).click();
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByRole("button", { name: "SharePoint sites" }).click();

  await expect(page.getByRole("heading", { name: "Choose the SharePoint sites agents can use" })).toBeVisible();
  await expect(page.getByText("Microsoft-enforced, site-specific access")).toBeVisible();
  await page.getByLabel("Site name").fill("Finance policies");
  await page.getByLabel("SharePoint site URL").fill("https://contoso.sharepoint.com/sites/Finance");
  await page.getByRole("button", { name: "Add and grant" }).click();
  await expect(page.getByRole("heading", { name: "Finance policies" })).toBeVisible();
  await expect(page.getByText("Microsoft: Read granted")).toBeVisible();
  await expect(page.getByText("Agent: Not verified")).toBeVisible();
  await page.getByRole("button", { name: "Verify agent access" }).click();
  await expect(page.getByText("Agent: Verified", { exact: true })).toBeVisible();
});
