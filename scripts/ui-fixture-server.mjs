import http from "node:http";

const port = Number(process.env.UI_FIXTURE_PORT ?? 4199);
const now = new Date().toISOString();
const workspaceId = "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
const digest = "a".repeat(64);
const bundleDigest = "b".repeat(64);

const session = {
  user: {
    id: "alex-morgan",
    displayName: "Example User",
    email: "user@example.test",
  },
  tenant: { id: "acme", displayName: "Example Organization" },
  roles: ["employee", "administrator"],
  capabilities: [
    "organization.read",
    "organization.manage_members",
    "organization.manage_roles",
    "organization.manage_settings",
    "workspace.use",
    "workspace.create",
    "workspace.manage",
    "policy.manage",
    "provider.manage",
    "audit.read",
    "usage.read",
    "usage.manage",
  ],
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
    alias: "lemmacomputer-glm",
    status: "ready",
    fallback: "none",
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
    client: "LemmaComputer managed workspace",
    clientVersion: "managed-v1",
    modelAlias: "lemmacomputer-glm",
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
    client: "LemmaComputer open workspace",
    clientVersion: "disposable-open-v1",
    modelAlias: "lemmacomputer-openai",
    executionMode: "disposable-open",
    egressMode: "full-web",
    persistence: "persistent-home",
    network: "gateway-only",
  },
};

const productWorkspaceId = "4d647d2f-7b42-438e-b1bb-4e91347eb58d";
const productWorkspace = {
  ...workspace,
  id: productWorkspaceId,
  grantId: "workspace-product",
  agents: [
    { id: "hermes-claw", displayName: "Hermes Agent CLI", clientVersion: "0.19.0", agentId: "agent-alex:product-hermes", state: "ready" },
    { id: "codex-cli", displayName: "Codex CLI", clientVersion: "0.116.0", agentId: "agent-alex:product-codex", state: "ready" },
  ],
  modelRoute: {
    alias: "lemmacomputer-auto",
    status: "ready",
    fallback: "none",
    limits: { requestsPerMinute: 30, tokensPerMinute: 50000, maxParallelRequests: 4 },
  },
};

const profile = {
  id: "claude-desktop-standard-v1",
  version: 1,
  displayName: "Restricted workspace",
  description: "A restricted workspace for any selected AI agent, routed through organization-approved models, tools, and destinations.",
  executionMode: "managed",
  egressMode: "restricted",
  dataGuidance: "Use for organization work. Local tools and public destinations remain policy restricted.",
  client: "LemmaComputer managed workspace",
  clientVersion: "managed-v1",
  persistence: "persistent-home",
  network: "gateway-only",
  resources: { cpus: 2, memoryGiB: 4 },
};

const disposableProfile = {
  id: "disposable-open-v1",
  version: 1,
  displayName: "Internet workspace",
  description: "A flexible workspace with local coding tools and public internet access inside the isolated workspace boundary.",
  executionMode: "disposable-open",
  egressMode: "full-web",
  dataGuidance: "Non-sensitive work only. Delete permanently removes the workspace.",
  client: "LemmaComputer open workspace",
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
    description: "Managed desktop client routed through LemmaComputer.",
    license: "Anthropic commercial distribution",
    source: "https://downloads.claude.ai/claude-desktop/apt/stable/",
    artifactSha256: "d427f46ac9233dbc4d8a441a602f09f750b8a5f05d1fc7a00285d7a6ce07655c",
    resources: { memoryMiB: 1536 },
  },
  {
    id: "claude-cli",
    displayName: "Claude CLI",
    clientVersion: "2.1.215",
    description: "Pinned Claude CLI routed through its own governed LemmaComputer identity.",
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
    description: "Pinned Hermes Agent CLI configured as a governed LemmaComputer client.",
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
  modelAlias: "lemmacomputer-auto",
  requestedServiceClass: "balanced",
  routePreferenceMigrationRequired: false,
  profile,
  availableProfiles: [profile, disposableProfile],
  availableApplications,
  availableModels: [{ alias: "lemmacomputer-auto", displayName: "Governed routing", provider: "LemmaComputer" }],
  availableServiceClasses: [
    { value: "lite", displayName: "Lite", description: "Fast, economical work." },
    { value: "balanced", displayName: "Balanced", description: "Everyday reasoning and tool use." },
    { value: "pro", displayName: "Pro", description: "Highest capability for complex work." },
  ],
  agentIds: ["claude-desktop", "hermes-claw"],
  availableAgents,
  configuration: {
    schemaVersion: 1,
    profileId: profile.id,
    applicationIds: ["firefox"],
    agentIds: ["claude-desktop", "hermes-claw"],
    modelAlias: "lemmacomputer-auto",
    requestedServiceClass: "balanced",
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
  requestedBy: "Example User",
  operationDigest: "c".repeat(64),
  toolName: "delete-drive-item",
  agentId: "agent-alex:claude",
  policyVersionId: "policy-version-7",
  requiredApprovalChannel: "openvtc-task-consent",
  receipt: { resultSummary: "The approved file deletion completed." },
};

const fixtureToolAuditEvents = [{
  tenantId: session.tenant.id,
  subjectId: session.user.id,
  workspaceId,
  agentId: "agent-alex:claude",
  agentInstanceId: "11111111-1111-4111-8111-111111111111",
  context: { kind: "chat", taskId: "quarterly-review", sessionId: "fixture-session-1", turnId: "fixture-turn-1" },
  sourceSystem: "workspace_broker",
  sourceInvocationId: "21111111-1111-4111-8111-111111111111",
  correlationId: "tool-audit-correlation-1",
  connectorId: "microsoft-365",
  serverId: "microsoft-365-server",
  serverName: "lemmacomputer_ms365",
  toolName: "send-teams-message",
  policyDecision: "allow",
  policyCode: "MCP_POLICY_ALLOWED",
  policyVersionId: "policy-v7",
  policyHash: digest,
  governedOperationId: operation.id,
  targetSummary: { targetType: "recipient", text: "Recipient: Alex Morgan", provenance: "managed_schema", redacted: false },
  invocationId: "31111111-1111-4111-8111-111111111111",
  admittedAt: new Date(Date.now() - 640).toISOString(),
  outcome: "succeeded",
  latencyMs: 640,
  failureClass: null,
  completedAt: now,
}, {
  tenantId: session.tenant.id,
  subjectId: "example-admin",
  workspaceId,
  agentId: "agent-admin:hermes",
  agentInstanceId: "12222222-2222-4222-8222-222222222222",
  context: { kind: "workspace_native", taskId: null, sessionId: null, turnId: null },
  sourceSystem: "workspace_broker",
  sourceInvocationId: "22222222-2222-4222-8222-222222222223",
  correlationId: "tool-audit-correlation-2",
  connectorId: "microsoft-365",
  serverId: "microsoft-365-server",
  serverName: "lemmacomputer_ms365",
  toolName: "delete-drive-item",
  policyDecision: "deny",
  policyCode: "MCP_TOOL_BLOCKED_BY_POLICY",
  policyVersionId: "policy-v7",
  policyHash: digest,
  governedOperationId: null,
  targetSummary: { targetType: "file", text: "File: planning-draft.docx", provenance: "managed_schema", redacted: false },
  invocationId: "32222222-2222-4222-8222-222222222222",
  admittedAt: new Date(Date.now() - 1_200).toISOString(),
  outcome: "denied",
  latencyMs: 0,
  failureClass: null,
  completedAt: new Date(Date.now() - 1_200).toISOString(),
}];

const companionActivity = {
  id: "00000000-0000-4000-8000-000000000010",
  state: "succeeded",
  request: {
    action: "Send Teams message",
    summary: "Send Teams chat message to Alex Morgan",
    target: { label: "To", name: "Alex Morgan", context: "Microsoft Teams" },
    details: [
      { label: "Message", value: "Hello Alex,\n\nThe quarterly report is ready for your review.", format: "long-text" },
    ],
  },
  audit: {
    requestedBy: "Codex CLI",
    requestedAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    decision: { value: "approve", decidedAt: now },
    outcome: { status: "succeeded", completedAt: now },
  },
};

const chatSession = {
  id: "fixture-session-1",
  title: "Quarterly planning",
  createdAt: now,
  updatedAt: now,
  agentCatalogId: "hermes-claw",
};
const initialChatMessages = [
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
      { type: "data-approval", id: "fixture-approval-1", data: { approvalId: "fixture-approval-1", toolCallId: "fixture-tool-2", operationId: "00000000-0000-4000-8000-000000000001", state: "approval_required", summary: "Approval needed: Delete planning-draft.docx from OneDrive" } },
      { type: "text", text: "**The protected deletion is waiting for your signed approval.**\n\n- The file has not been deleted.\n- LemmaComputer will run it only after approval.", state: "done" },
      { type: "data-terminal", id: "terminal-fixture-turn-1", data: { turnId: "fixture-turn-1", state: "completed" } },
    ],
  },
];
const chatMessages = structuredClone(initialChatMessages);
const activeFixtureTurns = new Map();

const reviewedSkills = [{
  id: "make-a-site",
  displayName: "Make a site",
  description: "Build and publish a simple owner-only static Vite site.",
  defaultPrompt: "Use $make-a-site to build and publish a simple site.",
}];
const helloSiteHtml = "<!doctype html><html lang=\"en\"><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Hello world</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;font:600 32px system-ui;color:#14233b}</style><body>Hello world</body></html>";
let fixtureSites = [];

