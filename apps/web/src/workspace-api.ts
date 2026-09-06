import { encryptTelegramBotTokenEnvelope } from "./telegram-token-intake.js";
import type { WorkspaceView } from "@lemmacomputer/contracts";

// Response shapes are annotated only where a Control contract type already
// describes them. Everything else stays `unknown` on purpose: several endpoints
// are still changing, and a guessed type is worse than none because callers
// would trust it. Widen these as each shape settles.
const jsonHeaders = { "content-type": "application/json" };

export interface LemmaComputerRequestError extends Error {
  code: string;
  retryable: boolean;
  status: number;
}

type Filters = Record<string, unknown>;

const searchParams = (filters: Filters, extra: Array<[string, string]> = []) => new URLSearchParams([
  ...Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]): [string, string] => [key, String(value)]),
  ...extra,
]);

// Tool audit also drops null and empty values, so a cleared filter control does
// not send an empty query parameter.
const toolAuditParams = (filters: Filters) => new URLSearchParams(
  Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]): [string, string] => [key, String(value)]),
);

async function request<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, options);
  if (response.status === 204) return null as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      payload?.error?.message ?? payload?.message ?? "LemmaComputer could not complete the request.",
    ) as LemmaComputerRequestError;
    error.code = payload?.error?.code ?? payload?.code ?? "REQUEST_FAILED";
    error.retryable = payload?.error?.retryable ?? false;
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

const mutation = (method = "POST", body?: unknown): RequestInit => ({
  method,
  headers: { ...(body === undefined ? {} : jsonHeaders), "idempotency-key": crypto.randomUUID() },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export async function retryRetryableRequest<T>(
  operation: () => Promise<T>,
  { attempts = 3, baseDelayMs = 250 }: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error as LemmaComputerRequestError)?.retryable || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (2 ** attempt)));
    }
  }
  throw lastError;
}

const retryableMutation = <T = unknown>(path: string, method = "POST", body?: unknown): Promise<T> => {
  // Reuse the same idempotency key for every transport attempt. Create maps
  // that key back to the same workspace record, while restart and stop are
  // state-machine operations that safely resume from failed/cleanup states.
  const options = mutation(method, body);
  return retryRetryableRequest(() => request<T>(path, options));
};

// The Control API authorizes and signs an intake grant, but never receives the
// bot token. The browser encrypts it for the broker and submits only the
// resulting envelope through the Web edge route. Do not wrap this in the
// generic retry helper: a grant is deliberately single-use, so an uncertain
// intake response must start again with a newly-issued grant.
interface TelegramIntakeGrant {
  grantId: string;
  grant: unknown;
  intakeUrl: string;
  encryption: { publicKeySpkiBase64: string };
}

const redeemTelegramTokenIntake = async (grantPath: string, botToken: string) => {
  const grant = await request<TelegramIntakeGrant>(grantPath, mutation("POST", {}));
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
  current: () => request<WorkspaceView>("/api/v1/workspaces/current", { cache: "no-store" }),
  list: () => request<{ workspaces: WorkspaceView[] }>("/api/v1/workspaces", { cache: "no-store" }),
  create: (grantId = "personal") => retryableMutation<WorkspaceView>("/api/v1/workspaces", "POST", { grantId }),
  open: (id: string) => request(`/api/v1/workspaces/${encodeURIComponent(id)}/open`, mutation()),
  restart: (id: string) => retryableMutation<WorkspaceView>(`/api/v1/workspaces/${encodeURIComponent(id)}/restart`),
  stop: (id: string) => retryableMutation<WorkspaceView>(`/api/v1/workspaces/${encodeURIComponent(id)}/stop`),
  testGateway: (id: string) => request(`/api/v1/workspaces/${encodeURIComponent(id)}/gateway/test`, mutation()),
  deletionImpact: (id: string) => request<{
    conversations: number;
    artifacts: number;
    protectedConversations: number;
    protectedArtifacts: number;
  }>(`/api/v1/workspaces/${encodeURIComponent(id)}/deletion-impact`, { cache: "no-store" }),
  delete: (id: string, contentDisposition: "preserve" | "delete" = "preserve") => request(
    `/api/v1/workspaces/${encodeURIComponent(id)}`,
    mutation("DELETE", { contentDisposition }),
  ),
};

