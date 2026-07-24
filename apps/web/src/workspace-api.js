const jsonHeaders = { "content-type": "application/json" };

async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? "ONEComputer could not complete the request.");
    error.code = payload?.error?.code ?? "REQUEST_FAILED";
    error.retryable = payload?.error?.retryable ?? false;
    throw error;
  }
  return payload;
}

const mutation = (method = "POST", body) => ({
  method,
  headers: { ...(body === undefined ? {} : jsonHeaders), "idempotency-key": crypto.randomUUID() },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const workspaceApi = {
  current: () => request("/api/v1/workspaces/current"),
  list: () => request("/api/v1/workspaces"),
  create: (grantId = "personal") => request("/api/v1/workspaces", mutation("POST", { grantId })),
  open: (id) => request(`/api/v1/workspaces/${encodeURIComponent(id)}/open`, mutation()),
  restart: (id) => request(`/api/v1/workspaces/${encodeURIComponent(id)}/restart`, mutation()),
  stop: (id) => request(`/api/v1/workspaces/${encodeURIComponent(id)}/stop`, mutation()),
  testGateway: (id) => request(`/api/v1/workspaces/${encodeURIComponent(id)}/gateway/test`, mutation()),
  delete: (id) => request(`/api/v1/workspaces/${encodeURIComponent(id)}`, mutation("DELETE")),
};

export const chatApi = {
  status: (workspaceId) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/status`),
  sessions: (workspaceId) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/sessions`),
  createSession: (workspaceId, title) => request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/sessions`,
    mutation("POST", title ? { title } : {}),
  ),
  messages: (workspaceId, sessionId) => request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
  ),
  send: (workspaceId, sessionId, message) => request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    mutation("POST", { message }),
  ),
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
  microsoft365: () => request("/api/v1/connections/microsoft-365"),
  microsoft365AuthorizeUrl: "/api/v1/connections/microsoft-365/authorize",
  disconnectMicrosoft365: () => request("/api/v1/connections/microsoft-365", mutation("DELETE")),
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
  assignPolicy: (userId) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/policy`, mutation()),
  revokePolicy: (userId) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/policy`, mutation("DELETE")),
  createPolicyVersion: (revisionNote) => request("/api/v1/admin/policy/versions", mutation("POST", { revisionNote })),
  mcpPolicy: () => request("/api/v1/admin/mcp-policy"),
  saveMcpPolicy: (tools) => request("/api/v1/admin/mcp-policy", { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ tools }) }),
  egressSecurityGroups: () => request("/api/v1/admin/egress-security-groups"),
  saveEgressSecurityGroup: (document) => request("/api/v1/admin/egress-security-groups", mutation("POST", document)),
  assignEgressSecurityGroup: (userId, securityGroupVersionId) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/egress-security-group`, mutation("POST", { securityGroupVersionId })),
};