const activityTurnId = "fixture-turn-1";
const activityEvent = (turnId, sequence, kind, state, provenance, payload) => ({
  version: 1,
  eventId: crypto.randomUUID(),
  turnId,
  sequence,
  timestamp: new Date(Date.now() - (15 - sequence) * 15_000).toISOString(),
  kind,
  state,
  provenance,
  visibility: "user",
  payload,
});
const activityEvents = [
  activityEvent(activityTurnId, 0, "plan", "running", "deterministic_system", { title: "Review the requested workspace change", summary: "Check the file, confirm policy, then request approval." }),
  activityEvent(activityTurnId, 1, "plan", "running", "provider_generated", { title: "Review the requested workspace change", summary: "Check the file, confirm policy, then request approval." }),
  activityEvent(activityTurnId, 2, "progress", "completed", "deterministic_system", { activityId: "fixture-progress-1", label: "Workspace context checked" }),
  activityEvent(activityTurnId, 3, "provider_summary", "completed", "provider_generated", { summary: "The requested draft is disposable, but deleting it still requires approval.", provider: "Hermes" }),
  activityEvent(activityTurnId, 4, "tool", "running", "tool", { toolCallId: "fixture-tool-1", name: "get-drive-item", summary: "File metadata checked" }),
  activityEvent(activityTurnId, 5, "tool", "completed", "tool", { toolCallId: "fixture-tool-1", name: "get-drive-item", summary: "File metadata checked" }),
  activityEvent(activityTurnId, 6, "tool", "completed", "tool", { toolCallId: "fixture-tool-web", name: "WebSearch", summary: "Searched approved workspace sources" }),
  activityEvent(activityTurnId, 7, "web_action", "completed", "tool", { action: "search", label: "Searched approved workspace sources", url: "https://example.com/search?q=planning" }),
  activityEvent(activityTurnId, 8, "source", "completed", "provider_generated", { title: "Workspace retention guide", url: "https://example.com/retention", citation: "[1]" }),
  activityEvent(activityTurnId, 9, "source", "completed", "provider_generated", { title: "Retention guide", url: "https://example.com/retention", citation: "[1]" }),
  activityEvent(activityTurnId, 10, "approval", "requires_action", "tool", { approvalId: "fixture-approval-1", toolCallId: "fixture-tool-2", operationId: "00000000-0000-4000-8000-000000000001", summary: "Approval needed to delete planning-draft.docx" }),
  activityEvent(activityTurnId, 11, "computer_action", "completed", "tool", { actionId: "fixture-computer-1", label: "Opened the managed workspace", viewerRef: "fixture-viewer-1" }),
  activityEvent(activityTurnId, 12, "notice", "completed", "deterministic_system", { message: "The file remains unchanged while approval is pending." }),
  activityEvent(activityTurnId, 13, "error", "failed", "deterministic_system", { code: "SOURCE_REFRESH_FAILED", message: "One optional source could not refresh.", retryable: true }),
  activityEvent(activityTurnId, 14, "terminal", "completed", "deterministic_system", { turnState: "completed", message: "Visible activity recorded" }),
];
const activityByTurn = new Map([[activityTurnId, activityEvents]]);
const activitySubscribers = new Map();
const disconnectActivityOnce = new Set();
const appendActivity = (turnId, event) => {
  const events = [...(activityByTurn.get(turnId) ?? []), event];
  activityByTurn.set(turnId, events);
  for (const subscriber of activitySubscribers.get(turnId) ?? []) {
    if (event.sequence <= subscriber.cursor) continue;
    subscriber.cursor = event.sequence;
    subscriber.response.write(`id: ${event.sequence}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`);
    if (disconnectActivityOnce.has(turnId) && event.sequence === 2) {
      disconnectActivityOnce.delete(turnId);
      subscriber.response.end();
    } else if (event.kind === "terminal") {
      subscriber.response.end();
    }
  }
};

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
  id: "egv_fixture_managed_default_v1",
  securityGroupId: "esg_fixture_managed_default",
  tenantId: session.tenant.id,
  version: 1,
  name: "Restricted workspace default",
  description: "The fixed approved-destinations baseline inherited by Restricted workspaces.",
  defaultAction: "deny",
  rules: [],
  documentHash: digest,
  createdBy: session.user.id,
  createdAt: now,
  isDefault: true,
  defaultFor: "managed",
}, {
  schemaVersion: 1,
  id: "egv_fixture_internet_default_v1",
  securityGroupId: "esg_fixture_internet_default",
  tenantId: session.tenant.id,
  version: 1,
  name: "Internet workspace default",
  description: "The built-in public-web policy inherited by Internet workspaces.",
  defaultAction: "allow-public-http-https",
  rules: [],
  documentHash: digest,
  createdBy: session.user.id,
  createdAt: now,
  isDefault: true,
  defaultFor: "internet",
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
  ],
  documentHash: digest,
  createdBy: session.user.id,
  createdAt: now,
  isDefault: false,
}];
const inheritedEgressGroup = (profileId) => ({
  ...egressSecurityGroups.find((group) => group.defaultFor === (profileId === "disposable-open-v1" ? "internet" : "managed")),
  assignmentSource: "workspace-type",
});

const firewallWorkspaces = () => [
  {
    id: workspace.id,
    grantId: workspace.grantId,
    state: workspace.state,
    profileId: workspace.profile.id,
    executionMode: "managed",
    egressMode: "restricted",
    egress: { ...inheritedEgressGroup("claude-desktop-standard-v1"), schemaVersion: 2, mode: "restricted" },
  },
  {
    id: sandboxWorkspace.id,
    grantId: sandboxWorkspace.grantId,
    state: sandboxWorkspace.state,
    profileId: "disposable-open-v1",
    executionMode: "disposable-open",
    egressMode: "full-web",
    egress: {
      ...inheritedEgressGroup("disposable-open-v1"),
      schemaVersion: 2,
      mode: "full-web",
    },
  },
];