export const chatApi = {
  agents: (workspaceId: string) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents`),
  status: (workspaceId: string, catalogId: string) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(catalogId)}/status`),
  sessions: (workspaceId: string, catalogId: string, { cursor, limit = 20 }: { cursor?: string; limit?: number } = {}) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(catalogId)}/sessions?${query}`);
  },
  librarySessions: ({ cursor, limit = 20 }: { cursor?: string; limit?: number } = {}) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request(`/api/v1/chat/sessions?${query}`);
  },
  libraryArtifacts: ({ cursor, limit = 20, query = "" }: { cursor?: string; limit?: number; query?: string } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    if (query) params.set("query", query);
    return request(`/api/v1/chat/artifacts?${params}`);
  },
  createSession: (workspaceId: string, catalogId: string, title?: string, requestedServiceClass = "balanced", reasoningEffort?: string) => request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(catalogId)}/sessions`,
    mutation("POST", {
      ...(title ? { title } : {}),
      requestedServiceClass,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }),
  ),
  messages: (sessionId: string) => request(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    { cache: "no-store" },
  ),
  cancelTurn: (workspaceId: string, catalogId: string, sessionId: string) => request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(catalogId)}/sessions/${encodeURIComponent(sessionId)}/turns/active`,
    mutation("DELETE"),
  ),
  activity: (workspaceId: string, catalogId: string, sessionId: string, turnId: string, after = -1) => request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(catalogId)}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/activity?${new URLSearchParams({ after: String(after), limit: "500" })}`,
    { cache: "no-store" },
  ),
  activityStreamUrl: (workspaceId: string, catalogId: string, sessionId: string, turnId: string, after = -1) => (
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(catalogId)}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/activity/stream?${new URLSearchParams({ after: String(after) })}`
  ),
  fork: (workspaceId: string, sessionId: string, fromMessageId: string, agentCatalogId: string, requestedServiceClass: string, reasoningEffort?: string) => request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/sessions/${encodeURIComponent(sessionId)}/forks`,
    mutation("POST", {
      fromMessageId,
      agentCatalogId,
      requestedServiceClass,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }),
  ),
  artifactUrl: (artifactId: string, revisionId: string) => (
    `/api/v1/chat/artifacts/${encodeURIComponent(artifactId)}/content?${new URLSearchParams({ revision: revisionId })}`
  ),
};

export const skillApi = {
  list: () => request("/api/v1/skills", { cache: "no-store" }),
};

export const siteApi = {
  list: () => request("/api/v1/sites", { cache: "no-store" }),
  details: (id: string) => request(`/api/v1/sites/${encodeURIComponent(id)}`, { cache: "no-store" }),
  viewer: (handle: string) => request(`/api/v1/sites/viewer/${encodeURIComponent(handle)}`, { cache: "no-store" }),
  acceptInvitation: (token: string) => request("/api/v1/sites/invitations/accept", mutation("POST", { token })),
  setVisibility: (id: string, visibility: string) => request(`/api/v1/sites/${encodeURIComponent(id)}`, mutation("PATCH", { visibility })),
  invite: (id: string, email: string) => request(`/api/v1/sites/${encodeURIComponent(id)}/invitations`, mutation("POST", { email })),
  resendInvitation: (id: string, invitationId: string) => request(`/api/v1/sites/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitationId)}/resend`, mutation()),
  revokeInvitation: (id: string, invitationId: string) => request(`/api/v1/sites/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitationId)}`, mutation("DELETE")),
  removeInvitation: (id: string, invitationId: string) => request(`/api/v1/sites/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitationId)}/remove`, mutation()),
  revokeGrant: (id: string, grantId: string) => request(`/api/v1/sites/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}`, mutation("DELETE")),
  restore: (id: string, version: number) => request(`/api/v1/sites/${encodeURIComponent(id)}/versions/${version}/restore`, mutation()),
  delete: (id: string) => request(`/api/v1/sites/${encodeURIComponent(id)}`, mutation("DELETE")),
};

