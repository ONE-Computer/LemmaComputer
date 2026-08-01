const jsonHeaders = { "content-type": "application/json" };
const idempotencyKey = () => globalThis.crypto?.randomUUID?.()
  ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? "ONEComputer could not complete the request.");
    error.code = payload?.error?.code ?? "REQUEST_FAILED";
    error.retryable = payload?.error?.retryable ?? false;
    error.status = response.status;
    throw error;
  }
  return payload;
}

const mutation = (method = "POST", body) => ({
  method,
  headers: { ...(body === undefined ? {} : jsonHeaders), "idempotency-key": idempotencyKey() },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export async function retryRetryableRequest(operation, { attempts = 3, baseDelayMs = 250 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!error?.retryable || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (2 ** attempt)));
    }
  }
  throw lastError;
}

const retryableMutation = (path, method = "POST", body) => {
  // Reuse the same idempotency key for every transport attempt. Create maps
  // that key back to the same workspace record, while restart and stop are
  // state-machine operations that safely resume from failed/cleanup states.
  const options = mutation(method, body);
  return retryRetryableRequest(() => request(path, options));
};

export const workspaceApi = {
  current: () => request("/api/v1/workspaces/current", { cache: "no-store" }),
  list: () => request("/api/v1/workspaces", { cache: "no-store" }),
  create: (grantId = "personal") => retryableMutation("/api/v1/workspaces", "POST", { grantId }),
  open: (id) => request(`/api/v1/workspaces/${encodeURIComponent(id)}/open`, mutation()),
  restart: (id) => retryableMutation(`/api/v1/workspaces/${encodeURIComponent(id)}/restart`),
  stop: (id) => retryableMutation(`/api/v1/workspaces/${encodeURIComponent(id)}/stop`),
  testGateway: (id) => request(`/api/v1/workspaces/${encodeURIComponent(id)}/gateway/test`, mutation()),
  delete: (id) => request(`/api/v1/workspaces/${encodeURIComponent(id)}`, mutation("DELETE")),
};

export const chatApi = {
  agents: (workspaceId) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents`),
  status: (workspaceId, catalogId) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(catalogId)}/status`),
  sessions: (workspaceId, catalogId, { cursor, limit = 20 } = {}) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(catalogId)}/sessions?${query}`);
  },
  createSession: (workspaceId, catalogId, title) => request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(catalogId)}/sessions`,
    mutation("POST", title ? { title } : {}),
  ),
  messages: (workspaceId, catalogId, sessionId) => request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(catalogId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
    { cache: "no-store" },
  ),
  activity: (workspaceId, catalogId, sessionId, turnId, after = -1) => request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(catalogId)}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/activity?${new URLSearchParams({ after: String(after), limit: "500" })}`,
    { cache: "no-store" },
  ),
  activityStreamUrl: (workspaceId, catalogId, sessionId, turnId, after = -1) => (
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(catalogId)}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/activity/stream?${new URLSearchParams({ after: String(after) })}`
  ),
};

export const skillApi = {
  list: () => request("/api/v1/skills", { cache: "no-store" }),
};

export const siteApi = {
  list: () => request("/api/v1/sites", { cache: "no-store" }),
  contentUrl: (id) => `/api/v1/sites/${encodeURIComponent(id)}/content`,
  delete: (id) => request(`/api/v1/sites/${encodeURIComponent(id)}`, mutation("DELETE")),
};

export const oneVibeApi = {
  createTask: (workspaceId) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/onevibe/tasks`, mutation()),
  events: (workspaceId, taskId) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/onevibe/tasks/${encodeURIComponent(taskId)}/events`, { cache: "no-store" }),
  vcr: (workspaceId, taskId) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/onevibe/tasks/${encodeURIComponent(taskId)}/vcr`, { cache: "no-store" }),
  createPresentation: (workspaceId, taskId, input) => request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/onevibe/tasks/${encodeURIComponent(taskId)}/presentations`,
    mutation("POST", input),
  ),
};