let adminUsers = [
  {
    userId: session.user.id,
    membershipId: "b1111111-1111-4111-8111-111111111111",
    email: session.user.email,
    displayName: session.user.displayName,
    status: "active",
    membershipStatus: "active",
    role: "owner",
    roles: session.roles,
    effectivePolicy: { version: 7, documentHash: digest, egressSecurityGroup: egressSecurityGroups[0] },
    workspaces: firewallWorkspaces(),
  },
  {
    userId: "example-admin",
    membershipId: "b2222222-2222-4222-8222-222222222222",
    email: "admin@example.test",
    displayName: "Example Admin",
    status: "active",
    membershipStatus: "active",
    role: "member",
    roles: ["employee"],
    effectivePolicy: { version: 7, documentHash: digest, egressSecurityGroup: egressSecurityGroups[0] },
    workspaces: [{
      ...firewallWorkspaces()[0],
      id: "fixture-example-workspace",
    }],
  },
];
const memberWorkspaceInventory = () => adminUsers.map((user) => ({
  userId: user.userId,
  displayName: user.displayName,
  email: user.email,
  status: user.status,
  membershipStatus: user.membershipStatus,
  workspaceCount: user.workspaces.length,
  workspaces: user.workspaces.map((item) => ({
    id: item.id,
    grantId: item.grantId,
    name: item.grantId === "personal"
      ? "Personal workspace"
      : item.grantId.split(/[-_]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" "),
    state: item.state,
    health: {
      status: item.state === "failed"
        ? "needs_attention"
        : ["provisioning", "restarting", "stopping"].includes(item.state)
          ? "transitioning"
          : ["stopped", "not_created"].includes(item.state) ? "offline" : "healthy",
      reasonCode: null,
    },
    profile: { id: item.profileId, executionMode: item.executionMode },
    networkAccess: {
      mode: item.egressMode,
      securityGroup: item.egress ? { id: item.egress.id, name: item.egress.name, version: item.egress.version, isDefault: Boolean(item.egress.isDefault), assignmentSource: item.egress.assignmentSource ?? "workspace-type", defaultFor: item.egress.defaultFor ?? null } : null,
    },
    policyAssignment: { authority: "runtime_policy", version: user.effectivePolicy.version, hash: user.effectivePolicy.documentHash },
    lastActivityAt: null,
    lastTransitionAt: now,
    createdAt: now,
  })),
}));
const protectedWorkspacePolicyOverview = {
  catalog: {
    constraints: {
      workspaceProfiles: { allow: ["claude-desktop-standard-v1", "disposable-open-v1"], deny: [] },
      agents: { allow: ["claude-desktop", "claude-cli", "codex-cli", "hermes-desktop", "hermes-claw"], deny: [] },
      applications: { allow: ["firefox", "google-chrome"], deny: [] },
      modelAliases: { allow: ["lemmacomputer-auto", "lemmacomputer-claude", "lemmacomputer-openai", "lemmacomputer-glm", "lemmacomputer-assistant", "lemmacomputer-bedrock"], deny: [] },
      serviceClasses: { allow: ["lite", "balanced", "pro"], deny: [] },
      maximumReasoningEffort: "max",
      maximumEgressMode: "full-web",
      clipboard: { localToWorkspace: true, workspaceToLocal: true, maxBytes: 1048576 },
      connectors: { allow: ["microsoft-365"], deny: [], toolPolicies: { "microsoft-365": { "list-mail-messages": "allow", "send-mail": "approval_required" } } },
      capabilities: { allow: ["ai-assistant", "m365-read", "m365-write-protected"], deny: [] },
    },
  },
  organizationPolicyVersions: [],
};
const fixtureRoleCatalog = {
  version: 2,
  permissions: [
    { key: "organization.read", description: "Read organization settings", scopeTypes: ["organization"] },
    { key: "organization.manage_members", description: "Manage organization members", scopeTypes: ["organization"] },
    { key: "organization.manage_roles", description: "Manage organization roles", scopeTypes: ["organization"] },
    { key: "organization.manage_settings", description: "Manage organization settings", scopeTypes: ["organization"] },
    { key: "workspace.use", description: "Use organization workspaces", scopeTypes: ["organization", "workspace"] },
    { key: "workspace.manage", description: "Manage organization workspaces", scopeTypes: ["organization", "workspace"] },
    { key: "policy.manage", description: "Manage organization policies", scopeTypes: ["organization", "workspace"] },
    { key: "provider.manage", description: "Manage organization providers", scopeTypes: ["organization", "provider"] },
    { key: "audit.read", description: "Read organization audit records", scopeTypes: ["organization"] },
    { key: "usage.read", description: "Read organization usage and spend records", scopeTypes: ["organization", "workspace", "provider"] },
    { key: "usage.manage", description: "Manage quotas, budgets, and usage configuration", scopeTypes: ["organization", "workspace", "provider"] },
  ],
};
let fixtureOrganizationRoles = [];
const fixtureInvitationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let fixtureInvitations = [];
const fixtureSpendTeamId = "11111111-1111-4111-8111-111111111111";
let fixtureTeams = [{
  id: fixtureSpendTeamId,
  displayName: "Finance",
  description: "Finance allocation and reporting",
  ownerUserId: session.user.id,
  costCenterCode: "FIN-100",
  status: "active",
  isRolloutFallback: false,
  activeMemberCount: 1,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  archivedAt: null,
}];
let fixtureTeamMemberships = new Map([[fixtureSpendTeamId, [{
  id: "11111111-1111-4111-8111-222222222222",
  teamId: fixtureSpendTeamId,
  userId: session.user.id,
  effectiveFrom: "2026-07-01T00:00:00.000Z",
  effectiveTo: null,
  isDefaultSpendingTeam: true,
}]]]);
let fixtureTeamBudgets = new Map();
const routingMappingId="22222222-2222-4222-8222-222222222222";
const routingPolicyId="33333333-3333-4333-8333-333333333333";
const routingDeploymentIds={lite:"44444444-4444-4444-8444-444444444444",balanced:"55555555-5555-4555-8555-555555555555",pro:"66666666-6666-4666-8666-666666666666"};
const routingScope={allowedServiceClasses:["lite","balanced","pro"],allowedDeploymentIds:Object.values(routingDeploymentIds),explicitSelectionAllowed:true,forceServiceClass:null,safeDefault:"balanced"};
const routingClassPolicy=(serviceClass)=>({capabilityFloor:{vision:serviceClass!=="lite",tools:serviceClass!=="lite",streaming:true,contextTokens:serviceClass==="pro"?128000:32000,outputTokens:32768},evaluationThreshold:"0.800000",qualityPosture:serviceClass==="pro"?"premium":"standard",costPosture:serviceClass==="lite"?"lowest":"balanced",latencyPosture:"balanced",requiredModalities:["text"],requiredResidency:["sg"],eligibleDeploymentIds:[routingDeploymentIds[serviceClass]],safeDefault:serviceClass==="balanced"});
const routingClassPolicies={lite:routingClassPolicy("lite"),balanced:routingClassPolicy("balanced"),pro:routingClassPolicy("pro")};
let fixtureRoutingReview=null;
let fixtureRoutingMode="shadow";
const fixtureRate=(unit,amountPerUnit)=>({unit,amountPerUnit:String(amountPerUnit),unitScale:"1000000"});
let fixtureRateCards=[
  {id:"99999999-9999-4999-8999-999999999991",provider:"foundry",providerAccountId:"foundry-primary",baseModel:"private/luna",deploymentId:"foundry/luna",region:"sg",providerServiceTier:"standard",currency:"USD",source:"contract_override",sourceVersion:"FY26-foundry-01",sourceHash:"1".repeat(64),catalogueRelease:null,effectiveFrom:"2026-07-01T00:00:00.000Z",effectiveTo:null,approvedAt:"2026-07-01T00:00:00.000Z",approvedBy:"fixture-admin",overrideReason:"Enterprise agreement",rates:[fixtureRate("input_uncached_token",0.35),fixtureRate("output_token",1.8),fixtureRate("cache_read_token",0.08),fixtureRate("cache_write_token",0.45)]},
  {id:"99999999-9999-4999-8999-999999999992",provider:"bedrock",providerAccountId:"bedrock-primary",baseModel:"private/terra",deploymentId:"bedrock/terra",region:"sg",providerServiceTier:"standard",currency:"USD",source:"contract_override",sourceVersion:"FY26-bedrock-01",sourceHash:"2".repeat(64),catalogueRelease:null,effectiveFrom:"2026-07-01T00:00:00.000Z",effectiveTo:null,approvedAt:"2026-07-01T00:00:00.000Z",approvedBy:"fixture-admin",overrideReason:"Enterprise agreement",rates:[fixtureRate("input_uncached_token",3),fixtureRate("output_token",15),fixtureRate("cache_read_token",0.3),fixtureRate("cache_write_token",3.75)]},
  {id:"99999999-9999-4999-8999-999999999993",provider:"bedrock",providerAccountId:"bedrock-primary",baseModel:"private/sol",deploymentId:"bedrock/sol",region:"sg",providerServiceTier:"standard",currency:"USD",source:"contract_override",sourceVersion:"FY26-bedrock-01",sourceHash:"3".repeat(64),catalogueRelease:null,effectiveFrom:"2026-07-01T00:00:00.000Z",effectiveTo:null,approvedAt:"2026-07-01T00:00:00.000Z",approvedBy:"fixture-admin",overrideReason:"Enterprise agreement",rates:[fixtureRate("input_uncached_token",15),fixtureRate("output_token",75)]},
];
let fixtureLatestRoutingMapping={id:routingMappingId,tenantId:"acme",revisionNote:"Initial enterprise alias mapping",createdBy:"fixture-admin",createdAt:"2026-07-15T00:00:00.000Z",deployments:[
  {id:routingDeploymentIds.lite,serviceClass:"lite",provider:"foundry",providerAccountId:"foundry-primary",providerModel:"private/luna",providerDeployment:"foundry/luna",region:"sg",providerServiceTier:"standard",rateCardId:"99999999-9999-4999-8999-999999999991",capabilities:{...routingClassPolicies.lite.capabilityFloor,residency:["sg"]},approved:true,evaluationPassed:true},
  {id:routingDeploymentIds.balanced,serviceClass:"balanced",provider:"bedrock",providerAccountId:"bedrock-primary",providerModel:"private/terra",providerDeployment:"bedrock/terra",region:"sg",providerServiceTier:"standard",rateCardId:"99999999-9999-4999-8999-999999999992",capabilities:{...routingClassPolicies.balanced.capabilityFloor,residency:["sg"]},approved:true,evaluationPassed:true},
  {id:routingDeploymentIds.pro,serviceClass:"pro",provider:"bedrock",providerAccountId:"bedrock-primary",providerModel:"private/sol",providerDeployment:"bedrock/sol",region:"sg",providerServiceTier:"standard",rateCardId:"99999999-9999-4999-8999-999999999993",capabilities:{...routingClassPolicies.pro.capabilityFloor,residency:["sg"]},approved:true,evaluationPassed:true},
]};
const fixtureRoutingSettings=()=>({teamId:fixtureSpendTeamId,policy:{id:routingPolicyId,mappingVersionId:routingMappingId,billingCurrency:"USD",serviceClassPolicies:routingClassPolicies,identity:routingScope,team:routingScope,requiredResidency:"sg",createdAt:"2026-07-15T00:00:00.000Z"},rollout:{id:"77777777-7777-4777-8777-777777777777",tenantId:"acme",teamId:fixtureSpendTeamId,policyVersionId:routingPolicyId,mappingVersionId:routingMappingId,mode:fixtureRoutingMode,fixedDeploymentId:routingDeploymentIds.balanced,evidenceReviewId:fixtureRoutingReview?.id??null,previousRolloutVersionId:null,reason:"Design partner shadow evaluation",createdBy:"fixture-admin",createdAt:"2026-07-20T00:00:00.000Z"},review:fixtureRoutingReview,deployments:[
  {id:routingDeploymentIds.lite,serviceClass:"lite",provider:"foundry",providerModel:"private/luna",providerDeployment:"foundry/luna",rateCardId:"99999999-9999-4999-8999-999999999991",approved:true,evaluationPassed:true},
  {id:routingDeploymentIds.balanced,serviceClass:"balanced",provider:"bedrock",providerModel:"private/terra",providerDeployment:"bedrock/terra",rateCardId:"99999999-9999-4999-8999-999999999992",approved:true,evaluationPassed:true},
  {id:routingDeploymentIds.pro,serviceClass:"pro",provider:"bedrock",providerModel:"private/sol",providerDeployment:"bedrock/sol",rateCardId:"99999999-9999-4999-8999-999999999993",approved:true,evaluationPassed:true},
]});
const fixtureRoutingReport=()=>({teamId:fixtureSpendTeamId,sampleSize:240,selectedDistribution:{lite:142,balanced:74,pro:24},executedDistribution:{[routingDeploymentIds.balanced]:240},expectedCost:"91.580000000000",actualCost:"123.000000000000",currency:"USD",estimatedSavings:"31.420000000000",fallbackRate:"0.025",errorRate:"0.008",regretRate:"0.012",routerOverheadMs:"1.420000",decisions:[
  {id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",createdAt:"2026-07-30T08:00:00.000Z",selectedServiceClass:"lite",selectedDeploymentId:routingDeploymentIds.lite,executedDeploymentId:routingDeploymentIds.balanced,executedServiceClass:"balanced",reasonCode:"complexity_classifier",shadow:true,expectedCost:"0.018",currency:"USD",outcome:"success"},
  {id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",createdAt:"2026-07-30T07:00:00.000Z",selectedServiceClass:"pro",selectedDeploymentId:routingDeploymentIds.pro,executedDeploymentId:routingDeploymentIds.balanced,executedServiceClass:"balanced",reasonCode:"capability_escalation",shadow:true,expectedCost:"0.084",currency:"USD",outcome:"override"},
]});
const emptyBudgetStatus = { budget:null,period:null,effectiveLimitAmount:null,settledProviderCost:null,outstandingReservations:null,remainingAmount:null,percentConsumed:null,priceStatus:"unknown",enforcement:"none",alerts:[],lastReconciliation:null };
const fixtureBudgetStatus = (teamId) => fixtureTeamBudgets.get(teamId) ?? emptyBudgetStatus;
const fixturePeriod = () => ({ start:"2026-07-01T00:00:00.000Z",end:"2026-08-01T00:00:00.000Z" });

const fixtureTeamDetail = (teamId) => ({
  ...fixtureTeams.find((team) => team.id === teamId), memberships: fixtureTeamMemberships.get(teamId) ?? [],
});
let fixtureWorkspaces = [workspace, sandboxWorkspace, productWorkspace];
let fixtureMcpConnections = [
  {
    id: "microsoft-365",
    serverName: "lemmacomputer_ms365",
    name: "Microsoft 365",
    shortDescription: "Mail, calendar, files, and Teams",
    description: "Use approved Microsoft 365 tools through the LemmaComputer AI gateway.",
    category: "Productivity",
    services: ["Outlook Mail", "Calendar", "OneDrive", "Teams"],
    policySupport: "governed",
    brand: "microsoft",
    available: true,
    state: "connected",
    connectedAt: now,
    expiresAt: null,
    account: { displayName: "Example User", email: "user@example.test", userPrincipalName: "user@example.test" },
  },
  {
    id: "notion",
    serverName: "lemmacomputer_notion",
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
    serverName: "lemmacomputer_linear",
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
    serverName: "lemmacomputer_atlassian",
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
    serverName: "lemmacomputer_github",
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
].map((connector) => ({
  ...connector,
  enabled: true,
  membersCanManage: true,
  accessPolicyVersion: 1,
  accessPolicyUpdatedAt: now,
  canManageConnection: true,
}));

const fixtureSpendUserId = "alex-morgan";
const fixtureSpendTasks = Array.from({ length: 201 }, (_, index) => {
  const number = index + 1;
  return {
    taskKey: `fixture-task-key-${number}`,
    taskId: `quarterly-analysis-${String(number).padStart(3, "0")}`,
    turnId: `fixture-spend-turn-${number}`,
    teamId: fixtureSpendTeamId,
    teamDisplayName: "Finance",
    userId: fixtureSpendUserId,
    userDisplayName: "Example User",
    workspaceId,
    agentId: "agent-alex:hermes",
    requestedRoute: number === 1 ? "pro" : "balanced",
    resolvedRoutes: [number === 1 ? "anthropic/claude-opus" : "openai/gpt-terra"],
    dominantDriver: { code: number === 1 ? "attachments" : "conversation_history", label: number === 1 ? "Attachments" : "Conversation history", score: "12", evidenceCount: "12" },
    priceState: number === 2 ? "missing" : "priced",
    corrected: number === 1,
    costs: number === 2 ? [] : [{ currency: "USD", amount: number === 1 ? "74.25" : "0.5" }],
    providerConfirmedCosts: [],
    usage: { input_uncached_token: "100", cache_read_token: "40", cache_write_token: "8", output_token: "20", reasoning_token: "5", image: "1" },
    attemptCount: number === 1 ? 2 : 1,
    eventCount: number === 1 ? 3 : 1,
    retryCount: number === 1 ? 1 : 0,
    fallbackCount: 0,
    failedAttemptCount: 0,
    unknownCostEventCount: number === 2 ? 1 : 0,
    incompleteCostEventCount: 0,
    correctedEventCount: number === 1 ? 1 : 0,
  };
});
const fixtureSpendReport = (tasks = fixtureSpendTasks, empty = false) => ({
  contractVersion: 1,
  range: { from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
  asOf: "2026-07-31T00:00:00.000Z",
  filters: { teamId: null, userId: null, workspaceId: null, agentId: null, taskId: null, turnId: null },
  state: empty ? "empty" : "partial",
  costCoverage: {
    status: empty ? "complete" : "multiple_gaps",
    unpricedUsage: {
      activeEventCount: empty ? 0 : 1,
      missingPriceEventCount: empty ? 0 : 1,
      partialPriceEventCount: 0,
      acknowledgedEventCount: 0,
    },
    delayedReporting: { attemptCount: empty ? 0 : 1 },
    failedWithoutUsage: { attemptCount: 0 },
    latestAcknowledgement: null,
  },
  totals: {
    costs: empty ? [] : [{ currency: "USD", amount: "173.75" }], providerConfirmedCosts: [],
    usage: empty ? {} : { input_uncached_token: "20100", cache_read_token: "8040", cache_write_token: "1608", output_token: "4020", reasoning_token: "1005", image: "2" }, latency: { sampleCount: empty ? 0 : 202, averageMs: empty ? null : 910, p95Ms: empty ? null : 1450 },
    attemptCount: empty ? 0 : 202, eventCount: empty ? 0 : 203, retryCount: empty ? 0 : 1, fallbackCount: 0, failedAttemptCount: 0,
    unknownCostEventCount: empty ? 0 : 1, incompleteCostEventCount: 0, correctedEventCount: empty ? 0 : 1,
    delayedAttemptCount: empty ? 0 : 1, allocatedAttemptCount: empty ? 0 : 202, unallocatedAttemptCount: 0,
  },
  teams: empty ? [] : [{
    teamId: fixtureSpendTeamId, teamDisplayName: "Finance", costCenterCode: "FIN-100", allocation: "allocated",
    costs: [{ currency: "USD", amount: "173.75" }], providerConfirmedCosts: [], usage: {}, attemptCount: 202, eventCount: 203,
    retryCount: 1, fallbackCount: 0, failedAttemptCount: 0, unknownCostEventCount: 1, incompleteCostEventCount: 0, correctedEventCount: 1,
  }],
  users: empty ? [] : [{
    teamId: fixtureSpendTeamId, userId: fixtureSpendUserId, userDisplayName: "Example User",
    costs: [{ currency: "USD", amount: "173.75" }], providerConfirmedCosts: [], usage: {}, attemptCount: 202, eventCount: 203,
    retryCount: 1, fallbackCount: 0, failedAttemptCount: 0, unknownCostEventCount: 1, incompleteCostEventCount: 0, correctedEventCount: 1,
  }],
  breakdowns: empty ? { requestedRoutes: [], resolvedModels: [], workspaces: [], agents: [] } : {
    requestedRoutes: [
      { requestedRoute: "balanced", costs: [{ currency: "USD", amount: "99.5" }], attemptCount: 200 },
      { requestedRoute: "pro", costs: [{ currency: "USD", amount: "74.25" }], attemptCount: 2 },
    ],
    resolvedModels: [
      { provider: "openai", model: "gpt-terra", deploymentId: "terra-sg", costs: [{ currency: "USD", amount: "99.5" }], usage: { input_uncached_token: "16000", cache_read_token: "7000", cache_write_token: "1500", output_token: "3000", reasoning_token: "700" }, attemptCount: 200 },
      { provider: "anthropic", model: "claude-opus", deploymentId: "opus-bedrock", costs: [{ currency: "USD", amount: "74.25" }], usage: { input_uncached_token: "4100", cache_read_token: "1040", cache_write_token: "108", output_token: "1020", reasoning_token: "305" }, attemptCount: 2 },
    ],
    workspaces: [{ workspaceId, costs: [{ currency: "USD", amount: "173.75" }], attemptCount: 202 }],
    agents: [{ agentId: "agent-alex:hermes", costs: [{ currency: "USD", amount: "173.75" }], attemptCount: 202 }],
  },
  trend: empty ? null : { previousRange: { from: "2026-05-31T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" }, costs: [{ currency: "USD", amount: "150" }], providerConfirmedCosts: [], attemptCount: 180, attemptCountDelta: 22, costDeltas: [{ currency: "USD", amount: "23.75" }] },
  tasks: empty ? [] : tasks,
});
const personalGroup = (overrides = {}) => ({
  costs: [{ currency: "USD", amount: "173.75" }],
  providerConfirmedCosts: [{ currency: "USD", amount: "54" }],
  usage: { input_uncached_token: "20100", cache_read_token: "8040", cache_write_token: "1608", output_token: "4020", reasoning_token: "1005", image: "2" },
  attemptCount: 202,
  eventCount: 203,
  failedAttemptCount: 0,
  unknownCostEventCount: 1,
  incompleteCostEventCount: 0,
  correctedEventCount: 1,
  ...overrides,
});
const fixturePersonalAiUsageReport = () => ({
  contractVersion: 1,
  range: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-13T00:00:00.000Z" },
  asOf: "2026-08-13T00:00:00.000Z",
  state: "partial",
  totals: personalGroup({
    costs: [{ currency: "EUR", amount: "12" }, { currency: "USD", amount: "173.75" }],
    delayedAttemptCount: 1,
  }),
  costCoverage: {
    status: "multiple_gaps",
    unpricedUsage: { activeEventCount: 1, missingPriceEventCount: 1, partialPriceEventCount: 0, acknowledgedEventCount: 0 },
    delayedReporting: { attemptCount: 1 },
    failedWithoutUsage: { attemptCount: 0 },
  },
  breakdowns: {
    workspaces: [
      personalGroup({ workspaceId, attemptCount: 180, costs: [{ currency: "USD", amount: "160" }], usage: { input_uncached_token: "18000", cache_read_token: "7000", cache_write_token: "1400", output_token: "3500", reasoning_token: "900" } }),
      personalGroup({ workspaceId: sandboxWorkspace.id, attemptCount: 22, eventCount: 22, correctedEventCount: 0, unknownCostEventCount: 0, costs: [{ currency: "EUR", amount: "12" }, { currency: "USD", amount: "13.75" }], providerConfirmedCosts: [], usage: { input_uncached_token: "2100", cache_read_token: "1040", cache_write_token: "208", output_token: "520", reasoning_token: "105", image: "2" } }),
    ],
    agents: [
      personalGroup({ agentId: "agent-alex:hermes", attemptCount: 180, costs: [{ currency: "USD", amount: "160" }], usage: { input_uncached_token: "18000", cache_read_token: "7000", cache_write_token: "1400", output_token: "3500", reasoning_token: "900" } }),
      personalGroup({ agentId: "agent-alex:research", attemptCount: 22, eventCount: 22, correctedEventCount: 0, unknownCostEventCount: 0, costs: [{ currency: "EUR", amount: "12" }, { currency: "USD", amount: "13.75" }], providerConfirmedCosts: [], usage: { input_uncached_token: "2100", cache_read_token: "1040", cache_write_token: "208", output_token: "520", reasoning_token: "105", image: "2" } }),
    ],
  },
  providerUsage: [
    { provider: "openai", usage: { input_uncached_token: "16000", cache_read_token: "7000", cache_write_token: "1500", output_token: "3000", reasoning_token: "700" } },
    { provider: "anthropic", usage: { input_uncached_token: "4100", cache_read_token: "1040", cache_write_token: "108", output_token: "1020", reasoning_token: "305" } },
  ],
  servingGridAssumptions: [{ provider: "openai", emissionsRegion: "sg" }],
  trend: { previousRange: { from: "2026-07-20T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" }, costs: [{ currency: "USD", amount: "150" }], providerConfirmedCosts: [], attemptCount: 180, attemptCountDelta: 22, costDeltas: [{ currency: "EUR", amount: "12" }, { currency: "USD", amount: "23.75" }] },
  privacy: { scope: "authenticated_member", description: "Only AI usage attributed to your active organization membership is included.", contentExcluded: true },
});

const responses = new Map([
  ["GET /v1/auth/session", session],
  ["GET /v1/workspaces/current", workspace],
  ["GET /v1/skills", { skills: reviewedSkills }],
  ["GET /v1/workspaces", { workspaces: [workspace, sandboxWorkspace] }],
  ["GET /v1/me/ai-usage", { report: fixturePersonalAiUsageReport() }],
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
  ["GET /v1/admin/mcp-policy", {
    serverName: "lemmacomputer_ms365",
    version: 7,
    documentHash: digest,
    tools: [{
      name: "list-mail-messages",
      displayName: "List email messages",
      description: "List messages available to the connected account.",
      service: "mail",
      risk: "read",
      decision: "allow",
    }, {
      name: "send-mail",
      displayName: "Send email",
      description: "Send a message from the connected account.",
      service: "mail",
      risk: "write",
      decision: "approval_required",
    }],
  }],
  ["GET /v1/admin/provider-settings", {
    providers: [{
      provider: "openai",
      aliases: ["lemmacomputer-assistant", "lemmacomputer-openai", "claude-opus-4-6"],
      primaryAlias: "lemmacomputer-openai",
      upstreamModelDisplayName: "OpenAI GPT-5.6 Luna",
      state: "not-configured",
      fingerprint: null,
      modelId: "gpt-5.6-luna",
      selectedModelIds: [],
      deployments: [],
      modelOptions: [
        { id: "gpt-5.6-sol", displayName: "OpenAI GPT-5.6 Sol", modelCapabilities: { vision: true, tools: true, streaming: true } },
        { id: "gpt-5.6-terra", displayName: "OpenAI GPT-5.6 Terra", modelCapabilities: { vision: true, tools: true, streaming: true } },
        { id: "gpt-5.6-luna", displayName: "OpenAI GPT-5.6 Luna", modelCapabilities: { vision: true, tools: true, streaming: true } },
      ],
      region: null,
      emissionsRegion: null,
      modelProfileId: null,
      lastTestedAt: null,
      lastErrorCode: null,
      updatedAt: null,
    }, {
      provider: "anthropic",
      aliases: ["lemmacomputer-claude", "claude-sonnet-4-6"],
      primaryAlias: "lemmacomputer-claude",
      upstreamModelDisplayName: "Anthropic Claude Sonnet 4.6",
      state: "active",
      fingerprint: "fp_fixture_anthropic",
      modelId: "claude-sonnet-4-6",
      selectedModelIds: ["claude-sonnet-4-6", "claude-opus-4-8"],
      deployments: [{
        id: "anthropic-sonnet-4-6",
        providerAccountId: "anthropic-primary",
        providerModelId: "claude-sonnet-4-6",
        providerDeployment: "anthropic/claude-sonnet-4-6",
        providerServiceTier: "standard",
        displayName: "Anthropic Claude Sonnet 4.6",
        aliases: ["lemmacomputer-claude"],
      }, {
        id: "anthropic-opus-4-8",
        providerAccountId: "anthropic-primary",
        providerModelId: "claude-opus-4-8",
        providerDeployment: "anthropic/claude-opus-4-8",
        providerServiceTier: "standard",
        displayName: "Anthropic Claude Opus 4.8",
        aliases: ["claude-opus-4-8"],
      }],
      modelOptions: [
        { id: "claude-sonnet-4-6", displayName: "Anthropic Claude Sonnet 4.6" },
        { id: "claude-opus-4-8", displayName: "Anthropic Claude Opus 4.8" },
      ],
      region: null,
      emissionsRegion: "us",
      modelProfileId: null,
      lastTestedAt: now,
      lastErrorCode: null,
      updatedAt: now,
    }, {
      provider: "glm",
      aliases: ["lemmacomputer-glm", "claude-sonnet-4-5"],
      primaryAlias: "lemmacomputer-glm",
      upstreamModelDisplayName: "Z.ai GLM-5",
      state: "active",
      fingerprint: "fp_fixture_glm",
      modelId: "glm-5",
      selectedModelIds: ["glm-5"],
      deployments: [{
        id: "glm-5",
        providerAccountId: "glm-primary",
        providerModelId: "glm-5",
        providerDeployment: "glm/glm-5",
        providerServiceTier: "standard",
        displayName: "Z.ai GLM-5",
        aliases: ["lemmacomputer-glm"],
      }],
      modelOptions: [
        { id: "glm-5", displayName: "Z.ai GLM-5" },
        { id: "glm-5.2", displayName: "Z.ai GLM-5.2" },
      ],
      region: null,
      emissionsRegion: null,
      modelProfileId: null,
      lastTestedAt: now,
      lastErrorCode: null,
      updatedAt: now,
    }],
  }],
  ["GET /v1/credentials", {
    credentials: [{
      id: "72b8576c-83f1-4c7b-bbcb-6d4d50fbab24",
      kind: "telegram_bot_token",
      displayName: "@lemmacomputer_demo_bot",
      botUsername: "lemmacomputer_demo_bot",
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
    botUsername: "lemmacomputer_demo_bot",
    tokenVersion: 1,
    updatedAt: now,
  }],
  [`GET /v1/workspaces/${workspaceId}/chat/agents`, { workspaceId, serviceClassOptions: [{ value: "lite", available: false, reasonCode: "policy_denied" }, { value: "balanced", available: true, reasonCode: "ready" }, { value: "pro", available: false, reasonCode: "route_unavailable" }], agents: [{ catalogId: "hermes-claw", displayName: "Hermes Agent CLI", state: "ready", reasonCode: "CHAT_AGENT_READY" }] }],
  [`GET /v1/workspaces/${workspaceId}/chat/agents/hermes-claw/status`, { workspaceId, catalogId: "hermes-claw", displayName: "Hermes Agent CLI", state: "ready", reasonCode: "CHAT_AGENT_READY" }],
  [`GET /v1/workspaces/${workspaceId}/chat/agents/hermes-claw/sessions`, { sessions: [chatSession] }],
  [`GET /v1/workspaces/${workspaceId}/chat/agents/hermes-claw/sessions/${chatSession.id}/messages`, { messages: chatMessages }],
  [`GET /v1/workspaces/${productWorkspaceId}/chat/agents`, { workspaceId: productWorkspaceId, serviceClassOptions: [{ value: "lite", available: true, reasonCode: "ready" }, { value: "balanced", available: true, reasonCode: "ready" }, { value: "pro", available: true, reasonCode: "ready" }], agents: [{ catalogId: "hermes-claw", displayName: "Hermes Agent CLI", state: "ready", reasonCode: "CHAT_AGENT_READY" }, { catalogId: "codex-cli", displayName: "Codex CLI", state: "ready", reasonCode: "CHAT_AGENT_READY" }, { catalogId: "claude-cli", displayName: "Claude Code", state: "ready", reasonCode: "CHAT_AGENT_READY", reasoningEffortsByServiceClass: { lite: ["auto", "low", "medium", "high"], balanced: ["auto", "low", "medium", "high"], pro: ["auto", "low", "medium", "high"] } }] }],
  [`GET /v1/workspaces/${productWorkspaceId}/chat/agents/hermes-claw/status`, { workspaceId: productWorkspaceId, catalogId: "hermes-claw", displayName: "Hermes Agent CLI", state: "ready", reasonCode: "CHAT_AGENT_READY" }],
  [`GET /v1/workspaces/${productWorkspaceId}/chat/agents/hermes-claw/sessions`, { sessions: [] }],
  [`GET /v1/workspaces/${productWorkspaceId}/chat/agents/codex-cli/status`, { workspaceId: productWorkspaceId, catalogId: "codex-cli", displayName: "Codex CLI", state: "ready", reasonCode: "CHAT_AGENT_READY" }],
  [`GET /v1/workspaces/${productWorkspaceId}/chat/agents/codex-cli/sessions`, { sessions: [] }],
  [`GET /v1/workspaces/${productWorkspaceId}/chat/agents/claude-cli/status`, { workspaceId: productWorkspaceId, catalogId: "claude-cli", displayName: "Claude Code", state: "ready", reasonCode: "CHAT_AGENT_READY" }],
  [`GET /v1/workspaces/${productWorkspaceId}/chat/agents/claude-cli/sessions`, { sessions: [] }],
  ["GET /v1/openvtc/approvers/current", { connected: false, executorDid: "did:key:z6MkFixture", approver: null }],
  ["GET /v1/openvtc/companion/config", { enabled: false, vapidPublicKey: null }],
  ["GET /v1/openvtc/companions", { companions: [] }],
  ["GET /v1/openvtc/companion/activity", { activities: [companionActivity], nextCursor: null }],
  [`GET /v1/openvtc/companion/activity/${companionActivity.id}`, {
    activity: companionActivity,
    timeline: [
      { label: "Approval requested", createdAt: now },
      { label: "Request approved", createdAt: now },
      { label: "Action sent to the connected service", createdAt: now },
      { label: "Action completed", createdAt: now },
    ],
  }],
]);

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const key = `${request.method} ${url.pathname}`;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  if (key === "GET /v1/admin/tool-audit") {
    const outcome = url.searchParams.get("outcome");
    const subjectId = url.searchParams.get("subjectId");
    const workspaceFilter = url.searchParams.get("workspaceId");
    const connectorId = url.searchParams.get("connectorId");
    const toolName = url.searchParams.get("toolName");
    const agentInstanceId = url.searchParams.get("agentInstanceId");
    const events = fixtureToolAuditEvents.filter((event) => (
      (!outcome || event.outcome === outcome)
      && (!subjectId || event.subjectId === subjectId)
      && (!workspaceFilter || event.workspaceId === workspaceFilter)
      && (!connectorId || event.connectorId === connectorId)
      && (!toolName || event.toolName === toolName)
      && (!agentInstanceId || event.agentInstanceId === agentInstanceId)
    ));
    const summary = [...new Set(events.map((event) => event.outcome))].map((value) => ({
      outcome: value,
      count: events.filter((event) => event.outcome === value).length,
    }));
    response.end(JSON.stringify({
      events,
      nextCursor: null,
      total: events.length,
      asOf: now,
      retainedDetailFrom: events.at(-1)?.completedAt ?? null,
      detailState: "complete",
      summary,
    }));
    return;
  }
  if (key === "POST /__test/reset/chat") {
    for (const activeTurn of activeFixtureTurns.values()) {
      if (activeTurn.completionTimer) clearTimeout(activeTurn.completionTimer);
    }
    activeFixtureTurns.clear();
    chatMessages.splice(0, chatMessages.length, ...structuredClone(initialChatMessages));
    response.end(JSON.stringify({ reset: true }));
    return;
  }
  const activityMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/chat\/agents\/([^/]+)\/sessions\/([^/]+)\/turns\/([^/]+)\/activity(\/stream)?$/);
  if (request.method === "GET" && activityMatch) {
    const [, requestedWorkspaceId, requestedAgentId, requestedSessionId, requestedTurnId, streamPath] = activityMatch.map((value) => value ? decodeURIComponent(value) : value);
    const owned = requestedWorkspaceId === workspaceId
      && requestedAgentId === "hermes-claw"
      && requestedSessionId === chatSession.id;
    const events = owned ? activityByTurn.get(requestedTurnId) : undefined;
    if (!events) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "ACTIVITY_TURN_NOT_FOUND", message: "Activity turn not found", retryable: false } }));
      return;
    }
    const after = Number(url.searchParams.get("after") ?? -1);
    const replay = events.filter((event) => event.sequence > after);
    if (streamPath) {
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("x-accel-buffering", "no");
      response.write(replay.map((event) => `id: ${event.sequence}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`).join(""));
      if (events.some((event) => event.kind === "terminal")) {
        response.end();
        return;
      }
      const subscriber = { response, cursor: replay.at(-1)?.sequence ?? after };
      const subscribers = activitySubscribers.get(requestedTurnId) ?? new Set();
      subscribers.add(subscriber);
      activitySubscribers.set(requestedTurnId, subscribers);
      response.once("close", () => subscribers.delete(subscriber));
      return;
    }
    response.end(JSON.stringify({
      events: replay,
      nextAfterSequence: replay.at(-1)?.sequence ?? null,
      terminal: after >= events.at(-1).sequence || replay.some((event) => event.kind === "terminal"),
    }));
    return;
  }
  if (key === "GET /v1/workspaces") {
    response.end(JSON.stringify({ workspaces: fixtureWorkspaces }));
    return;
  }
  if (key === "GET /v1/sites") {
    response.end(JSON.stringify({ sites: fixtureSites }));
    return;
  }
  if (request.method === "GET" && /^\/v1\/sites\/[0-9a-f-]+\/preview$/.test(url.pathname)) {
    const id = url.pathname.split("/").at(-2);
    const site = fixtureSites.find((item) => item.id === id);
    if (!site) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "SITE_NOT_FOUND", message: "Site not found", retryable: false } }));
      return;
    }
    response.end(JSON.stringify({ site, revision: site.currentRevision, artifactSha256: "d".repeat(64), html: helloSiteHtml }));
    return;
  }
  if (request.method === "GET" && /^\/v1\/sites\/[0-9a-f-]+\/content$/.test(url.pathname)) {
    const id = url.pathname.split("/").at(-2);
    const site = fixtureSites.find((item) => item.id === id);
    if (!site) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "SITE_NOT_FOUND", message: "Site not found", retryable: false } }));
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("content-security-policy", "sandbox allow-scripts; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'");
    response.setHeader("cross-origin-opener-policy", "same-origin");
    response.end(helloSiteHtml);
    return;
  }
  if (request.method === "DELETE" && /^\/v1\/sites\/[0-9a-f-]+$/.test(url.pathname)) {
    const id = url.pathname.split("/").at(-1);
    fixtureSites = fixtureSites.filter((item) => item.id !== id);
    response.statusCode = 204;
    response.end();
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
    response.end(JSON.stringify({ connections: fixtureMcpConnections.map((connector) => ({
      ...connector,
      canAdministerConnector: true,
      canManageConnection: true,
    })) }));
    return;
  }
  if (key === "GET /v1/admin/connectors") {
    response.end(JSON.stringify({ connectors: fixtureMcpConnections }));
    return;
  }
  if (request.method === "PUT" && /^\/v1\/admin\/connectors\/[^/]+\/access-policy$/.test(url.pathname)) {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const connectorId = url.pathname.split("/").at(-2);
      const input = JSON.parse(body);
      fixtureMcpConnections = fixtureMcpConnections.map((connector) => connector.id === connectorId ? {
        ...connector,
        enabled: input.enabled,
        membersCanManage: input.membersCanManage,
        accessPolicyVersion: connector.accessPolicyVersion + 1,
        accessPolicyUpdatedAt: new Date().toISOString(),
        canManageConnection: input.enabled,
      } : connector);
      response.end(JSON.stringify({
        connector: fixtureMcpConnections.find((connector) => connector.id === connectorId),
        workspaceGrants: { refreshed: 2, failed: 0 },
      }));
    });
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
        serverName: `lemmacomputer_${id.replaceAll("-", "_")}`,
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
        canAdministerConnector: true,
        canManageConnection: true,
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
      securityGroup: sandboxSettings.securityGroup ?? inheritedEgressGroup(sandboxSettings.profileId),
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
          requestedServiceClass: input.requestedServiceClass,
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
  const createChatSessionMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/chat\/agents\/(hermes-claw|codex-cli|claude-cli)\/sessions$/);
  if (request.method === "POST" && createChatSessionMatch && [workspaceId, productWorkspaceId].includes(decodeURIComponent(createChatSessionMatch[1]))) {
    const agentCatalogId = decodeURIComponent(createChatSessionMatch[2]);
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = body ? JSON.parse(body) : {};
      response.statusCode = 201;
      response.end(JSON.stringify({
        ...chatSession,
        id: `fixture-session-${Date.now()}`,
        title: input.title ?? null,
        agentCatalogId,
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      }));
    });
    return;
  }
  const cancelTurnMatch = url.pathname.match(/^\/v1\/workspaces\/[^/]+\/chat\/agents\/hermes-claw\/sessions\/([^/]+)\/turns\/active$/);
  if (request.method === "DELETE" && cancelTurnMatch) {
    const sessionId = decodeURIComponent(cancelTurnMatch[1]);
    const activeTurn = activeFixtureTurns.get(sessionId);
    if (activeTurn) {
      if (activeTurn.completionTimer) clearTimeout(activeTurn.completionTimer);
      activeFixtureTurns.delete(sessionId);
      const checkpoint = chatMessages.findIndex((message) => message.id === activeTurn.messageId);
      const existing = checkpoint === -1 ? null : chatMessages[checkpoint];
      const cancelled = {
        id: activeTurn.messageId,
        role: "assistant",
        metadata: {
          agentCatalogId: "hermes-claw",
          turnId: activeTurn.turnId,
          state: "cancelled",
          createdAt: activeTurn.createdAt,
        },
        parts: [
          ...(existing?.parts ?? []).filter((part) => part.type !== "data-terminal").map((part) => (
            part.type === "text" ? { ...part, state: "done" } : part
          )),
          {
            type: "data-terminal",
            id: `${activeTurn.turnId}-terminal`,
            data: { turnId: activeTurn.turnId, state: "cancelled", message: "Stopped by the employee" },
          },
        ],
      };
      if (checkpoint === -1) chatMessages.push(cancelled);
      else chatMessages.splice(checkpoint, 1, cancelled);
      const events = activityByTurn.get(activeTurn.turnId) ?? [];
      appendActivity(activeTurn.turnId, activityEvent(
        activeTurn.turnId,
        Math.max(-1, ...events.map((event) => event.sequence)) + 1,
        "terminal",
        "cancelled",
        "deterministic_system",
        { turnState: "cancelled", message: "Stopped by the employee" },
      ));
    }
    response.statusCode = 204;
    response.end();
    return;
  }
  const sendChatMessageMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/chat\/agents\/(hermes-claw|codex-cli|claude-cli)\/sessions\/([^/]+)\/messages$/);
  if (request.method === "POST" && sendChatMessageMatch && [workspaceId, productWorkspaceId].includes(decodeURIComponent(sendChatMessageMatch[1]))) {
    const agentCatalogId = decodeURIComponent(sendChatMessageMatch[2]);
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const turnId = `fixture-turn-${Date.now()}`;
      const messageId = `fixture-message-${Date.now()}`;
      const createdAt = new Date().toISOString();
      activityByTurn.set(turnId, [activityEvent(turnId, 0, "plan", "running", "deterministic_system", { title: "Understand the request" })]);
      disconnectActivityOnce.add(turnId);
      setTimeout(() => appendActivity(turnId, activityEvent(turnId, 1, "progress", "running", "deterministic_system", { activityId: `${turnId}-progress`, label: "Checking workspace context" })), 650);
      setTimeout(() => appendActivity(turnId, activityEvent(turnId, 2, "tool", "completed", "tool", { toolCallId: `${turnId}-tool`, name: "workspace-context", summary: "Context checked" })), 760);
      setTimeout(() => appendActivity(turnId, activityEvent(turnId, 3, "provider_summary", "completed", "provider_generated", { summary: "The workspace context is ready for the response.", provider: "Hermes" })), 900);
      setTimeout(() => appendActivity(turnId, activityEvent(turnId, 4, "terminal", "completed", "deterministic_system", { turnState: "completed" })), 1_000);
      const siteRequest = JSON.stringify(input.message).includes("$make-a-site");
      const siteRefreshRequest = siteRequest && JSON.stringify(input.message).includes("survive refresh");
      const refreshRecoveryRequest = JSON.stringify(input.message).includes("dashboard layout");
      const stopRecoveryRequest = JSON.stringify(input.message).includes("until I stop you");
      const openingText = siteRequest
        ? "I’ll build the smallest Vite site and publish it with the reviewed skill.\n\n"
        : "I’ll check the workspace context first, then summarize what I can do.\n\n";
      const closingText = siteRequest
        ? "Published **Hello world**. Open LemmaComputer → Sites to view it."
        : "I’m working inside your workspace and can use only:\n\n- approved tools\n- approved destinations";
      const openingChunks = [
        { type: "start", messageId, messageMetadata: { agentCatalogId, turnId, state: "streaming", createdAt } },
        { type: "data-progress", id: `${turnId}-progress`, data: { activityId: `${turnId}-progress`, label: siteRequest ? "Updating the site files…" : "Reviewing the workspace context…", state: "running" } },
        { type: "data-tool", id: `${turnId}-tool`, data: { toolCallId: `${turnId}-tool`, name: "workspace-context", state: "running", summary: "Internal fixture tool" } },
        { type: "text-start", id: `${turnId}-text` },
        { type: "text-delta", id: `${turnId}-text`, delta: openingText },
      ];
      const closingChunks = [
        { type: "data-tool", id: `${turnId}-tool`, data: { toolCallId: `${turnId}-tool`, name: "workspace-context", state: "completed", summary: "Internal fixture tool" } },
        { type: "data-progress", id: `${turnId}-progress`, data: { activityId: `${turnId}-progress`, label: "Work complete", state: "completed" } },
        { type: "text-delta", id: `${turnId}-text`, delta: closingText },
        { type: "text-end", id: `${turnId}-text` },
        { type: "data-terminal", id: `${turnId}-terminal`, data: { turnId, state: "completed" } },
        { type: "finish", finishReason: "stop", messageMetadata: { agentCatalogId, turnId, state: "completed", createdAt } },
      ];
      chatMessages.push(input.message);
      const sessionId = decodeURIComponent(url.pathname.split("/").at(-2));
      const activeTurn = { turnId, messageId, createdAt, completionTimer: null };
      activeFixtureTurns.set(sessionId, activeTurn);
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("x-vercel-ai-ui-message-stream", "v1");
      setTimeout(() => {
        if (activeFixtureTurns.get(sessionId) !== activeTurn) return;
        chatMessages.push({
          id: messageId,
          role: "assistant",
          metadata: { agentCatalogId, turnId, state: "streaming", createdAt },
          parts: [
            { type: "data-progress", id: `${turnId}-progress`, data: { activityId: `${turnId}-progress`, label: siteRequest ? "Updating the site files…" : "Reviewing the workspace context…", state: "running" } },
            { type: "data-tool", id: `${turnId}-tool`, data: { toolCallId: `${turnId}-tool`, name: "workspace-context", state: "running", summary: "Internal fixture tool" } },
            { type: "text", text: openingText, state: "streaming" },
          ],
        });
        response.write(openingChunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""));
      }, 600);
      activeTurn.completionTimer = setTimeout(() => {
        if (activeFixtureTurns.get(sessionId) !== activeTurn) return;
        activeFixtureTurns.delete(sessionId);
        if (siteRequest) {
          const publishedAt = new Date().toISOString();
          fixtureSites = [{
            id: "7c536c1f-6a31-427d-af8f-dbb0c63f8d73",
            slug: "hello-world",
            name: "Hello world",
            state: "ready",
            currentRevision: 1,
            sourceWorkspaceId: workspaceId,
            sourceAgentId: "agent-alex:hermes",
            createdAt: publishedAt,
            updatedAt: publishedAt,
          }];
        }
        const completed = {
          id: messageId,
          role: "assistant",
          metadata: { agentCatalogId, turnId, state: "completed", createdAt },
          parts: [
            { type: "data-progress", id: `${turnId}-progress`, data: { activityId: `${turnId}-progress`, label: "Work complete", state: "completed" } },
            { type: "data-tool", id: `${turnId}-tool`, data: { toolCallId: `${turnId}-tool`, name: "workspace-context", state: "completed", summary: "Internal fixture tool" } },
            { type: "text", text: `${openingText}${closingText}`, state: "done" },
            { type: "data-terminal", id: `${turnId}-terminal`, data: { turnId, state: "completed" } },
          ],
        };
        const checkpoint = chatMessages.findIndex((message) => message.id === messageId);
        if (checkpoint === -1) chatMessages.push(completed);
        else chatMessages.splice(checkpoint, 1, completed);
        response.end(`${closingChunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
      }, stopRecoveryRequest ? 10_000 : siteRefreshRequest ? 4_000 : refreshRecoveryRequest ? 3_000 : 1_000);
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/admin/spend/export") {
    if (url.searchParams.get("format") === "json") {
      response.setHeader("content-disposition", "attachment; filename=\"lemmacomputer-ai-spend.json\"");
      response.end(JSON.stringify({ report: fixtureSpendReport() }));
      return;
    }
    response.setHeader("content-type", "text/csv; charset=utf-8");
    response.setHeader("content-disposition", "attachment; filename=\"lemmacomputer-ai-spend.csv\"");
    response.end("contract_version,team_id,user_id,task_id,currency,provider_cost\r\n1,11111111-1111-4111-8111-111111111111,alex-morgan,quarterly-analysis-001,USD,74.25\r\n");
    return;
  }
  if (request.method === "GET" && /^\/v1\/admin\/spend\/tasks\/[^/]+$/.test(url.pathname)) {
    const taskKey = decodeURIComponent(url.pathname.split("/").at(-1));
    const task = fixtureSpendTasks.find((item) => item.taskKey === taskKey);
    if (!task) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "SPEND_VIEW_NOT_FOUND", message: "Spend view not found", retryable: false } }));
      return;
    }
    response.end(JSON.stringify({ task: {
      task,
      drivers: [
        { code: "attachments", label: "Attachments", score: "400", evidenceCount: "400" },
        { code: "output_reasoning", label: "Output and reasoning", score: "125", evidenceCount: "125" },
        { code: "conversation_history", label: "Conversation history", score: "12", evidenceCount: "12" },
      ],
      attempts: [{
        admissionId: `fixture-admission-${task.taskId}`, attemptKind: "inference", parentAttemptId: null,
        requestedRoute: task.requestedRoute, selectedServiceClass: task.requestedRoute,
        provider: task.resolvedRoutes[0].split("/")[0], model: task.resolvedRoutes[0].split("/")[1], deploymentId: "fixture-deployment",
        outcome: "success", latencyMs: 1450, occurredAt: "2026-07-20T10:00:00.000Z", costs: task.costs, providerConfirmedCosts: [],
        usage: task.usage, priceStatus: task.priceState === "missing" ? "unknown" : "priced", costStatus: task.priceState === "missing" ? "unpriced" : "estimated",
        correction: task.corrected, priceBasis: task.priceState === "missing" ? null : { rateCardId: "fixture-rate", source: "pinned_catalogue", version: "2026-07", sourceHash: "a".repeat(64), effectiveFrom: "2026-07-01T00:00:00.000Z" },
      }],
    } }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/admin/spend") {
    const empty = url.searchParams.get("from")?.startsWith("2020-");
    const cursor = url.searchParams.get("cursor");
    const tasks = cursor ? fixtureSpendTasks.slice(200) : fixtureSpendTasks.slice(0, 200);
    const report = fixtureSpendReport(tasks, empty);
    response.end(JSON.stringify({
      report,
      page: { limit: 200, returnedTasks: report.tasks.length, totalTasks: empty ? 0 : 201, nextCursor: !empty && !cursor ? "fixture-spend-next" : null },
    }));
    return;
  }
  if (key === "GET /v1/admin/teams") {
    response.end(JSON.stringify({ teams: fixtureTeams }));
    return;
  }
  if(key==="GET /v1/admin/ai-usage/rate-cards"){response.end(JSON.stringify({rateCards:fixtureRateCards}));return;}
  if(key==="POST /v1/admin/ai-usage/rate-cards"){
    let body="";request.on("data",(chunk)=>{body+=chunk});request.on("end",()=>{const input=JSON.parse(body);const id=crypto.randomUUID();fixtureRateCards=[{id,...input,catalogueRelease:null,effectiveTo:input.effectiveTo??null,approvedAt:new Date().toISOString(),approvedBy:"fixture-admin"},...fixtureRateCards];response.statusCode=201;response.end(JSON.stringify({id}))});return;
  }
  if(key==="GET /v1/admin/routing/mappings/latest"){response.end(JSON.stringify({mapping:fixtureLatestRoutingMapping}));return;}
  if(key==="POST /v1/admin/routing/mappings"){
    let body="";request.on("data",(chunk)=>{body+=chunk});request.on("end",()=>{const input=JSON.parse(body);fixtureLatestRoutingMapping={id:crypto.randomUUID(),tenantId:"acme",revisionNote:input.revisionNote,createdBy:"fixture-admin",createdAt:new Date().toISOString(),deployments:input.deployments.map((deployment)=>({id:crypto.randomUUID(),...deployment,providerAccountId:deployment.providerAccountId??null,region:deployment.region??null,providerServiceTier:deployment.providerServiceTier??null,rateCardId:deployment.rateCardId??null}))};response.statusCode=201;response.end(JSON.stringify({mapping:fixtureLatestRoutingMapping}))});return;
  }
  if(request.method==="GET"&&/^\/v1\/admin\/teams\/[0-9a-f-]+\/routing$/.test(url.pathname)){response.end(JSON.stringify(fixtureRoutingSettings()));return;}
  if(request.method==="GET"&&/^\/v1\/admin\/teams\/[0-9a-f-]+\/routing\/shadow-report$/.test(url.pathname)){response.end(JSON.stringify(fixtureRoutingReport()));return;}
  if(request.method==="GET"&&/^\/v1\/admin\/routing\/decisions\/[0-9a-f-]+$/.test(url.pathname)){response.end(JSON.stringify({id:url.pathname.split("/").at(-1),selected_service_class:"lite",reason_code:"complexity_classifier",executed_provider:"bedrock",executed_model:"private/terra",executed_provider_deployment:"bedrock/terra",mapping_version_id:routingMappingId,rate_card_id:"99999999-9999-4999-8999-999999999992",candidates:[{ordinal:0,deployment_id:routingDeploymentIds.lite,provider:"foundry",provider_deployment:"foundry/luna",eligibility:"eligible",reason_code:null},{ordinal:1,deployment_id:routingDeploymentIds.pro,provider:"bedrock",provider_deployment:"bedrock/sol",eligibility:"ineligible",reason_code:"budget"}]}));return;}
  if(request.method==="POST"&&/^\/v1\/admin\/teams\/[0-9a-f-]+\/routing\/reviews$/.test(url.pathname)){let body="";request.on("data",(chunk)=>{body+=chunk});request.on("end",()=>{const input=JSON.parse(body);fixtureRoutingReview={id:"88888888-8888-4888-8888-888888888888",tenantId:"acme",teamId:fixtureSpendTeamId,...input,reviewerUserId:"fixture-admin",reviewedAt:new Date().toISOString()};response.statusCode=201;response.end(JSON.stringify(fixtureRoutingReview))});return;}
  if(request.method==="PUT"&&/^\/v1\/admin\/teams\/[0-9a-f-]+\/routing\/policy$/.test(url.pathname)){let body="";request.on("data",(chunk)=>{body+=chunk});request.on("end",()=>{const input=JSON.parse(body);Object.assign(routingScope,input.team??input.identity);response.end(JSON.stringify({id:routingPolicyId}))});return;}
  if(request.method==="POST"&&/^\/v1\/admin\/teams\/[0-9a-f-]+\/routing\/rollout$/.test(url.pathname)){
    let body="";request.on("data",(chunk)=>{body+=chunk});request.on("end",()=>{const input=JSON.parse(body);if(input.mode==="enabled"&&input.confirmation!=="ENABLE AUTO ROUTING"){response.statusCode=400;response.end(JSON.stringify({error:{message:"Explicit production enable confirmation is required"}}));return}fixtureRoutingMode=input.mode;response.statusCode=201;response.end(JSON.stringify({rollout:fixtureRoutingSettings().rollout}))});return;
  }
  if(request.method==="POST"&&/^\/v1\/admin\/teams\/[0-9a-f-]+\/routing\/kill-switch$/.test(url.pathname)){fixtureRoutingMode="disabled";response.statusCode=201;response.end(JSON.stringify({rollout:fixtureRoutingSettings().rollout}));return;}
  if (request.method === "GET" && /^\/v1\/admin\/teams\/[0-9a-f-]+\/budget$/.test(url.pathname)) {
    response.end(JSON.stringify({status:fixtureBudgetStatus(url.pathname.split("/").at(-2))}));
    return;
  }
  if (request.method === "PUT" && /^\/v1\/admin\/teams\/[0-9a-f-]+\/budget$/.test(url.pathname)) {
    let body="";request.on("data",(chunk)=>{body+=chunk;});request.on("end",()=>{
      const teamId=url.pathname.split("/").at(-2);const input=JSON.parse(body);const createdAt=new Date().toISOString();
      const status={
        budget:{id:crypto.randomUUID(),tenantId:"fixture-tenant",teamId,limitAmount:input.limitAmount,currency:input.currency,periodType:input.periodType,timezone:input.timezone,mode:input.mode,thresholds:input.thresholds,effectiveFrom:input.effectiveFrom, effectiveTo:null,createdBy:session.user.userId,createdAt},
        period:fixturePeriod(),effectiveLimitAmount:input.limitAmount,settledProviderCost:"650.000000000000",outstandingReservations:"100.000000000000",remainingAmount:String(Number(input.limitAmount)-750),percentConsumed:String(750 / Number(input.limitAmount) * 100),priceStatus:"priced",enforcement:input.mode,
        alerts:[{thresholdPercent:"50",createdAt}],lastReconciliation:{status:"current",checkedAt:createdAt,detail:null},
      };
      fixtureTeamBudgets.set(teamId,status);response.end(JSON.stringify({status,reconciliation:{status:"matched"}}));
    });
    return;
  }
  if (request.method === "POST" && /^\/v1\/admin\/teams\/[0-9a-f-]+\/budget\/override$/.test(url.pathname)) {
    let body="";request.on("data",(chunk)=>{body+=chunk;});request.on("end",()=>{
      const teamId=url.pathname.split("/").at(-3);const input=JSON.parse(body);const current=fixtureBudgetStatus(teamId);
      const status={...current,effectiveLimitAmount:input.newLimitAmount??current.effectiveLimitAmount,enforcement:"override",remainingAmount:input.newLimitAmount?String(Number(input.newLimitAmount)-Number(current.settledProviderCost)-Number(current.outstandingReservations)):current.remainingAmount};
      fixtureTeamBudgets.set(teamId,status);response.end(JSON.stringify({status,reconciliation:{status:"matched"}}));
    });
    return;
  }
  if (request.method === "POST" && /^\/v1\/admin\/teams\/[0-9a-f-]+\/budget\/reconcile$/.test(url.pathname)) {
    const teamId=url.pathname.split("/").at(-3);const current=fixtureBudgetStatus(teamId);const checkedAt=new Date().toISOString();
    fixtureTeamBudgets.set(teamId,{...current,lastReconciliation:{status:"current",checkedAt,detail:null}});
    response.end(JSON.stringify({reconciliation:{status:"matched",checkedAt}}));return;
  }
  if (key === "POST /v1/admin/teams") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const timestamp = new Date().toISOString();
      const team = {
        id: crypto.randomUUID(),
        displayName: input.displayName,
        description: input.description ?? "",
        ownerUserId: input.ownerUserId,
        costCenterCode: input.costCenterCode ?? null,
        status: "active",
        isRolloutFallback: false,
        activeMemberCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
      };
      fixtureTeams.push(team);
      fixtureTeamMemberships.set(team.id, []);
      response.statusCode = 201;
      response.end(JSON.stringify({ team: fixtureTeamDetail(team.id) }));
    });
    return;
  }
  if (request.method === "GET" && /^\/v1\/admin\/teams\/[0-9a-f-]+$/.test(url.pathname)) {
    response.end(JSON.stringify({ team: fixtureTeamDetail(url.pathname.split("/").at(-1)) }));
    return;
  }
  if (request.method === "PATCH" && /^\/v1\/admin\/teams\/[0-9a-f-]+$/.test(url.pathname)) {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const teamId = url.pathname.split("/").at(-1);
      const input = JSON.parse(body);
      fixtureTeams = fixtureTeams.map((team) => team.id === teamId ? { ...team, ...input, updatedAt: new Date().toISOString() } : team);
      response.end(JSON.stringify({ team: fixtureTeamDetail(teamId) }));
    });
    return;
  }
  if (request.method === "POST" && /^\/v1\/admin\/teams\/[0-9a-f-]+\/memberships$/.test(url.pathname)) {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const teamId = url.pathname.split("/").at(-2);
      const input = JSON.parse(body);
      const memberships = fixtureTeamMemberships.get(teamId) ?? [];
      let membership = memberships.find((item) => item.userId === input.userId && !item.effectiveTo);
      if (!membership) {
        membership = { id: crypto.randomUUID(), teamId, userId: input.userId, effectiveFrom: new Date().toISOString(), effectiveTo: null, isDefaultSpendingTeam: false };
        fixtureTeamMemberships.set(teamId, [membership, ...memberships]);
      }
      fixtureTeams = fixtureTeams.map((team) => team.id === teamId ? { ...team, activeMemberCount: (fixtureTeamMemberships.get(teamId) ?? []).filter((item) => !item.effectiveTo).length } : team);
      response.statusCode = 201;
      response.end(JSON.stringify({ membership }));
    });
    return;
  }
  if (request.method === "DELETE" && /^\/v1\/admin\/teams\/[0-9a-f-]+\/memberships\/[^/]+$/.test(url.pathname)) {
    const parts = url.pathname.split("/");
    const teamId = parts.at(-3);
    const userId = decodeURIComponent(parts.at(-1));
    fixtureTeamMemberships.set(teamId, (fixtureTeamMemberships.get(teamId) ?? []).map((membership) => (
      membership.userId === userId && !membership.effectiveTo
        ? { ...membership, effectiveTo: new Date().toISOString(), isDefaultSpendingTeam: false }
        : membership
    )));
    fixtureTeams = fixtureTeams.map((team) => team.id === teamId ? { ...team, activeMemberCount: (fixtureTeamMemberships.get(teamId) ?? []).filter((item) => !item.effectiveTo).length } : team);
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method === "PUT" && /^\/v1\/admin\/teams\/[0-9a-f-]+\/default$/.test(url.pathname)) {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const teamId = url.pathname.split("/").at(-2);
      const input = JSON.parse(body);
      const team = fixtureTeams.find((candidate) => candidate.id === teamId);
      for (const [candidateTeamId, memberships] of fixtureTeamMemberships) {
        fixtureTeamMemberships.set(candidateTeamId, memberships.map((membership) => ({
          ...membership,
          isDefaultSpendingTeam: !membership.effectiveTo && candidateTeamId === teamId && membership.userId === input.userId,
        })));
      }
      response.end(JSON.stringify({ team: { id: team.id, displayName: team.displayName, costCenterCode: team.costCenterCode, isRolloutFallback: false }, userId: input.userId }));
    });
    return;
  }
  if (request.method === "POST" && /^\/v1\/admin\/teams\/[0-9a-f-]+\/archive$/.test(url.pathname)) {
    const teamId = url.pathname.split("/").at(-2);
    fixtureTeams = fixtureTeams.map((team) => team.id === teamId ? { ...team, status: "archived", archivedAt: new Date().toISOString(), activeMemberCount: 0 } : team);
    fixtureTeamMemberships.set(teamId, (fixtureTeamMemberships.get(teamId) ?? []).map((membership) => (
      membership.effectiveTo ? membership : { ...membership, effectiveTo: new Date().toISOString(), isDefaultSpendingTeam: false }
    )));
    response.end(JSON.stringify({ team: fixtureTeamDetail(teamId) }));
    return;
  }
  if (key === "GET /v1/admin/roles") {
    response.end(JSON.stringify({ catalog: fixtureRoleCatalog, builtInRoles: ["owner", "admin", "member"], delegableBuiltInRoles: ["owner", "admin", "member"], roles: fixtureOrganizationRoles }));
    return;
  }
  if (key === "POST /v1/admin/roles") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const timestamp = new Date().toISOString();
      const role = {
        id: crypto.randomUUID(), organizationId: session.tenant.id,
        name: input.name, description: input.description, status: "active",
        version: 1, catalogVersion: fixtureRoleCatalog.version, grants: input.grants,
        assignedMembershipCount: 0, assignedMembershipIds: [], createdAt: timestamp, updatedAt: timestamp,
      };
      fixtureOrganizationRoles.push(role);
      response.statusCode = 201;
      response.end(JSON.stringify({ role }));
    });
    return;
  }
  if (request.method === "PATCH" && /^\/v1\/admin\/roles\/[0-9a-f-]+$/.test(url.pathname)) {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const roleId = url.pathname.split("/").at(-1);
      const input = JSON.parse(body);
      let updated;
      fixtureOrganizationRoles = fixtureOrganizationRoles.map((role) => {
        if (role.id !== roleId) return role;
        updated = { ...role, name: input.name, description: input.description, grants: input.grants, version: role.version + 1, updatedAt: new Date().toISOString() };
        return updated;
      });
      response.end(JSON.stringify({ role: { ...updated, revokedSessions: updated.assignedMembershipCount } }));
    });
    return;
  }
  if (request.method === "DELETE" && /^\/v1\/admin\/roles\/[0-9a-f-]+$/.test(url.pathname)) {
    const roleId = url.pathname.split("/").at(-1);
    let archived;
    fixtureOrganizationRoles = fixtureOrganizationRoles.map((role) => {
      if (role.id !== roleId) return role;
      archived = { ...role, status: "archived", assignedMembershipCount: 0, assignedMembershipIds: [], updatedAt: new Date().toISOString() };
      return archived;
    });
    response.end(JSON.stringify({ role: archived, revokedSessions: archived?.assignedMembershipCount ?? 0 }));
    return;
  }
  if (request.method === "POST" && /^\/v1\/admin\/memberships\/[0-9a-f-]+\/roles$/.test(url.pathname)) {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const membershipId = url.pathname.split("/").at(-2);
      const { roleId } = JSON.parse(body);
      fixtureOrganizationRoles = fixtureOrganizationRoles.map((role) => role.id === roleId && !role.assignedMembershipIds.includes(membershipId)
        ? { ...role, assignedMembershipIds: [...role.assignedMembershipIds, membershipId], assignedMembershipCount: role.assignedMembershipCount + 1 }
        : role);
      response.end(JSON.stringify({ revokedSessions: 1 }));
    });
    return;
  }
  if (request.method === "DELETE" && /^\/v1\/admin\/memberships\/[0-9a-f-]+\/roles\/[0-9a-f-]+$/.test(url.pathname)) {
    const parts = url.pathname.split("/");
    const membershipId = parts.at(-3);
    const roleId = parts.at(-1);
    fixtureOrganizationRoles = fixtureOrganizationRoles.map((role) => role.id === roleId
      ? { ...role, assignedMembershipIds: role.assignedMembershipIds.filter((id) => id !== membershipId), assignedMembershipCount: Math.max(0, role.assignedMembershipCount - 1) }
      : role);
    response.end(JSON.stringify({ revokedSessions: 1 }));
    return;
  }
  if (key === "GET /v1/admin/users") {
    response.end(JSON.stringify({ delegableBuiltInRoles: ["owner", "admin", "member"], users: adminUsers }));
    return;
  }
  if (key === "GET /v1/admin/member-workspaces") {
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify({ members: memberWorkspaceInventory() }));
    return;
  }
  const workspaceAdministrationMatch = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)\/workspaces\/([^/]+)\/runtime\/(start|restart|stop|terminate_runtime)$/);
  if (request.method === "POST" && workspaceAdministrationMatch) {
    const [, encodedUserId, encodedWorkspaceId, action] = workspaceAdministrationMatch;
    const userId = decodeURIComponent(encodedUserId);
    const administeredWorkspaceId = decodeURIComponent(encodedWorkspaceId);
    const nextState = action === "stop" || action === "terminate_runtime" ? "stopped" : "ready";
    adminUsers = adminUsers.map((user) => user.userId === userId ? {
      ...user,
      workspaces: user.workspaces.map((item) => item.id === administeredWorkspaceId ? { ...item, state: nextState } : item),
    } : user);
    response.end(JSON.stringify({
      command: { id: `fixture-workspace-command-${Date.now()}`, action, status: "succeeded", replayed: false },
      workspace: { id: administeredWorkspaceId, state: nextState, failureCode: null, updatedAt: new Date().toISOString() },
    }));
    return;
  }
  if (key === "GET /v1/admin/protected-workspace-policy") {
    response.end(JSON.stringify(protectedWorkspacePolicyOverview));
    return;
  }
  if (key === "GET /v1/admin/protected-workspace-policy/organization-versions") {
    response.end(JSON.stringify({ versions: protectedWorkspacePolicyOverview.organizationPolicyVersions }));
    return;
  }
  if (key === "POST /v1/admin/protected-workspace-policy/organization-versions") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const previous = protectedWorkspacePolicyOverview.organizationPolicyVersions[0] ?? null;
      const version = {
        tenantId: session.tenant.id,
        policyVersionId: `fixture-organization-policy-${(previous?.version ?? 0) + 1}`,
        version: (previous?.version ?? 0) + 1,
        previousPolicyVersionId: previous?.policyVersionId ?? null,
        documentHash: "9".repeat(64),
        constraints: input.constraints,
        revisionNote: input.revisionNote,
        createdBy: session.user.id,
        createdAt: new Date().toISOString(),
      };
      protectedWorkspacePolicyOverview.organizationPolicyVersions.unshift(version);
      response.statusCode = 201;
      response.end(JSON.stringify({ version }));
    });
    return;
  }
  if (key === "GET /v1/admin/invitations") {
    response.end(JSON.stringify({ invitations: fixtureInvitations }));
    return;
  }
  if (key === "POST /v1/admin/invitations") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const timestamp = new Date().toISOString();
      const invitation = {
        invitationId: fixtureInvitationId,
        organizationId: session.tenant.id,
        email: input.email.toLowerCase(),
        role: input.role,
        status: "pending",
        deliveryGeneration: 1,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
        acceptedMembershipId: null,
        createdBy: session.user.id,
        updatedBy: session.user.id,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      fixtureInvitations = [invitation, ...fixtureInvitations.filter((item) => item.invitationId !== invitation.invitationId)];
      response.statusCode = 201;
      response.end(JSON.stringify({ invitation, replayed: false, acceptancePath: "/invite?token=oci_fixture_invitation_token" }));
    });
    return;
  }
  if (request.method === "POST" && /^\/v1\/admin\/invitations\/[0-9a-f-]+\/resend$/.test(url.pathname)) {
    const invitationId = url.pathname.split("/").at(-2);
    let resent;
    fixtureInvitations = fixtureInvitations.map((invitation) => {
      if (invitation.invitationId !== invitationId) return invitation;
      resent = {
        ...invitation,
        status: "pending",
        deliveryGeneration: invitation.deliveryGeneration + 1,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return resent;
    });
    response.end(JSON.stringify({ invitation: resent, replayed: false, acceptancePath: "/invite?token=oci_fixture_rotated_token" }));
    return;
  }
  if (request.method === "DELETE" && /^\/v1\/admin\/invitations\/[0-9a-f-]+$/.test(url.pathname)) {
    const invitationId = url.pathname.split("/").at(-1);
    let revoked;
    fixtureInvitations = fixtureInvitations.map((invitation) => {
      if (invitation.invitationId !== invitationId) return invitation;
      revoked = { ...invitation, status: "revoked", updatedAt: new Date().toISOString() };
      return revoked;
    });
    response.end(JSON.stringify({ invitation: revoked, replayed: false }));
    return;
  }
  if (request.method === "PATCH" && /^\/v1\/admin\/memberships\/[^/]+$/.test(url.pathname)) {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const userId = decodeURIComponent(url.pathname.split("/").at(-1));
      const input = JSON.parse(body);
      adminUsers = adminUsers.map((user) => user.userId === userId ? {
        ...user,
        ...(input.role ? { role: input.role, roles: input.role === "member" ? ["member", "employee"] : [input.role, "administrator"] } : {}),
        ...(input.status ? { membershipStatus: input.status, status: input.status === "active" ? "active" : "disabled" } : {}),
      } : user);
      const user = adminUsers.find((candidate) => candidate.userId === userId);
      response.end(JSON.stringify({ membership: { userId, role: user.role, status: user.membershipStatus }, revokedSessions: input.status && input.status !== "active" ? 1 : 0, revokedWorkspaceGrants: { revoked: input.status && input.status !== "active" ? 1 : 0, failed: 0 } }));
    });
    return;
  }
  if (request.method === "PATCH" && /^\/v1\/admin\/users\/[^/]+\/status$/.test(url.pathname)) {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const userId = url.pathname.split("/").at(-2);
      const input = JSON.parse(body);
      adminUsers = adminUsers.map((user) => user.userId === userId ? { ...user, status: input.status } : user);
      response.end(JSON.stringify({ status: input.status, revokedSessions: input.status === "disabled" ? 1 : 0 }));
    });
    return;
  }
  if (request.method === "POST" && /^\/v1\/admin\/users\/[^/]+\/sessions\/revoke$/.test(url.pathname)) {
    response.end(JSON.stringify({ revokedSessions: 1 }));
    return;
  }
  if (request.method === "GET" && /^\/v1\/admin\/users\/[^/]+\/sandbox-settings$/.test(url.pathname)) {
    const userId = decodeURIComponent(url.pathname.split("/")[4]);
    const grantId = url.searchParams.get("grantId") ?? "personal";
    const targetWorkspace = adminUsers.find((user) => user.userId === userId)?.workspaces.find((item) => item.grantId === grantId);
    const targetProfile = targetWorkspace?.profileId === disposableProfile.id ? disposableProfile : profile;
    response.end(JSON.stringify({
      ...sandboxSettings,
      grantId,
      profileId: targetWorkspace?.profileId ?? sandboxSettings.profileId,
      profile: targetWorkspace ? targetProfile : sandboxSettings.profile,
      securityGroup: targetWorkspace?.egress ?? sandboxSettings.securityGroup ?? inheritedEgressGroup(sandboxSettings.profileId),
      availableSecurityGroups: egressSecurityGroups,
    }));
    return;
  }
  if (request.method === "PUT" && /^\/v1\/admin\/users\/[^/]+\/sandbox-settings$/.test(url.pathname)) {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const configuration = JSON.parse(body);
      sandboxSettings = { ...sandboxSettings, configuration, ...configuration, profile: configuration.profileId === disposableProfile.id ? disposableProfile : profile, updatedAt: new Date().toISOString() };
      response.end(JSON.stringify(sandboxSettings));
    });
    return;
  }
  if (request.method === "POST" && /^\/v1\/admin\/users\/[^/]+\/workspaces\/[^/]+\/egress-security-group$/.test(url.pathname)) {
    const pathParts = url.pathname.split("/");
    const userId = decodeURIComponent(pathParts[4]);
    const grantId = decodeURIComponent(pathParts[6]);
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const group = egressSecurityGroups.find((candidate) => candidate.id === input.securityGroupVersionId);
      const assigned = { ...group, assignmentSource: "custom" };
      adminUsers = adminUsers.map((user) => user.userId === userId ? {
        ...user,
        workspaces: user.workspaces.map((item) => item.grantId === grantId ? {
          ...item,
          egressMode: assigned.defaultAction === "allow-public-http-https" ? "full-web" : "restricted",
          egress: assigned,
        } : item),
      } : user);
      response.end(JSON.stringify(assigned));
    });
    return;
  }
  if (request.method === "DELETE" && /^\/v1\/admin\/users\/[^/]+\/workspaces\/[^/]+\/egress-security-group$/.test(url.pathname)) {
    const pathParts = url.pathname.split("/");
    const userId = decodeURIComponent(pathParts[4]);
    const grantId = decodeURIComponent(pathParts[6]);
    let inherited = inheritedEgressGroup(profile.id);
    adminUsers = adminUsers.map((user) => user.userId === userId ? {
      ...user,
      workspaces: user.workspaces.map((item) => {
        if (item.grantId !== grantId) return item;
        inherited = inheritedEgressGroup(item.profileId);
        return {
          ...item,
          egressMode: item.profileId === disposableProfile.id ? "full-web" : "restricted",
          egress: inherited,
        };
      }),
    } : user);
    response.end(JSON.stringify(inherited));
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
        isDefault: false,
        defaultFor: undefined,
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
      const assigned = { ...group, assignmentSource: "custom" };
      sandboxSettings = { ...sandboxSettings, securityGroup: assigned };
      response.end(JSON.stringify(assigned));
    });
    return;
  }
  if (request.method === "DELETE" && /^\/v1\/admin\/workspaces\/[^/]+\/egress-security-group$/.test(url.pathname)) {
    sandboxSettings = { ...sandboxSettings, securityGroup: undefined };
    response.end(JSON.stringify(inheritedEgressGroup(sandboxSettings.profileId)));
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
  process.stdout.write(`LemmaComputer UI fixture listening on http://127.0.0.1:${port}\n`);
});