export const scheduleApi = {
  list: () => request("/api/v1/schedules", { cache: "no-store" }),
  create: (input: unknown) => request("/api/v1/schedules", mutation("POST", input)),
  update: (id: string, input: unknown) => request(`/api/v1/schedules/${encodeURIComponent(id)}`, mutation("PATCH", input)),
  delete: (id: string) => request(`/api/v1/schedules/${encodeURIComponent(id)}`, mutation("DELETE")),
  runNow: (id: string) => request(`/api/v1/schedules/${encodeURIComponent(id)}/run`, mutation()),
  runs: (id: string, limit = 20) => request(`/api/v1/schedules/${encodeURIComponent(id)}/runs?${new URLSearchParams({ limit: String(limit) })}`, { cache: "no-store" }),
};

export const sandboxApi = {
  settings: (grantId = "personal") => request(`/api/v1/sandbox-settings?${new URLSearchParams({ grantId })}`),
  save: (configuration: unknown) => request("/api/v1/sandbox-settings", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(configuration),
  }),
};

export const operationApi = {
  recent: () => request("/api/v1/operations/recent"),
  list: () => request("/api/v1/operations"),
  get: (id: string) => request(`/api/v1/operations/${encodeURIComponent(id)}`),
  audit: (id: string) => request(`/api/v1/operations/${encodeURIComponent(id)}/audit`),
  createDeleteFile: (workspaceId: string, path: string) => request("/api/v1/operations/delete-file", mutation("POST", { workspaceId, path })),
  decideWithFixture: (id: string, decision: unknown) => request(`/api/v1/operations/${encodeURIComponent(id)}/fixture-decision`, mutation("POST", { decision })),
};