export const scheduleApi = {
  list: () => request("/api/v1/schedules", { cache: "no-store" }),
  create: (input) => request("/api/v1/schedules", mutation("POST", input)),
  update: (id, input) => request(`/api/v1/schedules/${encodeURIComponent(id)}`, mutation("PATCH", input)),
  delete: (id) => request(`/api/v1/schedules/${encodeURIComponent(id)}`, mutation("DELETE")),
  runNow: (id) => request(`/api/v1/schedules/${encodeURIComponent(id)}/run`, mutation()),
  runs: (id, limit = 20) => request(`/api/v1/schedules/${encodeURIComponent(id)}/runs?${new URLSearchParams({ limit: String(limit) })}`, { cache: "no-store" }),
};

export const sandboxApi = {
  settings: (grantId = "personal") => request(`/api/v1/sandbox-settings?${new URLSearchParams({ grantId })}`),
  save: (configuration) => request("/api/v1/sandbox-settings", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(configuration),
  }),
};

export const operationApi = {
  recent: () => request("/api/v1/operations/recent"),
  list: () => request("/api/v1/operations"),
  get: (id) => request(`/api/v1/operations/${encodeURIComponent(id)}`),
  audit: (id) => request(`/api/v1/operations/${encodeURIComponent(id)}/audit`),
  createDeleteFile: (workspaceId, path) => request("/api/v1/operations/delete-file", mutation("POST", { workspaceId, path })),
  decideWithFixture: (id, decision) => request(`/api/v1/operations/${encodeURIComponent(id)}/fixture-decision`, mutation("POST", { decision })),
};

