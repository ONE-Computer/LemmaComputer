import http from "node:http";

const port = Number(process.env.UI_FIXTURE_PORT ?? 4199);
const now = new Date().toISOString();
const workspaceId = "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
const digest = "a".repeat(64);
const bundleDigest = "b".repeat(64);

const session = {
  user: {
    id: "alex-morgan",
    displayName: "Mike Sun",
    email: "mike@metech.dev",
  },
  tenant: { id: "acme", displayName: "ME TECH" },
  roles: ["employee", "administrator"],
};

const workspace = {
  id: workspaceId,
  grantId: "personal",
  state: "ready",
  readiness: { identity: "ready", network: "ready", models: "ready", tools: "ready" },
  applications: ["firefox"],
  agents: [
    { id: "claude-desktop", displayName: "Claude Desktop", clientVersion: "1.22209.3", agentId: "agent-alex:claude", state: "ready" },
    { id: "hermes-claw", displayName: "Hermes Agent CLI", clientVersion: "0.19.0", agentId: "agent-alex:hermes", state: "ready" },
  ],
  modelRoute: {
    alias: "onecomputer-glm",
    status: "ready",
    fallback: "none",
    budget: { limitUsd: 1, spentUsd: 0.2, remainingUsd: 0.8, duration: "30d", resetsAt: null },
    limits: { requestsPerMinute: 30, tokensPerMinute: 50000, maxParallelRequests: 4 },
  },
  policyIntegrity: {
    state: "match",
    reasonCode: "POLICY_INTEGRITY_MATCH",
    expected: { version: 7, digest },
    projected: { version: 7, digest, bundleDigest, keyId: "psk_policy_fixture", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    enforced: { version: 7, digest, bundleDigest, keyId: "psk_policy_fixture", verifiedAt: now },
  },
  policyAssignment: { version: 7, hash: digest },
  profile: {
    id: "claude-desktop-standard-v1",
    client: "ONEComputer managed workspace",
    clientVersion: "managed-v1",
    modelAlias: "onecomputer-glm",
    executionMode: "managed",
    egressMode: "restricted",
    persistence: "persistent-home",
    network: "gateway-only",
  },
};

const sandboxWorkspace = {
  ...workspace,
  id: "3c536c1f-6a31-427d-af8f-dbb0c63f8d70",
  grantId: "sandbox-research",
  state: "stopped",
  readiness: { identity: "checking", network: "checking", models: "checking", tools: "checking" },
  applications: ["google-chrome"],
  agents: [
    { id: "hermes-desktop", displayName: "Hermes Agent Desktop", clientVersion: "0.17.0", agentId: "agent-alex:research", state: "selected" },
  ],
  modelRoute: undefined,
  policyAssignment: { version: 4, hash: digest },
  profile: {
    id: "disposable-open-v1",
    client: "ONEComputer open workspace",
    clientVersion: "disposable-open-v1",
    modelAlias: "onecomputer-openai",
    executionMode: "disposable-open",
    egressMode: "full-web",
    persistence: "persistent-home",
    network: "gateway-only",
  },
};

const profile = {
  id: "claude-desktop-standard-v1",
  version: 1,
  displayName: "Managed workspace",
  description: "A restricted workspace for any selected AI agent, routed through organization-approved models, tools, and destinations.",
  executionMode: "managed",
  egressMode: "restricted",
  dataGuidance: "Use for organization work. Local tools and public destinations remain policy restricted.",
  client: "ONEComputer managed workspace",
  clientVersion: "managed-v1",
  persistence: "persistent-home",
  network: "gateway-only",
  resources: { cpus: 2, memoryGiB: 4 },
};

const disposableProfile = {
  id: "disposable-open-v1",
  version: 1,
  displayName: "Disposable open workspace",
  description: "A flexible workspace with local coding tools and public web access inside the isolated Kasm boundary.",
  executionMode: "disposable-open",
  egressMode: "full-web",
  dataGuidance: "Non-sensitive work only. Delete permanently removes the workspace.",
  client: "ONEComputer open workspace",
  clientVersion: "disposable-open-v1",
  persistence: "persistent-home",
  network: "gateway-only",
  resources: { cpus: 2, memoryGiB: 4 },
};

const availableApplications = [
  {
    id: "firefox",
    displayName: "Firefox ESR",
    category: "Browser",
    version: "140.12.0esr",
    description: "Managed browser locked to the governed egress proxy.",
  },
  {
    id: "google-chrome",
    displayName: "Google Chrome",
    category: "Browser",
    version: "150.0.7871.186",
    description: "Pinned Chrome browser locked to the governed egress proxy.",
  },
];

const availableAgents = [
  {
    id: "claude-desktop",
    displayName: "Claude Desktop",
    clientVersion: "1.22209.3",
    description: "Managed desktop client routed through ONEComputer.",
    license: "Anthropic commercial distribution",
    source: "https://downloads.claude.ai/claude-desktop/apt/stable/",
    artifactSha256: "d427f46ac9233dbc4d8a441a602f09f750b8a5f05d1fc7a00285d7a6ce07655c",
    resources: { memoryMiB: 1536 },
  },
  {
    id: "claude-cli",
    displayName: "Claude CLI",
    clientVersion: "2.1.215",
    description: "Pinned Claude CLI routed through its own governed ONEComputer identity.",
    license: "Anthropic commercial distribution",
    source: "https://downloads.claude.ai/claude-code-releases/2.1.215/linux-x64/claude.zst",
    artifactSha256: "7ff9594e53cd89d1af9ceb3c18d3d70be1a5c6d27475e31ee2bed65d748f18c0",
    resources: { memoryMiB: 1024 },
  },
  {
    id: "hermes-desktop",
    displayName: "Hermes Agent Desktop",
    clientVersion: "0.17.0",
    description: "Native Hermes Agent desktop client with a separately governed backend.",
    license: "MIT",
    source: "https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.20",
    artifactSha256: "285f3fc134ff466a90065e1517801a68993733b807158ee8f32aa01613786990",
    resources: { memoryMiB: 1536 },
  },
  {
    id: "hermes-claw",
    displayName: "Hermes Agent CLI",
    clientVersion: "0.19.0",
    description: "Pinned Hermes Agent CLI configured as a governed ONEComputer client.",
    license: "MIT",
    source: "https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.20",
    artifactSha256: "285f3fc134ff466a90065e1517801a68993733b807158ee8f32aa01613786990",
    resources: { memoryMiB: 1024 },
  },
];

let sandboxSettings = {
  grantId: "personal",
  profileId: profile.id,
  applicationIds: ["firefox"],
  modelAlias: "onecomputer-glm",
  profile,
  availableProfiles: [profile, disposableProfile],
  availableApplications,
  availableModels: [{ alias: "onecomputer-glm", displayName: "GLM", provider: "Z.ai" }],
  agentIds: ["claude-desktop", "hermes-claw"],
  availableAgents,
  configuration: {
    schemaVersion: 1,
    profileId: profile.id,
    applicationIds: ["firefox"],
    agentIds: ["claude-desktop", "hermes-claw"],
    modelAlias: "onecomputer-glm",
    egress: null,
  },
  updatedAt: null,
};

const operation = {
  id: "00000000-0000-4000-8000-000000000001",
  state: "succeeded",
  safeSummary: "Delete protected OneDrive draft",
  action: "Delete OneDrive item",
  resourceName: "Q3-draft.docx",
  resourceLocation: "OneDrive · Finance",
  requestedAt: now,
  updatedAt: now,
  requestedBy: "Mike Sun",
  operationDigest: "c".repeat(64),
  toolName: "delete-drive-item",
  agentId: "agent-alex:claude",
  policyVersionId: "policy-version-7",
  requiredApprovalChannel: "openvtc-task-consent",
  receipt: { resultSummary: "The approved file deletion completed." },
};

const chatSession = {
  id: "fixture-session-1",
  title: "Quarterly planning",
  createdAt: now,
  updatedAt: now,
  agentCatalogId: "hermes-claw",
};
let chatMessages = [
  {
    id: "fixture-user-message-1",
    role: "user",
    metadata: { agentCatalogId: "hermes-claw", state: "completed", createdAt: now },
    parts: [{ type: "text", text: "Delete the disposable planning draft after checking it.", state: "done" }],
  },
  {
    id: "fixture-assistant-message-1",
    role: "assistant",
    metadata: { agentCatalogId: "hermes-claw", turnId: "fixture-turn-1", state: "completed", createdAt: now },
    parts: [
      { type: "data-progress", id: "fixture-progress-1", data: { activityId: "fixture-progress-1", label: "Work complete", state: "completed" } },
      { type: "data-tool", id: "fixture-tool-1", data: { toolCallId: "fixture-tool-1", name: "get-drive-item", state: "completed", summary: "File metadata checked" } },
      { type: "data-approval", id: "fixture-approval-1", data: { approvalId: "fixture-approval-1", toolCallId: "fixture-tool-2", operationId: "00000000-0000-4000-8000-000000000001", state: "approval_required", summary: "Waiting for signed approval" } },
      { type: "text", text: "The protected deletion is waiting for your signed approval. The file has not been deleted.", state: "done" },
      { type: "data-terminal", id: "terminal-fixture-turn-1", data: { turnId: "fixture-turn-1", state: "completed" } },
    ],
  },
];

let fixtureSchedules = [{
  id: "5c536c1f-6a31-427d-af8f-dbb0c63f8d71",
  title: "Weekday project summary",
  workspaceId,
  agentCatalogId: "hermes-claw",
  prompt: "Summarize the current project status, open decisions, and the next useful action.",
  cronExpression: "0 9 * * 1-5",
  timeZone: "Asia/Singapore",
  state: "enabled",
  nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
  lastRunAt: new Date(Date.now() - 86_400_000).toISOString(),
  createdAt: now,
  updatedAt: now,
}];
const fixtureScheduleRuns = new Map([[fixtureSchedules[0].id, [{
  id: "6c536c1f-6a31-427d-af8f-dbb0c63f8d72",
  scheduleId: fixtureSchedules[0].id,
  scheduledFor: new Date(Date.now() - 86_400_000).toISOString(),
  state: "succeeded",
  sessionId: chatSession.id,
  failureCode: null,
  failureSummary: null,
  startedAt: new Date(Date.now() - 86_400_000).toISOString(),
  completedAt: new Date(Date.now() - 86_399_000).toISOString(),
  createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  updatedAt: new Date(Date.now() - 86_399_000).toISOString(),
}]]]);

let egressSecurityGroups = [{
  schemaVersion: 1,
  id: "egv_fixture_default_v1",
  securityGroupId: "esg_fixture_default",
  tenantId: session.tenant.id,
  version: 1,
  name: "Default security group",
  description: "The built-in network policy attached to new workspaces.",
  defaultAction: "allow-public-http-https",
  rules: [],
  documentHash: digest,
  createdBy: session.user.id,
  createdAt: now,
  isDefault: true,
}, {
  schemaVersion: 1,
  id: "egv_fixture_agent_updates_v1",
  securityGroupId: "esg_fixture_agent_updates",
  tenantId: session.tenant.id,
  version: 1,
  name: "Approved agent updates",
  description: "Allow approved update services and block untrusted download hosts.",
  defaultAction: "deny",
  rules: [
    { id: "claude-downloads", action: "allow", protocol: "https", host: "downloads.claude.ai", includeSubdomains: false, port: 443, purpose: "Download approved Claude Desktop updates" },
    { id: "anthropic-api", action: "allow", protocol: "https", host: "api.anthropic.com", includeSubdomains: false, port: 443, purpose: "Connect approved Anthropic services" },
    { id: "blocked-downloads", action: "deny", protocol: "https", host: "untrusted-downloads.example", includeSubdomains: true, port: 443, purpose: "Block untrusted downloads in open workspaces" },
  ],
  documentHash: digest,
  createdBy: session.user.id,
  createdAt: now,
  isDefault: false,
}];

const firewallWorkspaces = (group) => [
  {
    id: workspace.id,
    grantId: workspace.grantId,
    state: workspace.state,
    profileId: workspace.profile.id,
    executionMode: "managed",
    egressMode: "restricted",
    egress: { ...group, schemaVersion: 2, mode: "restricted" },
  },
  {
    id: sandboxWorkspace.id,
    grantId: sandboxWorkspace.grantId,
    state: sandboxWorkspace.state,
    profileId: "disposable-open-v1",
    executionMode: "disposable-open",
    egressMode: "full-web",
    egress: {
      ...group,
      schemaVersion: 2,
      mode: "full-web",
      defaultAction: "allow-public-http-https",
      rules: group.rules.filter((rule) => rule.action === "deny"),
    },
  },
];

let adminUsers = [
  {
    userId: session.user.id,
    email: session.user.email,
    displayName: session.user.displayName,
    roles: session.roles,
    effectivePolicy: { egressSecurityGroup: egressSecurityGroups[0] },
    workspaces: firewallWorkspaces(egressSecurityGroups[0]),
  },
  {
    userId: "hello-metech",
    email: "hello@metech.dev",
    displayName: "METECH",
    roles: ["employee"],
    effectivePolicy: null,
  },
];
let fixtureWorkspaces = [workspace, sandboxWorkspace];
let fixtureMcpConnections = [
  {
    id: "microsoft-365",
    serverName: "onecomputer_ms365",
    name: "Microsoft 365",
    shortDescription: "Mail, calendar, files, and Teams",
    description: "Use approved Microsoft 365 tools through the ONEComputer AI gateway.",
    category: "Productivity",
    services: ["Outlook Mail", "Calendar", "OneDrive", "Teams"],
    policySupport: "governed",
    brand: "microsoft",
    available: true,
    state: "connected",
    connectedAt: now,
    expiresAt: null,
    account: { displayName: "Mike Sun", email: "mike@metech.dev", userPrincipalName: "mike@metech.dev" },
  },
  {
    id: "notion",
    serverName: "onecomputer_notion",
    name: "Notion",
    shortDescription: "Search and update workspace knowledge",
    description: "Search and update the pages, databases, and knowledge your Notion account can access.",
    category: "Productivity",
    services: ["Pages", "Databases", "Search"],
    policySupport: "automatic",
    brand: "notion",
    available: true,
    state: "disconnected",
    connectedAt: null,
    expiresAt: null,
    account: null,
  },
  {
    id: "linear",
    serverName: "onecomputer_linear",
    name: "Linear",
    shortDescription: "Plan projects, issues, and product work",
    description: "Plan and follow product work across the issues, projects, and comments your account can access.",
    category: "Productivity",
    services: ["Issues", "Projects", "Comments"],
    policySupport: "automatic",
    brand: "linear",
    available: true,
    state: "connected",
    connectedAt: now,
    expiresAt: null,
    account: null,
  },
  {
    id: "atlassian",
    serverName: "onecomputer_atlassian",
    name: "Atlassian",
    shortDescription: "Work across Jira and Confluence",
    description: "Bring approved Jira work and Confluence knowledge into your workspace.",
    category: "Productivity",
    services: ["Jira", "Confluence", "Teamwork Graph"],
    policySupport: "automatic",
    brand: "atlassian",
    available: true,
    state: "disconnected",
    connectedAt: null,
    expiresAt: null,
    account: null,
  },
  {
    id: "github",
    serverName: "onecomputer_github",
    name: "GitHub",
    shortDescription: "Repositories, issues, and pull requests",
    description: "Work with repositories, issues, and pull requests allowed by your GitHub organization.",
    category: "Developer tools",
    services: ["Repositories", "Issues", "Pull requests"],
    policySupport: "automatic",
    brand: "github",
    available: true,
    state: "disconnected",
    connectedAt: null,
    expiresAt: null,
    account: null,
  },
];

const responses = new Map([
  ["GET /v1/auth/session", session],
  ["GET /v1/workspaces/current", workspace],
  ["GET /v1/workspaces", { workspaces: [workspace, sandboxWorkspace] }],
  ["GET /v1/sandbox-settings", sandboxSettings],
  ["GET /v1/operations/recent", operation],
  ["GET /v1/operations", { operations: [operation] }],
  [`GET /v1/operations/${operation.id}/audit`, {
    operationId: operation.id,
    events: [{
      eventType: "operation_succeeded",
      createdAt: now,
      correlationId: "fixture-correlation-id",
    }],
  }],
  ["GET /v1/connections/microsoft-365", fixtureMcpConnections[0]],
  ["GET /v1/credentials", {
    credentials: [{
      id: "72b8576c-83f1-4c7b-bbcb-6d4d50fbab24",
      kind: "telegram_bot_token",
      displayName: "@onecomputer_demo_bot",
      botUsername: "onecomputer_demo_bot",
      version: 1,
      workspaceId,
      connectionId: "92b8576c-83f1-4c7b-bbcb-6d4d50fbab24",
      updatedAt: now,
    }],
  }],
  [`GET /v1/workspaces/${workspaceId}/channels/telegram`, {
    state: "connected",
    connectionId: "92b8576c-83f1-4c7b-bbcb-6d4d50fbab24",
    workspaceId,
    credentialId: "72b8576c-83f1-4c7b-bbcb-6d4d50fbab24",
    allowedUserIds: ["10001"],
    allowedUserCount: 1,
    defaultAgentId: "hermes-claw",
    allowAgentSwitch: true,
    botUsername: "onecomputer_demo_bot",
    tokenVersion: 1,
    updatedAt: now,
  }],
  [`GET /v1/workspaces/${workspaceId}/chat/agents`, { workspaceId, agents: [{ catalogId: "hermes-claw", displayName: "Hermes Agent CLI", state: "ready", reasonCode: "CHAT_AGENT_READY" }] }],
  [`GET /v1/workspaces/${workspaceId}/chat/agents/hermes-claw/status`, { workspaceId, catalogId: "hermes-claw", displayName: "Hermes Agent CLI", state: "ready", reasonCode: "CHAT_AGENT_READY" }],
  [`GET /v1/workspaces/${workspaceId}/chat/agents/hermes-claw/sessions`, { sessions: [chatSession] }],
  [`GET /v1/workspaces/${workspaceId}/chat/agents/hermes-claw/sessions/${chatSession.id}/messages`, { messages: chatMessages }],
  ["GET /v1/openvtc/approvers/current", { connected: false, executorDid: "did:key:z6MkFixture", approver: null }],
  ["GET /v1/openvtc/companion/config", { enabled: false, vapidPublicKey: null }],
  ["GET /v1/openvtc/companions", { companions: [] }],
]);

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const key = `${request.method} ${url.pathname}`;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  if (key === "GET /v1/workspaces") {
    response.end(JSON.stringify({ workspaces: fixtureWorkspaces }));
    return;
  }
  if (key === "GET /v1/schedules") {
    response.end(JSON.stringify({ schedules: fixtureSchedules }));
    return;
  }
  if (key === "POST /v1/schedules") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const saved = {
        ...input,
        id: crypto.randomUUID(),
        nextRunAt: input.state === "enabled" ? new Date(Date.now() + 86_400_000).toISOString() : null,
        lastRunAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      fixtureSchedules = [saved, ...fixtureSchedules];
      response.statusCode = 201;
      response.end(JSON.stringify(saved));
    });
    return;
  }
  if (request.method === "PATCH" && /^\/v1\/schedules\/[0-9a-f-]+$/.test(url.pathname)) {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const id = url.pathname.split("/").at(-1);
      const input = JSON.parse(body);
      const current = fixtureSchedules.find((item) => item.id === id);
      const saved = {
        ...current,
        ...input,
        nextRunAt: input.state === "paused"
          ? null
          : input.state === "enabled"
            ? new Date(Date.now() + 86_400_000).toISOString()
            : current.nextRunAt,
        updatedAt: new Date().toISOString(),
      };
      fixtureSchedules = fixtureSchedules.map((item) => item.id === id ? saved : item);
      response.end(JSON.stringify(saved));
    });
    return;
  }
  if (request.method === "DELETE" && /^\/v1\/schedules\/[0-9a-f-]+$/.test(url.pathname)) {
    const id = url.pathname.split("/").at(-1);
    fixtureSchedules = fixtureSchedules.filter((item) => item.id !== id);
    fixtureScheduleRuns.delete(id);
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method === "GET" && /^\/v1\/schedules\/[0-9a-f-]+\/runs$/.test(url.pathname)) {
    const id = url.pathname.split("/").at(-2);
    response.end(JSON.stringify({ runs: fixtureScheduleRuns.get(id) ?? [] }));
    return;
  }
  if (request.method === "POST" && /^\/v1\/schedules\/[0-9a-f-]+\/run$/.test(url.pathname)) {
    const id = url.pathname.split("/").at(-2);
    const run = {
      id: crypto.randomUUID(),
      scheduleId: id,
      scheduledFor: new Date().toISOString(),
      state: "claimed",
      sessionId: null,
      failureCode: null,
      failureSummary: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fixtureScheduleRuns.set(id, [run, ...(fixtureScheduleRuns.get(id) ?? [])]);
    response.statusCode = 202;
    response.end(JSON.stringify(run));
    return;
  }
  if (key === "GET /v1/connections") {
    response.end(JSON.stringify({ connections: fixtureMcpConnections }));
    return;
  }
  if (key === "GET /v1/admin/connectors") {
    response.end(JSON.stringify({ connectors: fixtureMcpConnections }));
    return;
  }
  if (key === "POST /v1/admin/connectors/discover") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      response.end(JSON.stringify({
        authorizationOrigin: new URL(input.endpointUrl).origin,
        dynamicClientRegistration: !input.clientId,
        discoveryToken: "fixture-discovery-token-00000000000000000000",
      }));
    });
    return;
  }
  if (key === "POST /v1/admin/connectors") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const id = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const connector = {
        id,
        serverName: `onecomputer_${id.replaceAll("-", "_")}`,
        name: input.name,
        shortDescription: input.shortDescription,
        description: input.description,
        category: input.category,
        services: input.services,
        policySupport: "automatic",
        source: "custom",
        brand: "generic",
        available: true,
        state: "disconnected",
        connectedAt: null,
        expiresAt: null,
        account: null,
      };
      fixtureMcpConnections = [...fixtureMcpConnections, connector];
      response.statusCode = 201;
      response.end(JSON.stringify({ connector }));
    });
    return;
  }
  if (request.method === "GET" && /^\/v1\/connections\/[^/]+$/.test(url.pathname)) {
    const connectorId = url.pathname.split("/").at(-1);
    const connector = fixtureMcpConnections.find((item) => item.id === connectorId);
    if (connector) {
      response.end(JSON.stringify(connector));
      return;
    }
  }
  if (request.method === "DELETE" && /^\/v1\/connections\/[^/]+$/.test(url.pathname)) {
    const connectorId = url.pathname.split("/").at(-1);
    fixtureMcpConnections = fixtureMcpConnections.map((item) => item.id === connectorId ? {
      ...item,
      state: "disconnected",
      connectedAt: null,
      expiresAt: null,
      account: null,
    } : item);
    response.end(JSON.stringify({ state: "disconnected", connectedAt: null, expiresAt: null, account: null }));
    return;
  }
  if (key === "GET /v1/sandbox-settings") {
    response.end(JSON.stringify({
      ...sandboxSettings,
      grantId: url.searchParams.get("grantId") ?? "personal",
      securityGroup: sandboxSettings.securityGroup ?? egressSecurityGroups.find((group) => group.isDefault),
      availableSecurityGroups: egressSecurityGroups,
    }));
    return;
  }
  if (key === "POST /v1/workspaces") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const created = {
        ...sandboxWorkspace,
        id: `fixture-workspace-${Date.now()}`,
        grantId: input.grantId,
        state: "provisioning",
        profile: {
          ...sandboxSettings.profile,
          modelAlias: sandboxSettings.modelAlias,
        },
        applications: sandboxSettings.applicationIds,
        agents: sandboxSettings.availableAgents.filter((agent) => sandboxSettings.agentIds.includes(agent.id)),
      };
      fixtureWorkspaces = [...fixtureWorkspaces, created];
      response.statusCode = 201;
      response.end(JSON.stringify(created));
    });
    return;
  }
  if (key === "PUT /v1/sandbox-settings") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      sandboxSettings = {
        ...sandboxSettings,
        ...input,
        configuration: {
          ...sandboxSettings.configuration,
          profileId: input.profileId,
          applicationIds: input.applicationIds,
          agentIds: input.agentIds,
          modelAlias: input.modelAlias,
          executionMode: input.profileId === disposableProfile.id ? "disposable-open" : "managed",
          egressMode: input.profileId === disposableProfile.id ? "full-web" : "restricted",
        },
        profile: input.profileId === disposableProfile.id ? disposableProfile : profile,
        updatedAt: new Date().toISOString(),
      };
      responses.set("GET /v1/sandbox-settings", sandboxSettings);
      response.end(JSON.stringify(sandboxSettings));
    });
    return;
  }
  if (key === `POST /v1/workspaces/${workspaceId}/chat/agents/hermes-claw/sessions`) {
    response.statusCode = 201;
    response.end(JSON.stringify({ ...chatSession, id: `fixture-session-${Date.now()}`, title: null }));
    return;
  }
  if (key.startsWith(`POST /v1/workspaces/${workspaceId}/chat/agents/hermes-claw/sessions/`) && key.endsWith("/messages")) {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const turnId = `fixture-turn-${Date.now()}`;
      const messageId = `fixture-message-${Date.now()}`;
      const createdAt = new Date().toISOString();
      const chunks = [
        { type: "start", messageId, messageMetadata: { agentCatalogId: "hermes-claw", turnId, state: "streaming", createdAt } },
        { type: "data-progress", id: `${turnId}-progress`, data: { activityId: `${turnId}-progress`, label: "Hermes is working", state: "running" } },
        { type: "text-start", id: `${turnId}-text` },
        { type: "text-delta", id: `${turnId}-text`, delta: "I’m working inside your workspace and can use only the tools and destinations your organization approved." },
        { type: "text-end", id: `${turnId}-text` },
        { type: "data-progress", id: `${turnId}-progress`, data: { activityId: `${turnId}-progress`, label: "Work complete", state: "completed" } },
        { type: "data-terminal", id: `${turnId}-terminal`, data: { turnId, state: "completed" } },
        { type: "finish", finishReason: "stop", messageMetadata: { agentCatalogId: "hermes-claw", turnId, state: "completed", createdAt } },
      ];
      chatMessages = [...chatMessages, input.message];
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("x-vercel-ai-ui-message-stream", "v1");
      response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
    });
    return;
  }
  if (key === "GET /v1/admin/users") {
    response.end(JSON.stringify({ users: adminUsers }));
    return;
  }
  if (key === "GET /v1/admin/egress-security-groups") {
    response.end(JSON.stringify({ securityGroups: egressSecurityGroups }));
    return;
  }
  if (key === "POST /v1/admin/egress-security-groups") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const prior = egressSecurityGroups.find((group) => group.securityGroupId === input.securityGroupId);
      const securityGroupId = prior?.securityGroupId ?? `esg_fixture_${Date.now()}`;
      const saved = {
        ...egressSecurityGroups[0],
        ...input,
        id: `egv_fixture_${Date.now()}_v${(prior?.version ?? 0) + 1}`,
        securityGroupId,
        version: (prior?.version ?? 0) + 1,
        createdAt: new Date().toISOString(),
      };
      egressSecurityGroups = [saved, ...egressSecurityGroups.filter((group) => group.securityGroupId !== securityGroupId)];
      if (sandboxSettings.securityGroup?.securityGroupId === securityGroupId) {
        sandboxSettings = { ...sandboxSettings, securityGroup: saved };
      }
      response.statusCode = 201;
      response.end(JSON.stringify({ ...saved, workspaceProxies: { refreshed: 1, failed: 0 } }));
    });
    return;
  }
  if (request.method === "POST" && /^\/v1\/admin\/workspaces\/[^/]+\/egress-security-group$/.test(url.pathname)) {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const group = egressSecurityGroups.find((candidate) => candidate.id === input.securityGroupVersionId);
      sandboxSettings = { ...sandboxSettings, securityGroup: group };
      response.end(JSON.stringify(group));
    });
    return;
  }
  const payload = responses.get(key);
  if (payload === undefined) {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: "FIXTURE_ROUTE_NOT_FOUND", message: key, retryable: false } }));
    return;
  }
  response.end(JSON.stringify(payload));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`ONEComputer UI fixture listening on http://127.0.0.1:${port}\n`);
});