export const connectionApi = {
  catalog: (options: RequestInit = {}) => request("/api/v1/connections", { cache: "no-store", ...options }),
  status: (connectorId: string, options: RequestInit = {}) => request(`/api/v1/connections/${encodeURIComponent(connectorId)}`, { cache: "no-store", ...options }),
  authorizeUrl: (connectorId: string) => `/api/v1/connections/${encodeURIComponent(connectorId)}/authorize`,
  disconnect: (connectorId: string) => request(`/api/v1/connections/${encodeURIComponent(connectorId)}`, mutation("DELETE")),
  adminConsentLink: (connectorId: string) => request(`/api/v1/connections/${encodeURIComponent(connectorId)}/admin-consent`, { cache: "no-store" }),
  forgetAdminConsent: (connectorId: string) => request(`/api/v1/connections/${encodeURIComponent(connectorId)}/admin-consent`, mutation("DELETE")),
  microsoft365: () => request("/api/v1/connections/microsoft-365"),
  microsoft365AuthorizeUrl: "/api/v1/connections/microsoft-365/authorize",
  disconnectMicrosoft365: () => request("/api/v1/connections/microsoft-365", mutation("DELETE")),
  credentials: () => request("/api/v1/credentials", { cache: "no-store" }),
  createTelegramCredential: (botToken: string) => redeemTelegramTokenIntake("/api/v1/credentials/telegram/intake-grants", botToken),
  rotateTelegramCredential: (credentialId: string, botToken: string) => redeemTelegramTokenIntake(
    `/api/v1/credentials/${encodeURIComponent(credentialId)}/telegram/intake-grants`,
    botToken,
  ),
  deleteCredential: (credentialId: string) => request(`/api/v1/credentials/${encodeURIComponent(credentialId)}`, mutation("DELETE")),
  telegram: (workspaceId: string) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/telegram`, { cache: "no-store" }),
  saveTelegram: (workspaceId: string, configuration: unknown) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/telegram`, mutation("PUT", configuration)),
  disconnectTelegram: (workspaceId: string) => request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/telegram`, mutation("DELETE")),
};

export const approvalApi = {
  status: (approverDid?: string) => request(`/api/v1/openvtc/approvers/current${approverDid ? `?approverDid=${encodeURIComponent(approverDid)}` : ""}`),
  challenge: () => request("/api/v1/openvtc/enrollment-challenges", mutation()),
  enroll: (challengeId: string, document: unknown) => request("/api/v1/openvtc/approvers", mutation("POST", { challengeId, document })),
  revoke: (approverDid?: string) => request(`/api/v1/openvtc/approvers/current${approverDid ? `?approverDid=${encodeURIComponent(approverDid)}` : ""}`, mutation("DELETE")),
  pending: (approverDid?: string) => request(`/api/v1/openvtc/approvals/pending${approverDid ? `?approverDid=${encodeURIComponent(approverDid)}` : ""}`),
  inbox: (transportToken: string) => request("/api/v1/openvtc/inbox", { headers: { authorization: `Bearer ${transportToken}` } }),
  decide: (transportToken: string, document: unknown) => request("/api/trust-tasks", {
    method: "POST",
    headers: { ...jsonHeaders, authorization: `Bearer ${transportToken}` },
    body: JSON.stringify(document),
  }),
  companionConfig: () => request("/api/v1/openvtc/companion/config"),
  companionActivity: (cursor?: string, limit = 20) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request(`/api/v1/openvtc/companion/activity?${query}`);
  },
  companionActivityDetail: (id: string) => request(`/api/v1/openvtc/companion/activity/${encodeURIComponent(id)}`),
  companions: () => request("/api/v1/openvtc/companions"),
  subscribeCompanion: (input: unknown) => request("/api/v1/openvtc/companions/subscription", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }),
  revokeCompanion: (id: string) => request(`/api/v1/openvtc/companions/${encodeURIComponent(id)}`, mutation("DELETE")),
  testCompanion: (id: string) => request(`/api/v1/openvtc/companions/${encodeURIComponent(id)}/test`, mutation()),
};

export const authApi = {
  session: () => request("/api/v1/auth/session"),
  customerCapabilities: () => request("/api/v1/auth/customer-capabilities", { cache: "no-store" }),
  productSession: () => request("/api/v1/auth/product-session", { cache: "no-store" }),
  selectProductMembership: (membershipId: string) => request("/api/v1/auth/product-session", mutation("PUT", { membershipId })),
  createPersonalTenant: (idempotencyKey: string) => request("/api/v1/auth/personal-tenant", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
  }),
  createOrganization: (displayName: string, idempotencyKey: string) => request("/api/v1/auth/organizations", {
    method: "POST",
    headers: { ...jsonHeaders, "idempotency-key": idempotencyKey },
    body: JSON.stringify({ displayName }),
  }),
  prepareInvitation: (token: string) => request("/api/v1/auth/invitations/context", mutation("POST", { token })),
  invitationContext: () => request("/api/v1/auth/invitations/context", { cache: "no-store" }),
  acceptInvitation: () => request("/api/v1/auth/invitations/accept", mutation()),
  completeOwnerStepUp: (code: string) => request("/api/v1/auth/owner-step-up", mutation("POST", { code })),
  clearOrganizationSelection: () => request("/api/v1/auth/product-session", mutation("DELETE")),
  signUpWithEmail: (input: unknown) => request("/api/v1/auth/customer/sign-up/email", mutation("POST", input)),
  signInWithEmail: (email: string, password: string) => request("/api/v1/auth/customer/sign-in/email", mutation("POST", { email, password })),
  signInWithCompanySso: (email: string, returnPath = "/") => request("/api/v1/auth/customer-sso", mutation("POST", { email, returnPath })),
  customerIdentitySession: () => request("/api/v1/auth/customer/get-session", { cache: "no-store" }),
  linkedAccounts: () => request("/api/v1/auth/customer/list-accounts", { cache: "no-store" }),
  linkSocialProvider: (provider: string, callbackURL = "/") => request("/api/v1/auth/customer/link-social", mutation("POST", {
    provider,
    callbackURL: new URL(callbackURL, window.location.origin).toString(),
    errorCallbackURL: new URL(`/?signin=error&reason=SOCIAL_LINK_FAILED&provider=${encodeURIComponent(provider)}`, window.location.origin).toString(),
    disableRedirect: true,
  })),
  unlinkAccount: (providerId: string, accountId: string) => request("/api/v1/auth/customer/unlink-account", mutation("POST", { providerId, accountId })),
  enableTotp: (password: string) => request("/api/v1/auth/customer/two-factor/enable", mutation("POST", { password })),
  disableTotp: (password: string) => request("/api/v1/auth/customer/two-factor/disable", mutation("POST", { password })),
  verifyTotp: (code: string) => request("/api/v1/auth/customer/two-factor/verify-totp", mutation("POST", { code })),
  verifyBackupCode: (code: string) => request("/api/v1/auth/customer/two-factor/verify-backup-code", mutation("POST", { code })),
  revokeOtherSessions: () => request("/api/v1/auth/customer/revoke-other-sessions", mutation()),
  revokeAllSessions: () => request("/api/v1/auth/customer/revoke-sessions", mutation()),
  requestPasswordReset: (email: string, redirectTo?: string) => request("/api/v1/auth/customer/request-password-reset", mutation("POST", { email, redirectTo })),
  sendVerificationEmail: (email: string, callbackURL = "/") => request("/api/v1/auth/customer/send-verification-email", mutation("POST", {
    email,
    callbackURL: new URL(callbackURL, window.location.origin).toString(),
  })),
  takeDevelopmentEmail: (email: string, kind: "email-verification" | "password-recovery") => request("/api/v1/auth/development-email-capture", mutation("POST", {
    email,
    kind,
  })),
  resetPassword: (token: string, newPassword: string) => request("/api/v1/auth/customer/reset-password", mutation("POST", { token, newPassword })),
  signInWithSocialProvider: (provider: string, callbackURL = "/") => {
    const errorPath = callbackURL === "/invite" ? "/invite" : "/";
    return request("/api/v1/auth/customer/sign-in/social", mutation("POST", {
      provider,
      callbackURL: new URL(callbackURL, window.location.origin).toString(),
      errorCallbackURL: new URL(`${errorPath}?signin=error&reason=SOCIAL_SIGNIN_FAILED&provider=${encodeURIComponent(provider)}`, window.location.origin).toString(),
      disableRedirect: true,
    }));
  },
  customerSignOut: () => request("/api/v1/auth/customer/sign-out", mutation()),
  logout: async () => {
    await request("/api/v1/auth/logout", mutation()).catch(() => null);
    await request("/api/v1/auth/customer/sign-out", mutation()).catch(() => null);
  },
};

export const adminApi = {
  users: () => request("/api/v1/admin/users"),
  toolAudit: (filters: Filters = {}) => request(`/api/v1/admin/tool-audit?${toolAuditParams(filters)}`, { cache: "no-store" }),
  memberWorkspaces: () => request("/api/v1/admin/member-workspaces", { cache: "no-store" }),
  commandMemberWorkspace: (userId: string, workspaceId: string, action: string) => retryableMutation(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspaceId)}/runtime/${encodeURIComponent(action)}`,
  ),
  protectedWorkspacePolicy: () => request("/api/v1/admin/protected-workspace-policy", { cache: "no-store" }),
  protectedOrganizationPolicyVersions: () => request("/api/v1/admin/protected-workspace-policy/organization-versions", { cache: "no-store" }),
  createProtectedOrganizationPolicyVersion: (constraints: unknown, revisionNote?: string) => request(
    "/api/v1/admin/protected-workspace-policy/organization-versions",
    mutation("POST", { constraints, revisionNote }),
  ),
  invitations: () => request("/api/v1/admin/invitations", { cache: "no-store" }),
  createInvitation: (input: unknown) => request("/api/v1/admin/invitations", mutation("POST", input)),
  resendInvitation: (invitationId: string) => request(`/api/v1/admin/invitations/${encodeURIComponent(invitationId)}/resend`, mutation()),
  revokeInvitation: (invitationId: string) => request(`/api/v1/admin/invitations/${encodeURIComponent(invitationId)}`, mutation("DELETE")),
  ssoConnections: () => request("/api/v1/admin/sso", { cache: "no-store" }),
  registerSso: (input: unknown) => request("/api/v1/admin/sso", mutation("POST", input)),
  requestSsoDomainProof: (connectionId: string) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/domain-verification/request`, mutation()),
  verifySsoDomain: (connectionId: string) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/domain-verification`, mutation()),
  startSsoTest: (connectionId: string) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/test`, mutation()),
  completeSsoTest: (connectionId: string) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/test/complete`, mutation()),
  confirmSsoRecovery: (connectionId: string) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/recovery`, mutation()),
  enforceSso: (connectionId: string) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/enforce`, mutation()),
  rotateSsoCredentials: (connectionId: string, input: unknown) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/credentials/rotation`, mutation("POST", input)),
  refreshSsoMetadata: (connectionId: string, input: unknown) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/metadata/refresh`, mutation("POST", input)),
  suspendSso: (connectionId: string) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/suspend`, mutation()),
  rollbackSso: (connectionId: string) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}/rollback`, mutation()),
  disconnectSso: (connectionId: string) => request(`/api/v1/admin/sso/${encodeURIComponent(connectionId)}`, mutation("DELETE")),
  changeMembership: (userId: string, input: unknown) => request(`/api/v1/admin/memberships/${encodeURIComponent(userId)}`, mutation("PATCH", input)),
  renameOrganization: (displayName: string) => request("/api/v1/admin/organization", mutation("PATCH", { displayName })),
  transferOwnership: (targetMembershipId: string) => request("/api/v1/admin/organization/ownership-transfer", mutation("POST", { targetMembershipId })),
  initiateOrganizationClosure: (reason: string, idempotencyKey: string) => request("/api/v1/admin/organization/closure", {
    method: "POST",
    headers: { ...jsonHeaders, "idempotency-key": idempotencyKey },
    body: JSON.stringify({ reason }),
  }),
  roles: () => request("/api/v1/admin/roles", { cache: "no-store" }),
  createRole: (input: unknown) => request("/api/v1/admin/roles", mutation("POST", input)),
  updateRole: (roleId: string, input: unknown) => request(`/api/v1/admin/roles/${encodeURIComponent(roleId)}`, mutation("PATCH", input)),
  archiveRole: (roleId: string, expectedVersion: number) => request(`/api/v1/admin/roles/${encodeURIComponent(roleId)}`, mutation("DELETE", { expectedVersion })),
  assignRole: (membershipId: string, roleId: string) => request(`/api/v1/admin/memberships/${encodeURIComponent(membershipId)}/roles`, mutation("POST", { roleId })),
  unassignRole: (membershipId: string, roleId: string) => request(`/api/v1/admin/memberships/${encodeURIComponent(membershipId)}/roles/${encodeURIComponent(roleId)}`, mutation("DELETE")),
  teams: (includeArchived = true) => request(`/api/v1/admin/teams?${new URLSearchParams({ includeArchived: String(includeArchived) })}`, { cache: "no-store" }),
  team: (teamId: string) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}`, { cache: "no-store" }),
  spend: (filters: Filters = {}) => request(`/api/v1/admin/spend?${searchParams(filters)}`, { cache: "no-store" }),
  acknowledgeUnpricedUsage: (input: unknown) => request("/api/v1/admin/spend/cost-coverage/acknowledgements", mutation("POST", input)),
  spendTask: (taskKey: string, filters: Filters = {}) => request(`/api/v1/admin/spend/tasks/${encodeURIComponent(taskKey)}?${searchParams(filters)}`, { cache: "no-store" }),
  spendExportUrl: (filters: Filters = {}, format = "csv") => `/api/v1/admin/spend/export?${searchParams(filters, [["format", format]])}`,
  createTeam: (input: unknown) => request("/api/v1/admin/teams", mutation("POST", input)),
  updateTeam: (teamId: string, input: unknown) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}`, mutation("PATCH", input)),
  archiveTeam: (teamId: string) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/archive`, mutation()),
  assignTeamMembership: (teamId: string, userId: string, makeDefault = false) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/memberships`, mutation("POST", { userId, makeDefault })),
  removeTeamMembership: (teamId: string, userId: string) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/memberships/${encodeURIComponent(userId)}`, mutation("DELETE")),
  setDefaultSpendingTeam: (teamId: string, userId: string) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/default`, mutation("PUT", { userId })),
  teamBudget: (teamId: string) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/budget`, { cache: "no-store" }),
  routingDecision: (decisionId: string) => request(`/api/v1/admin/routing/decisions/${encodeURIComponent(decisionId)}`, { cache: "no-store" }),
  latestRoutingMapping: () => request("/api/v1/admin/routing/mappings/latest", { cache: "no-store" }),
  createRoutingMapping: (input: unknown) => request("/api/v1/admin/routing/mappings", mutation("POST", input)),
  saveModelLimits: (provider: string, input: unknown) => request(`/api/v1/admin/provider-settings/${encodeURIComponent(provider)}/model-limits`, mutation("PUT", input)),
  rateCards: () => request("/api/v1/admin/ai-usage/rate-cards", { cache: "no-store" }),
  createRateCard: (input: unknown) => request("/api/v1/admin/ai-usage/rate-cards", mutation("POST", input)),
  saveTeamBudget: (teamId: string, input: unknown) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/budget`, mutation("PUT", input)),
  overrideTeamBudget: (teamId: string, input: unknown) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/budget/override`, mutation("POST", input)),
  reconcileTeamBudget: (teamId: string) => request(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/budget/reconcile`, mutation()),
  setUserStatus: (userId: string, status: string) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/status`, mutation("PATCH", { status })),
  revokeUserSessions: (userId: string) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/sessions/revoke`, mutation()),
  assignPolicy: (userId: string) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/policy`, mutation()),
  revokePolicy: (userId: string) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/policy`, mutation("DELETE")),
  sandboxSettings: (userId: string, workspaceId: string) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspaceId)}/sandbox-settings`, { cache: "no-store" }),
  saveSandboxSettings: (userId: string, configuration: unknown) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/sandbox-settings`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(configuration),
  }),
  createPolicyVersion: (revisionNote?: string) => request("/api/v1/admin/policy/versions", mutation("POST", { revisionNote })),
  mcpPolicy: () => request("/api/v1/admin/mcp-policy"),
  saveMcpPolicy: (tools: unknown) => request("/api/v1/admin/mcp-policy", { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ tools }) }),
  egressSecurityGroups: () => request("/api/v1/admin/egress-security-groups"),
  saveEgressSecurityGroup: (document: unknown) => request("/api/v1/admin/egress-security-groups", mutation("POST", document)),
  deleteEgressSecurityGroup: (securityGroupId: string) => request(`/api/v1/admin/egress-security-groups/${encodeURIComponent(securityGroupId)}`, mutation("DELETE")),
  assignWorkspaceEgressSecurityGroup: (grantId: string, securityGroupVersionId: string) => request(`/api/v1/admin/workspaces/${encodeURIComponent(grantId)}/egress-security-group`, mutation("POST", { securityGroupVersionId })),
  clearWorkspaceEgressSecurityGroup: (grantId: string) => request(`/api/v1/admin/workspaces/${encodeURIComponent(grantId)}/egress-security-group`, mutation("DELETE")),
  assignUserWorkspaceEgressSecurityGroup: (userId: string, workspaceId: string, securityGroupVersionId: string) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspaceId)}/egress-security-group`, mutation("POST", { securityGroupVersionId })),
  clearUserWorkspaceEgressSecurityGroup: (userId: string, workspaceId: string) => request(`/api/v1/admin/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspaceId)}/egress-security-group`, mutation("DELETE")),
  connectors: () => request("/api/v1/admin/connectors", { cache: "no-store" }),
  discoverConnector: (connector: unknown) => request("/api/v1/admin/connectors/discover", mutation("POST", connector)),
  createConnector: (connector: unknown) => request("/api/v1/admin/connectors", mutation("POST", connector)),
  saveConnectorIcon: (connectorId: string, iconDataUrl: string) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/icon`, mutation("PUT", { iconDataUrl })),
  connectorEffectivePolicy: (connectorId: string) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/effective-policy`, { cache: "no-store" }),
  microsoft365SharePointSites: () => request("/api/v1/admin/connectors/microsoft-365/sharepoint-sites", { cache: "no-store" }),
  addMicrosoft365SharePointSite: (input: { displayName: string; siteUrl: string; accessLevel: "read" | "write" }) => request("/api/v1/admin/connectors/microsoft-365/sharepoint-sites", mutation("POST", input)),
  grantMicrosoft365SharePointSite: (siteId: string, accessLevel?: "read" | "write") => request(`/api/v1/admin/connectors/microsoft-365/sharepoint-sites/${encodeURIComponent(siteId)}/grant`, mutation("POST", accessLevel ? { accessLevel } : undefined)),
  deleteMicrosoft365SharePointSite: (siteId: string) => request(`/api/v1/admin/connectors/microsoft-365/sharepoint-sites/${encodeURIComponent(siteId)}`, mutation("DELETE")),
  retryConnectorPolicyDelivery: (connectorId: string) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/policy-delivery/retry`, mutation("POST")),
  connectorToolPolicy: (connectorId: string) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/tool-policy`, { cache: "no-store" }),
  saveConnectorToolPolicy: (connectorId: string, tools: unknown, expectedDocumentHash?: string, expectedAccessPolicyVersion?: number) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/tool-policy`, mutation("PUT", { tools, expectedDocumentHash, expectedAccessPolicyVersion })),
  saveConnectorAccessPolicy: (connectorId: string, policy: unknown) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/access-policy`, mutation("PUT", policy)),
  saveConnectorCredentials: (connectorId: string, credentials: { clientId: string; clientSecret: string }) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/credentials`, mutation("PUT", credentials)),
  removeConnectorCredentials: (connectorId: string) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/credentials`, mutation("DELETE")),
  deleteConnector: (connectorId: string) => request(`/api/v1/admin/connectors/${encodeURIComponent(connectorId)}`, mutation("DELETE")),
  providerSettings: () => request("/api/v1/admin/provider-settings", { cache: "no-store" }),
  discoverProviderModels: (provider: string, input: unknown = {}) => request(`/api/v1/admin/provider-settings/${encodeURIComponent(provider)}/catalog`, mutation("POST", input)),
  saveProviderSetting: (provider: string, input: unknown) => request(`/api/v1/admin/provider-settings/${encodeURIComponent(provider)}`, mutation("PUT", input)),
  testProviderSetting: (provider: string) => request(`/api/v1/admin/provider-settings/${encodeURIComponent(provider)}/test`, mutation()),
  disableProviderSetting: (provider: string) => request(`/api/v1/admin/provider-settings/${encodeURIComponent(provider)}/disable`, mutation()),
  deleteProviderSetting: (provider: string) => request(`/api/v1/admin/provider-settings/${encodeURIComponent(provider)}`, mutation("DELETE")),
};

export const memberApi = {
  aiUsage: (filters: Filters = {}) => request(`/api/v1/me/ai-usage?${searchParams(filters)}`, { cache: "no-store" }),
};
