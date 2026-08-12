import { encryptTelegramBotTokenEnvelope } from "./telegram-token-intake.js";

const jsonHeaders = { "content-type": "application/json" };

async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? payload?.message ?? "LemmaComputer could not complete the request.");
    error.code = payload?.error?.code ?? payload?.code ?? "REQUEST_FAILED";
    error.retryable = payload?.error?.retryable ?? false;
    error.status = response.status;
    throw error;
  }
  return payload;
}

const mutation = (method = "POST", body) => ({
  method,
  headers: { ...(body === undefined ? {} : jsonHeaders), "idempotency-key": crypto.randomUUID() },
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

// The Control API authorizes and signs an intake grant, but never receives the
// bot token. The browser encrypts it for the broker and submits only the
// resulting envelope through the Web edge route. Do not wrap this in the
// generic retry helper: a grant is deliberately single-use, so an uncertain
// intake response must start again with a newly-issued grant.
const redeemTelegramTokenIntake = async (grantPath, botToken) => {
  const grant = await request(grantPath, mutation("POST", {}));
  const envelope = await encryptTelegramBotTokenEnvelope({
    grantId: grant.grantId,
    encryptionPublicKeySpkiBase64: grant.encryption.publicKeySpkiBase64,
    botToken,
  });
  return request(grant.intakeUrl, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ grant: grant.grant, envelope }),
  });
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
  cancelTurn: (workspaceId, catalogId, sessionId) => request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(catalogId)}/sessions/${encodeURIComponent(sessionId)}/turns/active`,
    mutation("DELETE"),
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
  createTelegramCredential: (botToken) => redeemTelegramTokenIntake("/api/v1/credentials/telegram/intake-grants", botToken),
  rotateTelegramCredential: (credentialId, botToken) => redeemTelegramTokenIntake(
    `/api/v1/credentials/${encodeURIComponent(credentialId)}/telegram/intake-grants`,
    botToken,
  ),
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
  customerCapabilities: () => request("/api/v1/auth/customer-capabilities", { cache: "no-store" }),
  productSession: () => request("/api/v1/auth/product-session", { cache: "no-store" }),
  selectProductMembership: (membershipId) => request("/api/v1/auth/product-session", mutation("PUT", { membershipId })),
  createOrganization: (displayName, idempotencyKey) => request("/api/v1/auth/organizations", {
    method: "POST",
    headers: { ...jsonHeaders, "idempotency-key": idempotencyKey },
    body: JSON.stringify({ displayName }),
  }),
  prepareInvitation: (token) => request("/api/v1/auth/invitations/context", mutation("POST", { token })),
  invitationContext: () => request("/api/v1/auth/invitations/context", { cache: "no-store" }),
  acceptInvitation: () => request("/api/v1/auth/invitations/accept", mutation()),
  completeOwnerStepUp: (code) => request("/api/v1/auth/owner-step-up", mutation("POST", { code })),
  revokeProductSession: () => request("/api/v1/auth/product-session", mutation("DELETE")),
  signUpWithEmail: (input) => request("/api/v1/auth/customer/sign-up/email", mutation("POST", input)),
  signInWithEmail: (email, password) => request("/api/v1/auth/customer/sign-in/email", mutation("POST", { email, password })),
  signInWithCompanySso: (email, returnPath = "/") => request("/api/v1/auth/customer-sso", mutation("POST", { email, returnPath })),
  customerIdentitySession: () => request("/api/v1/auth/customer/get-session", { cache: "no-store" }),
  linkedAccounts: () => request("/api/v1/auth/customer/list-accounts", { cache: "no-store" }),
  linkSocialProvider: (provider, callbackURL = "/") => request("/api/v1/auth/customer/link-social", mutation("POST", {
    provider,
    callbackURL: new URL(callbackURL, window.location.origin).toString(),
    errorCallbackURL: new URL(`/?signin=error&reason=SOCIAL_LINK_FAILED&provider=${encodeURIComponent(provider)}`, window.location.origin).toString(),
    disableRedirect: true,
  })),
  unlinkAccount: (providerId, accountId) => request("/api/v1/auth/customer/unlink-account", mutation("POST", { providerId, accountId })),
  enableTotp: (password) => request("/api/v1/auth/customer/two-factor/enable", mutation("POST", { password })),
  disableTotp: (password) => request("/api/v1/auth/customer/two-factor/disable", mutation("POST", { password })),
  verifyTotp: (code) => request("/api/v1/auth/customer/two-factor/verify-totp", mutation("POST", { code })),
  verifyBackupCode: (code) => request("/api/v1/auth/customer/two-factor/verify-backup-code", mutation("POST", { code })),
  revokeOtherSessions: () => request("/api/v1/auth/customer/revoke-other-sessions", mutation()),
  revokeAllSessions: () => request("/api/v1/auth/customer/revoke-sessions", mutation()),
  requestPasswordReset: (email, redirectTo) => request("/api/v1/auth/customer/request-password-reset", mutation("POST", { email, redirectTo })),
  sendVerificationEmail: (email, callbackURL = "/") => request("/api/v1/auth/customer/send-verification-email", mutation("POST", {
    email,
    callbackURL: new URL(callbackURL, window.location.origin).toString(),
  })),
  resetPassword: (token, newPassword) => request("/api/v1/auth/customer/reset-password", mutation("POST", { token, newPassword })),
  signInWithSocialProvider: (provider, callbackURL = "/") => {
    const errorPath = callbackURL === "/invite" ? "/invite" : "/";
    return request("/api/v1/auth/customer/sign-in/social", mutation("POST", {
      provider,
      callbackURL: new URL(callbackURL, window.location.origin).toString(),
      errorCallbackURL: new URL(`${errorPath}?signin=error&reason=SOCIAL_SIGNIN_FAILED&provider=${encodeURIComponent(provider)}`, window.location.origin).toString(),
      disableRedirect: true,
    }));
  },
  customerSignOut: () => request("/api/v1/auth/customer/sign-out", mutation()),
  loginUrl: "/api/v1/auth/login",
  beginExternalIdInvitation: (invitation, returnPath = "/") => request("/api/v1/auth/external-id/invitation", mutation("POST", { invitation, return: returnPath })),
  logout: async () => {
    await request("/api/v1/auth/logout", mutation()).catch(() => null);
    await request("/api/v1/auth/product-session", mutation("DELETE")).catch(() => null);
    await request("/api/v1/auth/customer/sign-out", mutation()).catch(() => null);
  },
};

export const adminApi = {
  users: () => request("/api/v1/admin/users"),
  memberWorkspaces: () => request("/api/v1/admin/member-workspaces", { cache: "no-store" }),
  commandMemberWorkspace: (userId, workspaceId, action) => retryableMutation(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspaceId)}/runtime/${encodeURIComponent(action)}`,
  ),
  protectedWorkspacePolicy: () => request("/api/v1/admin/protected-workspace-policy", { cache: "no-store" }),
  protectedOrganizationPolicyVersions: () => request("/api/v1/admin/protected-workspace-policy/organization-versions", { cache: "no-store" }),
  createProtectedOrganizationPolicyVersion: (constraints, revisionNote) => request(
    "/api/v1/admin/protected-workspace-policy/organization-versions",
    mutation("POST", { constraints, revisionNote }),
  ),
  protectedMemberPolicyVersions: (userId) => request(`/api/v1/admin/protected-workspace-policy/members/${encodeURIComponent(userId)}/assignment-versions`, { cache: "no-store" }),
  assignProtectedMemberPolicy: (userId, selection) => request(`/api/v1/admin/protected-workspace-policy/members/${encodeURIComponent(userId)}/assignment-versions`, mutation("POST", { selection })),
  revokeProtectedMemberPolicy: (userId) => request(`/api/v1/admin/protected-workspace-policy/members/${encodeURIComponent(userId)}/assignment-versions`, mutation("DELETE")),
  invitations: () => request("/api/v1/admin/invitations", { cache: "no-store" }),
  createInvitation: (input) => request("/api/v1/admin/invitations", mutation("POST", input)),
  resendInvitation: (invitationId) => request(`/api/v1/admin/invitations/${encodeURIComponent(invitationId)}/resend`, mutation()),
  revokeInvitation: (invitationId) => request(`/api/v1/admin/invitations/${encodeURIComponent(invitationId)}`, mutation("DELETE")),
  ssoConnections: () => request("/api/v1/admin/sso", { cache: "no-store" }),
  registerSso: (input) => request("/api/v1/admin/sso", mutation("POST", input)),
  requestSsoDomainProof: (connectionId) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/domain-verification/request`, mutation()),
  verifySsoDomain: (connectionId) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/domain-verification`, mutation()),
  startSsoTest: (connectionId) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/test`, mutation()),
  completeSsoTest: (connectionId) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/test/complete`, mutation()),
  confirmSsoRecovery: (connectionId) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/recovery`, mutation()),
  enforceSso: (connectionId) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/enforce`, mutation()),
  rotateSsoCredentials: (connectionId, input) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/credentials/rotation`, mutation("POST", input)),
  refreshSsoMetadata: (connectionId, input) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/metadata/refresh`, mutation("POST", input)),
  suspendSso: (connectionId) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/suspend`, mutation()),
  rollbackSso: (connectionId) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/rollback`, mutation()),
  disconnectSso: (connectionId) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}`, mutation("DELETE")),
  changeMembership: (userId, input) => request(`/api/v1/admin/memberships/${encodeURIComponent(userId)}`, mutation("PATCH", input)),
  transferOwnership: (targetMembershipId) => request("/api/v1/admin/organization/ownership-transfer", mutation("POST", { targetMembershipId })),
  initiateOrganizationClosure: (reason, idempotencyKey) => request("/api/v1/admin/organization/closure", {
    method: "POST",
    headers: { ...jsonHeaders, "idempotency-key": idempotencyKey },
    body: JSON.stringify({ reason }),
  }),
  roles: () => request("/api/v1/admin/roles", { cache: "no-store" }),
  createRole: (input) => request("/api/v1/admin/roles", mutation("POST", input)),
  updateRole: (roleId, input) => request(`/api/v1/admin/roles/${encodeURIComponent(roleId)}`, mutation("PATCH", input)),
  archiveRole: (roleId, expectedVersion) => request(`/api/v1/admin/roles/${encodeURIComponent(roleId)}`, mutation("DELETE", { expectedVersion })),
  assignRole: (membershipId, roleId) => request(`/api/v1/admin/memberships/${encodeURIComponent(membershipId)}/roles`, mutation("POST", { roleId })),
  unassignRole: (membershipId, roleId) => request(`/api/v1/admin/memberships/${encodeURIComponent(membershipId)}/roles/${encodeURIComponent(roleId)}`, mutation("DELETE")),
  teams: (includeArchived = true) => request(`/api/v1/admin/teams?${new URLSearchParams({ includeArchived: String(includeArchived) })}`, { cache: "no-store" }),
  team: (teamId) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}`, { cache: "no-store" }),
  spend: (filters = {}) => request(`/api/v1/admin/spend?${new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`, { cache: "no-store" }),
  acknowledgeUnpricedUsage: (input) => request("/api/v1/admin/spend/cost-coverage/acknowledgements", mutation("POST", input)),
  spendTask: (taskKey, filters = {}) => request(`/api/v1/admin/spend/tasks/${encodeURIComponent(taskKey)}?${new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`, { cache: "no-store" }),
  spendExportUrl: (filters = {}, format = "csv") => `/api/v1/admin/spend/export?${new URLSearchParams([...Object.entries(filters).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]), ["format", format]])}`,
  createTeam: (input) => request("/api/v1/admin/teams", mutation("POST", input)),
  updateTeam: (teamId, input) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}`, mutation("PATCH", input)),
  archiveTeam: (teamId) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/archive`, mutation()),
  assignTeamMembership: (teamId, userId, makeDefault = false) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/memberships`, mutation("POST", { userId, makeDefault })),
  removeTeamMembership: (teamId, userId) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/memberships/${encodeURIComponent(userId)}`, mutation("DELETE")),
  setDefaultSpendingTeam: (teamId, userId) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/default`, mutation("PUT", { userId })),
  teamBudget: (teamId) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/budget`, { cache: "no-store" }),
  routingSettings: (teamId) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/routing`, { cache: "no-store" }),
  routingShadowReport: (teamId) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/routing/shadow-report`, { cache: "no-store" }),
  routingDecision: (decisionId) => request(`/api/v1/admin/routing/decisions/${encodeURIComponent(decisionId)}`, { cache: "no-store" }),
  latestRoutingMapping: () => request("/api/v1/admin/routing/mappings/latest", { cache: "no-store" }),
  createRoutingMapping: (input) => request("/api/v1/admin/routing/mappings", mutation("POST", input)),
  rateCards: () => request("/api/v1/admin/ai-usage/rate-cards", { cache: "no-store" }),
  createRateCard: (input) => request("/api/v1/admin/ai-usage/rate-cards", mutation("POST", input)),
  saveRoutingPolicy: (teamId, input) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/routing/policy`, mutation("PUT", input)),
  saveRoutingReview: (teamId, input) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/routing/reviews`, mutation("POST", input)),
  changeRoutingRollout: (teamId, input) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/routing/rollout`, mutation("POST", input)),
  routingKillSwitch: (teamId, input) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/routing/kill-switch`, mutation("POST", input)),
  saveTeamBudget: (teamId, input) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/budget`, mutation("PUT", input)),
  overrideTeamBudget: (teamId, input) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/budget/override`, mutation("POST", input)),
  reconcileTeamBudget: (teamId) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/budget/reconcile`, mutation()),
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
  saveConnectorToolPolicy: (connectorId, tools, expectedDocumentHash) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/tool-policy`, mutation("PUT", { tools, expectedDocumentHash })),
  saveConnectorAccessPolicy: (connectorId, policy) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/access-policy`, mutation("PUT", policy)),
  deleteConnector: (connectorId) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}`, mutation("DELETE")),
  providerSettings: () => request("/api/v1/admin/provider-settings", { cache: "no-store" }),
  saveProviderSetting: (provider, input) => request(`/api/v1/admin/provider-settings/${encodeURIComponent(provider)}`, mutation("PUT", input)),
  testProviderSetting: (provider) => request(`/api/v1/admin/provider-settings/${encodeURIComponent(provider)}/test`, mutation()),
  disableProviderSetting: (provider) => request(`/api/v1/admin/provider-settings/${encodeURIComponent(provider)}/disable`, mutation()),
  deleteProviderSetting: (provider) => request(`/api/v1/admin/provider-settings/${encodeURIComponent(provider)}`, mutation("DELETE")),
};
