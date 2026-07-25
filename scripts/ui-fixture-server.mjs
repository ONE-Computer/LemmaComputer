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
    client: "Claude Desktop",
    clientVersion: "1.22209.3",
    modelAlias: "onecomputer-glm",
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
    id: "kasm-persistent-standard",
    client: "ONEComputer qualification CLI",
    clientVersion: "issue-006",
    modelAlias: "onecomputer-openai",
    persistence: "persistent-home",
    network: "gateway-only",
  },
};

const profile = {
  id: "claude-desktop-standard-v1",
  version: 1,
  displayName: "Claude Desktop",
  description: "A managed Claude Desktop chat workspace routed only through the ONEComputer AI gateway.",
  client: "Claude Desktop",
  clientVersion: "1.22209.3",
  persistence: "persistent-home",
  network: "gateway-only",
  resources: { cpus: 2, memoryGiB: 3 },
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
  availableProfiles: [profile],
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
};
let chatMessages = [
  { role: "user", content: "Help me prepare the priorities for our quarterly planning meeting.", createdAt: now },
  { role: "assistant", content: "I can help with that. I’ll work from the files and approved connections available in this sandbox. Which team’s priorities should we start with?", createdAt: now },
];

let egressSecurityGroups = [{
  schemaVersion: 1,
  id: "egv_fixture_agent_updates_v1",
  securityGroupId: "esg_fixture_agent_updates",
  tenantId: session.tenant.id,
  version: 1,
  name: "Approved agent updates",
  description: "Default-deny public egress for approved agent updates.",
  defaultAction: "deny",
  rules: [
    { id: "claude-downloads", action: "allow", protocol: "https", host: "downloads.claude.ai", includeSubdomains: false, port: 443, purpose: "Download approved Claude Desktop updates" },
    { id: "anthropic-api", action: "allow", protocol: "https", host: "api.anthropic.com", includeSubdomains: false, port: 443, purpose: "Connect approved Anthropic services" },
  ],
  documentHash: digest,
  createdBy: session.user.id,
  createdAt: now,
}];

let adminUsers = [
  {
    userId: session.user.id,
    email: session.user.email,
    displayName: session.user.displayName,
    roles: session.roles,
    effectivePolicy: { egressSecurityGroup: egressSecurityGroups[0] },
  },
  {
    userId: "hello-metech",
    email: "hello@metech.dev",
    displayName: "METECH",
    roles: ["employee"],
    effectivePolicy: null,
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
  ["GET /v1/connections/microsoft-365", { state: "connected", connectedAt: now, expiresAt: null }],
  [`GET /v1/workspaces/${workspaceId}/chat/status`, { workspaceId, state: "ready", reasonCode: "HERMES_CHAT_READY" }],
  [`GET /v1/workspaces/${workspaceId}/chat/sessions`, { sessions: [chatSession] }],
  [`GET /v1/workspaces/${workspaceId}/chat/sessions/${chatSession.id}/messages`, { messages: chatMessages }],
  ["GET /v1/openvtc/approvers/current", { connected: false, executorDid: "did:key:z6MkFixture", approver: null }],
  ["GET /v1/openvtc/companion/config", { enabled: false, vapidPublicKey: null }],
  ["GET /v1/openvtc/companions", { companions: [] }],
]);

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const key = `${request.method} ${url.pathname}`;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
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
        },
        updatedAt: new Date().toISOString(),
      };
      responses.set("GET /v1/sandbox-settings", sandboxSettings);
      response.end(JSON.stringify(sandboxSettings));
    });
    return;
  }
  if (key === `POST /v1/workspaces/${workspaceId}/chat/sessions`) {
    response.statusCode = 201;
    response.end(JSON.stringify({ ...chatSession, id: `fixture-session-${Date.now()}`, title: null }));
    return;
  }
  if (key.startsWith(`POST /v1/workspaces/${workspaceId}/chat/sessions/`) && key.endsWith("/messages")) {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const assistant = { role: "assistant", content: "I’m working inside your sandbox and can use only the tools and destinations your organization approved." };
      chatMessages = [...chatMessages, { role: "user", content: input.message }, assistant];
      response.end(JSON.stringify({ message: assistant }));
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
      response.statusCode = 201;
      response.end(JSON.stringify(saved));
    });
    return;
  }
  if (request.method === "POST" && /^\/v1\/admin\/users\/[^/]+\/egress-security-group$/.test(url.pathname)) {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const userId = url.pathname.split("/")[4];
      const input = JSON.parse(body);
      const group = egressSecurityGroups.find((candidate) => candidate.id === input.securityGroupVersionId);
      adminUsers = adminUsers.map((user) => user.userId === userId ? { ...user, effectivePolicy: { egressSecurityGroup: group } } : user);
      response.end(JSON.stringify({ egressSecurityGroup: group }));
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