export const connectionApi = {
  catalog: (options = {}) => request("/api/v1/connections", { cache: "no-store", ...options }),
  status: (connectorId, options = {}) => request(`/api/v1/connections/${encodeURIComponent(connectorId)}`, { cache: "no-store", ...options }),
  authorizeUrl: (connectorId) => `/api/v1/connections/${encodeURIComponent(connectorId)}/authorize`,
  disconnect: (connectorId) => request(`/api/v1/connections/${encodeURIComponent(connectorId)}`, mutation("DELETE")),
  microsoft365: () => request("/api/v1/connections/microsoft-365"),
  microsoft365AuthorizeUrl: "/api/v1/connections/microsoft-365/authorize",
  disconnectMicrosoft365: () => request("/api/v1/connections/microsoft-365", mutation("DELETE")),
  credentials: () => request("/api/v1/credentials", { cache: "no-store" }),
  createTelegramCredential: (botToken) => request("/api/v1/credentials/telegram", mutation("POST", { botToken })),
  rotateTelegramCredential: (credentialId, botToken) => request(`/api/v1/credentials/${encodeURIComponent(credentialId)}/telegram`, mutation("PUT", { botToken })),
  deleteCredential: (credentialId) => request(`/api/v1/credentials/${encodeURIComponent(credentialId)}`, mutation("DELETE")),
  telegram: (workspaceId) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/telegram`, { cache: "no-store" }),
  saveTelegram: (workspaceId, configuration) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/telegram`, mutation("PUT", configuration)),
  disconnectTelegram: (workspaceId) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/telegram`, mutation("DELETE")),
};

export const approvalApi = {
  status: (approverDid) => request(`/api/v1/openvtc/approvers/current${approverDid ? `?approverDid=${encodeURIComponent(approverDid)}` : ""}`),
  challenge: () => request("/api/v1/openvtc/enrollment-challenges", mutation()),
  enroll: (challengeId, document) => request("/api/v1/openvtc/approvers", mutation("POST", { challengeId, document })),
  revoke: (approverDid) => request(`/api/v1/openvtc/approvers/current${approverDid ? `?approverDid=${encodeURIComponent(approverDid)}` : ""}`, mutation("DELETE")),
  pending: (approverDid) => request(`/api/v1/openvtc/approvals/pending${approverDid ? `?approverDid=${encodeURIComponent(approverDid)}` : ""}`),
  inbox: (transportToken) => request("/api/v1/openvtc/inbox", { headers: { authorization: `Bearer ${transportToken}` } }),
  decide: (transportToken, document) => request("/api/trust-tasks", {
    method: "POST",
    headers: { ...jsonHeaders, authorization: `Bearer ${transportToken}` },
    body: JSON.stringify(document),
  }),
  companionConfig: () => request("/api/v1/openvtc/companion/config"),
  companionActivity: (cursor, limit = 20) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request(`/api/v1/openvtc/companion/activity?${query}`);
  },
  companionActivityDetail: (id) => request(`/api/v1/openvtc/companion/activity/${encodeURIComponent(id)}`),
  companions: () => request("/api/v1/openvtc/companions"),
  subscribeCompanion: (input) => request("/api/v1/openvtc/companions/subscription", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }),
  revokeCompanion: (id) => request(`/api/v1/openvtc/companions/${encodeURIComponent(id)}`, mutation("DELETE")),
  testCompanion: (id) => request(`/api/v1/openvtc/companions/${encodeURIComponent(id)}/test`, mutation()),
};

export const authApi = {
  session: () => request("/api/v1/auth/session"),
  loginUrl: "/api/v1/auth/login",
  logout: () => request("/api/v1/auth/logout", mutation()),
};

export const adminApi = {
  users: () => request("/api/v1/admin/users"),
  setUserStatus: (userId, status) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/status`, mutation("PATCH", { status })),
  revokeUserSessions: (userId) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/sessions/revoke`, mutation()),
  assignPolicy: (userId) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/policy`, mutation()),
  revokePolicy: (userId) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/policy`, mutation("DELETE")),
  sandboxSettings: (userId, grantId = "personal") => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/sandbox-settings?${new URLSearchParams({ grantId })}`),
  saveSandboxSettings: (userId, configuration) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/sandbox-settings`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(configuration),
  }),
  createPolicyVersion: (revisionNote) => request("/api/v1/admin/policy/versions", mutation("POST", { revisionNote })),
  mcpPolicy: () => request("/api/v1/admin/mcp-policy"),
  saveMcpPolicy: (tools) => request("/api/v1/admin/mcp-policy", { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ tools }) }),
  egressSecurityGroups: () => request("/api/v1/admin/egress-security-groups"),
  saveEgressSecurityGroup: (document) => request("/api/v1/admin/egress-security-groups", mutation("POST", document)),
  assignWorkspaceEgressSecurityGroup: (grantId, securityGroupVersionId) => request(`/api/v1/admin/workspaces/${encodeURIComponent(grantId)}/egress-security-group`, mutation("POST", { securityGroupVersionId })),
  assignUserWorkspaceEgressSecurityGroup: (userId, grantId, securityGroupVersionId) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(grantId)}/egress-security-group`, mutation("POST", { securityGroupVersionId })),
  connectors: () => request("/api/v1/admin/connectors", { cache: "no-store" }),
  discoverConnector: (connector) => request("/api/v1/admin/connectors/discover", mutation("POST", connector)),
  createConnector: (connector) => request("/api/v1/admin/connectors", mutation("POST", connector)),
  saveConnectorIcon: (connectorId, iconDataUrl) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/icon`, mutation("PUT", { iconDataUrl })),
  connectorToolPolicy: (connectorId) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/tool-policy`, { cache: "no-store" }),
  saveConnectorToolPolicy: (connectorId, tools) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/tool-policy`, mutation("PUT", { tools })),
  saveConnectorAccessPolicy: (connectorId, policy) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/access-policy`, mutation("PUT", policy)),
  deleteConnector: (connectorId) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}`, mutation("DELETE")),
  providerSettings: () => request("/api/v1/admin/provider-settings", { cache: "no-store" }),
  saveProviderSetting: (provider, input) => request(`/api/v1/admin/provider-settings/${encodeURIComponent(provider)}`, mutation("PUT", input)),
  testProviderSetting: (provider) => request(`/api/v1/admin/provider-settings/${encodeURIComponent(provider)}/test`, mutation()),
  disableProviderSetting: (provider) => request(`/api/v1/admin/provider-settings/${encodeURIComponent(provider)}/disable`, mutation()),
  deleteProviderSetting: (provider) => request(`/api/v1/admin/provider-settings/${encodeURIComponent(provider)}`, mutation("DELETE")),
};
