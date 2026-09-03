import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { McpToolPolicyDecision } from "@lemmacomputer/contracts";

export type ConnectorCategory = "Productivity" | "Search" | "Developer tools" | "Business" | "Communication" | "Data and analytics" | "Other";

/**
 * Safe per-person connection metadata. OAuth credentials remain in LiteLLM.
 */
export type ConnectorConnectionState = "connected" | "expired";

export type ConnectorConnectionStateRecord = {
  tenantId: string;
  subjectId: string;
  connectorId: string;
  state: ConnectorConnectionState;
  connectedAt: Date | null;
  expiresAt: Date | null;
  updatedAt: Date;
};

export type SaveConnectorConnectionStateRecord = Omit<ConnectorConnectionStateRecord, "updatedAt">;

export type Microsoft365SharePointSiteStatus = "pending" | "verified" | "verification_failed";
export type Microsoft365SharePointMicrosoftAccessStatus = "pending" | "granted" | "grant_failed" | "revocation_failed";
export type Microsoft365SharePointSiteAccessLevel = "read" | "write";

export type Microsoft365SharePointSiteRecord = {
  tenantId: string;
  id: string;
  connectorId: "microsoft-365";
  displayName: string;
  siteUrl: string;
  hostname: string;
  sitePath: string;
  accessLevel: Microsoft365SharePointSiteAccessLevel;
  graphSiteId: string | null;
  driveIds: string[];
  status: Microsoft365SharePointSiteStatus;
  microsoftAccessStatus: Microsoft365SharePointMicrosoftAccessStatus;
  microsoftPermissionId: string | null;
  microsoftGrantedAt: Date | null;
  microsoftLastError: string | null;
  lastVerifiedAt: Date | null;
  lastVerificationError: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateMicrosoft365SharePointSiteInput = Pick<
  Microsoft365SharePointSiteRecord,
  "tenantId" | "displayName" | "siteUrl" | "hostname" | "sitePath" | "accessLevel" | "createdBy"
>;

export type ConnectorRegistryRecord = {
  tenantId: string;
  id: string;
  serverId: string;
  serverName: string;
  name: string;
  shortDescription: string;
  description: string;
  category: ConnectorCategory;
  services: string[];
  endpointUrl: string;
  authorizationOrigins: string[];
  scopes: string[];
  toolPolicies: Record<string, McpToolPolicyDecision>;
  /**
   * SHA-256 digests of the reviewed provider tool definitions, keyed by tool
   * name. An absent digest deliberately means the policy has not been
   * reviewed for the currently discovered definition.
   */
  toolDefinitionHashes: Record<string, string>;
  enabled: boolean;
  membersCanManage: boolean;
  accessPolicyVersion: number;
  accessPolicyUpdatedBy: string | null;
  accessPolicyUpdatedAt: Date;
  brand: string;
  iconDataUrl: string | null;
  policySupport: "governed" | "automatic";
  source: "built-in" | "custom";
  /**
   * Which provider OAuth application this tenant's connector uses.
   * `deployment` is the shared gateway row and the deployment-wide client;
   * `tenant` is a LiteLLM row created for this tenant and carrying its own.
   */
  credentialMode: ConnectorCredentialMode;
  /**
   * The tenant-supplied OAuth client id, kept only so the screen can show
   * which application is configured. The matching secret is never stored here;
   * it goes straight to the gateway, which encrypts it at rest.
   */
  oauthClientId: string | null;
  credentialsUpdatedBy: string | null;
  credentialsUpdatedAt: Date | null;
  /**
   * When a directory administrator granted this organization's tenant-wide
   * consent for the connector, and which provider directory granted it. Null
   * means no grant has been recorded here; it does not prove that none exists,
   * because a deployment may have been consented out of band.
   */
  adminConsentGrantedAt: Date | null;
  adminConsentProviderTenantId: string | null;
  adminConsentRequestedBy: string | null;
  /**
   * Tenant-wide application consent for the separate SharePoint site-access
   * administration app. This is intentionally distinct from the everyday
   * connector's delegated consent so each trust boundary can be audited and
   * withdrawn independently.
   */
  sharePointAdminConsentGrantedAt: Date | null;
  sharePointAdminConsentProviderTenantId: string | null;
  sharePointAdminConsentRequestedBy: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ConnectorCredentialMode = "deployment" | "tenant";

export type RecordConnectorAdminConsentInput = {
  providerTenantId: string;
  requestedBy: string | null;
  grantedAt?: Date;
};

export type SaveConnectorCredentialsInput = {
  serverId: string;
  serverName: string;
  oauthClientId: string;
  updatedBy: string;
};

export type SaveConnectorRegistryRecord = Omit<
  ConnectorRegistryRecord,
  "createdAt" | "updatedAt" | "toolPolicies" | "toolDefinitionHashes" | "iconDataUrl" | "enabled" | "membersCanManage" | "accessPolicyVersion" | "accessPolicyUpdatedBy" | "accessPolicyUpdatedAt" | "credentialMode" | "oauthClientId" | "credentialsUpdatedBy" | "credentialsUpdatedAt" | "adminConsentGrantedAt" | "adminConsentProviderTenantId" | "adminConsentRequestedBy" | "sharePointAdminConsentGrantedAt" | "sharePointAdminConsentProviderTenantId" | "sharePointAdminConsentRequestedBy"
> & {
  toolPolicies?: Record<string, McpToolPolicyDecision>;
  toolDefinitionHashes?: Record<string, string>;
  iconDataUrl?: string | null;
  enabled?: boolean;
  membersCanManage?: boolean;
};

export type ConnectorToolPolicyReview = {
  toolPolicies: Record<string, McpToolPolicyDecision>;
  toolDefinitionHashes: Record<string, string>;
};

export type ConnectorPolicyChangeKind = "access_policy" | "tool_policy";
export type ConnectorPolicyChangeOutcome = "applied" | "conflict";
export type ConnectorPolicyWorkspaceDeliveryOutcome = "refreshed" | "failed" | "applies_on_next_start";

export type ConnectorPolicyChangeEvent = {
  id: string;
  tenantId: string;
  connectorId: string;
  actorUserId: string;
  changeKind: ConnectorPolicyChangeKind;
  outcome: ConnectorPolicyChangeOutcome;
  oldVersion: number;
  newVersion: number;
  oldPolicyHash: string;
  newPolicyHash: string;
  reviewedDefinitionHash: string | null;
  failureCode: string | null;
  correlationId: string;
  occurredAt: Date;
};

export type ConnectorPolicyWorkspaceDeliveryReceipt = {
  id: string;
  tenantId: string;
  changeEventId: string;
  workspaceId: string;
  ownerSubjectId: string;
  grantId: string;
  workspaceState: "not_created" | "provisioning" | "ready" | "open" | "restarting" | "stopping" | "stopped" | "failed";
  outcome: ConnectorPolicyWorkspaceDeliveryOutcome;
  failureCode: string | null;
  occurredAt: Date;
};

export type ConnectorPolicyMutationResult = {
  connector: ConnectorRegistryRecord;
  event: ConnectorPolicyChangeEvent;
};

export type ConnectorPolicyDeliverySnapshot = {
  event: ConnectorPolicyChangeEvent;
  receipts: ConnectorPolicyWorkspaceDeliveryReceipt[];
};

export type ConnectorDiscoveryEgressPermit = {
  id: string;
  tenantId: string;
  createdBy: string;
  origins: string[];
  expiresAt: Date;
  createdAt: Date;
};

export type CreateConnectorDiscoveryEgressPermitInput = {
  tenantId: string;
  createdBy: string;
  origins: string[];
  expiresAt: Date;
};

/**
 * Stores the small, time-bound exception required while an administrator is
 * verifying a custom connector. Customer-managed deployments may use the
 * active-origin lookup below; hosted deployments use an IT-owned allowlist
 * instead because one shared proxy cannot safely treat a tenant-local entry as
 * a new global destination.
 */
export interface ConnectorEgressPermitStore {
  createDiscoveryEgressPermit(input: CreateConnectorDiscoveryEgressPermitInput): Promise<ConnectorDiscoveryEgressPermit>;
  deleteDiscoveryEgressPermit(tenantId: string, permitId: string): Promise<boolean>;
  listEnabledEgressOrigins(now?: Date): Promise<string[]>;
}

export interface ConnectorRegistryStore extends ConnectorEgressPermitStore {
  seedConnectors(tenantId: string, connectors: SaveConnectorRegistryRecord[]): Promise<void>;
  listConnectors(tenantId: string): Promise<ConnectorRegistryRecord[]>;
  getConnector(tenantId: string, connectorId: string): Promise<ConnectorRegistryRecord | null>;
  listConnectionStates(tenantId: string, subjectId: string): Promise<ConnectorConnectionStateRecord[]>;
  getConnectionState(tenantId: string, subjectId: string, connectorId: string): Promise<ConnectorConnectionStateRecord | null>;
  saveConnectionState(record: SaveConnectorConnectionStateRecord): Promise<ConnectorConnectionStateRecord>;
  deleteConnectionState(tenantId: string, subjectId: string, connectorId: string): Promise<boolean>;
  /**
   * Drops every person's stored connection for one connector in one tenant.
   * Used when the OAuth application behind the connector changes, which makes
   * previously issued authorizations unusable.
   */
  deleteConnectorConnectionStates(tenantId: string, connectorId: string): Promise<number>;
  listMicrosoft365SharePointSites(tenantId: string): Promise<Microsoft365SharePointSiteRecord[]>;
  getMicrosoft365SharePointSite(tenantId: string, siteId: string): Promise<Microsoft365SharePointSiteRecord | null>;
  createMicrosoft365SharePointSite(input: CreateMicrosoft365SharePointSiteInput): Promise<Microsoft365SharePointSiteRecord>;
  recordMicrosoft365SharePointSiteVerification(tenantId: string, siteId: string, input: {
    graphSiteId: string;
    driveIds: string[];
    verifiedAt?: Date;
  }): Promise<Microsoft365SharePointSiteRecord | null>;
  recordMicrosoft365SharePointSiteVerificationFailure(tenantId: string, siteId: string, error: string): Promise<Microsoft365SharePointSiteRecord | null>;
  recordMicrosoft365SharePointSiteGrant(tenantId: string, siteId: string, input: {
    graphSiteId: string;
    driveIds: string[];
    accessLevel: Microsoft365SharePointSiteAccessLevel;
    microsoftPermissionId: string;
    grantedAt?: Date;
  }): Promise<Microsoft365SharePointSiteRecord | null>;
  recordMicrosoft365SharePointSiteGrantFailure(tenantId: string, siteId: string, error: string): Promise<Microsoft365SharePointSiteRecord | null>;
  recordMicrosoft365SharePointSiteRevocationFailure(tenantId: string, siteId: string, error: string): Promise<Microsoft365SharePointSiteRecord | null>;
  deleteMicrosoft365SharePointSite(tenantId: string, siteId: string): Promise<Microsoft365SharePointSiteRecord | null>;
  saveConnector(record: SaveConnectorRegistryRecord): Promise<ConnectorRegistryRecord>;
  updateAccessPolicy(tenantId: string, connectorId: string, input: { enabled: boolean; membersCanManage: boolean; updatedBy: string }): Promise<ConnectorRegistryRecord | null>;
  updateToolPolicies(tenantId: string, connectorId: string, review: ConnectorToolPolicyReview): Promise<ConnectorRegistryRecord | null>;
  applyAccessPolicyChange(tenantId: string, connectorId: string, input: {
    enabled: boolean;
    membersCanManage: boolean;
    updatedBy: string;
    expectedVersion: number;
    correlationId: string;
  }): Promise<ConnectorPolicyMutationResult | null>;
  applyToolPolicyChange(tenantId: string, connectorId: string, input: ConnectorToolPolicyReview & {
    updatedBy: string;
    expectedVersion: number;
    reviewedDefinitionHash: string;
    correlationId: string;
  }): Promise<ConnectorPolicyMutationResult | null>;
  recordToolPolicyConflict(tenantId: string, connectorId: string, input: {
    actorUserId: string;
    reviewedDefinitionHash: string;
    failureCode: string;
    correlationId: string;
  }): Promise<ConnectorPolicyChangeEvent | null>;
  appendPolicyWorkspaceDeliveryReceipts(receipts: Omit<ConnectorPolicyWorkspaceDeliveryReceipt, "id" | "occurredAt">[]): Promise<ConnectorPolicyWorkspaceDeliveryReceipt[]>;
  latestPolicyDelivery(tenantId: string, connectorId: string): Promise<ConnectorPolicyDeliverySnapshot | null>;
  saveConnectorCredentials(tenantId: string, connectorId: string, input: SaveConnectorCredentialsInput): Promise<ConnectorRegistryRecord | null>;
  recordConnectorAdminConsent(tenantId: string, connectorId: string, input: RecordConnectorAdminConsentInput): Promise<ConnectorRegistryRecord | null>;
  clearConnectorAdminConsent(tenantId: string, connectorId: string): Promise<ConnectorRegistryRecord | null>;
  recordSharePointAdminConsent(tenantId: string, connectorId: string, input: RecordConnectorAdminConsentInput): Promise<ConnectorRegistryRecord | null>;
  clearSharePointAdminConsent(tenantId: string, connectorId: string): Promise<ConnectorRegistryRecord | null>;
  clearConnectorCredentials(tenantId: string, connectorId: string, input: { serverId: string; serverName: string }): Promise<ConnectorRegistryRecord | null>;
  updateIcon(tenantId: string, connectorId: string, iconDataUrl: string | null): Promise<ConnectorRegistryRecord | null>;
  deleteConnector(tenantId: string, connectorId: string): Promise<ConnectorRegistryRecord | null>;
}

const validToolPolicy = (value: unknown): value is McpToolPolicyDecision => (
  value === "allow" || value === "approval_required" || value === "deny"
);

const asToolPolicies = (value: unknown): Record<string, McpToolPolicyDecision> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, decision]) => validToolPolicy(decision)));
};

const canonicalObject = (value: Record<string, unknown>) => Object.fromEntries(
  Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
);

export const connectorPolicyDocumentHash = (record: Pick<ConnectorRegistryRecord, "enabled" | "membersCanManage" | "toolPolicies" | "toolDefinitionHashes">) => (
  createHash("sha256").update(JSON.stringify({
    enabled: record.enabled,
    membersCanManage: record.membersCanManage,
    toolPolicies: canonicalObject(record.toolPolicies),
    toolDefinitionHashes: canonicalObject(record.toolDefinitionHashes),
  })).digest("hex")
);

const isDefinitionHash = (value: unknown): value is string => (
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
);

const asToolDefinitionHashes = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, hash]) => isDefinitionHash(hash)));
};

const sameKeys = (left: Record<string, unknown>, right: Record<string, unknown>) => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
};

const reviewedToolPolicies = (review: ConnectorToolPolicyReview): ConnectorToolPolicyReview => {
  const toolPolicies = asToolPolicies(review.toolPolicies);
  const toolDefinitionHashes = asToolDefinitionHashes(review.toolDefinitionHashes);
  if (!sameKeys(toolPolicies, review.toolPolicies ?? {}) || !sameKeys(toolDefinitionHashes, review.toolDefinitionHashes ?? {})) {
    throw new Error("Tool policies and definition hashes must contain only valid decisions and SHA-256 digests");
  }
  if (!sameKeys(toolPolicies, toolDefinitionHashes)) {
    throw new Error("Every reviewed tool policy must have the matching tool definition hash");
  }
  return { toolPolicies, toolDefinitionHashes };
};

const normalizeEgressOrigin = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
};

const normalizeDiscoveryPermitOrigins = (origins: string[]) => {
  if (!Array.isArray(origins)) throw new Error("Discovery egress permit origins must be an array");
  const candidates = origins.map((origin) => typeof origin === "string" ? normalizeEgressOrigin(origin) : null);
  if (!candidates.length || candidates.some((origin) => !origin)) {
    throw new Error("Discovery egress permits require one or more HTTPS origins");
  }
  return [...new Set(candidates.filter((origin): origin is string => Boolean(origin)))].sort();
};

const createDiscoveryPermit = (input: CreateConnectorDiscoveryEgressPermitInput, createdAt = new Date()): ConnectorDiscoveryEgressPermit => {
  if (!input.tenantId) throw new Error("Discovery egress permit tenant is required");
  if (!input.createdBy) throw new Error("Discovery egress permit creator is required");
  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= createdAt || expiresAt.getTime() - createdAt.getTime() > 10 * 60 * 1_000) {
    throw new Error("Discovery egress permit expiry must be within ten minutes");
  }
  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    createdBy: input.createdBy,
    origins: normalizeDiscoveryPermitOrigins(input.origins),
    expiresAt,
    createdAt,
  };
};

const cloneConnectorRecord = (record: ConnectorRegistryRecord): ConnectorRegistryRecord => ({
  ...record,
  services: [...record.services],
  authorizationOrigins: [...record.authorizationOrigins],
  scopes: [...record.scopes],
  toolPolicies: { ...record.toolPolicies },
  toolDefinitionHashes: { ...record.toolDefinitionHashes },
  accessPolicyUpdatedAt: new Date(record.accessPolicyUpdatedAt),
  credentialsUpdatedAt: record.credentialsUpdatedAt ? new Date(record.credentialsUpdatedAt) : null,
  adminConsentGrantedAt: record.adminConsentGrantedAt ? new Date(record.adminConsentGrantedAt) : null,
  sharePointAdminConsentGrantedAt: record.sharePointAdminConsentGrantedAt ? new Date(record.sharePointAdminConsentGrantedAt) : null,
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
});

const cloneDiscoveryPermit = (permit: ConnectorDiscoveryEgressPermit): ConnectorDiscoveryEgressPermit => ({
  ...permit,
  origins: [...permit.origins],
  expiresAt: new Date(permit.expiresAt),
  createdAt: new Date(permit.createdAt),
});

const cloneMicrosoft365SharePointSite = (site: Microsoft365SharePointSiteRecord): Microsoft365SharePointSiteRecord => ({
  ...site,
  driveIds: [...site.driveIds],
  microsoftGrantedAt: site.microsoftGrantedAt ? new Date(site.microsoftGrantedAt) : null,
  lastVerifiedAt: site.lastVerifiedAt ? new Date(site.lastVerifiedAt) : null,
  createdAt: new Date(site.createdAt),
  updatedAt: new Date(site.updatedAt),
});

const mapRow = (row: Record<string, unknown>): ConnectorRegistryRecord => ({
  tenantId: String(row.tenant_id),
  id: String(row.id),
  serverId: String(row.server_id),
  serverName: String(row.server_name),
  name: String(row.name),
  shortDescription: String(row.short_description),
  description: String(row.description),
  category: row.category as ConnectorCategory,
  services: Array.isArray(row.services) ? row.services.map(String) : [],
  endpointUrl: String(row.endpoint_url),
  authorizationOrigins: Array.isArray(row.authorization_origins) ? row.authorization_origins.map(String) : [],
  scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
  toolPolicies: asToolPolicies(row.tool_policies),
  toolDefinitionHashes: asToolDefinitionHashes(row.tool_definition_hashes),
  enabled: row.enabled !== false,
  membersCanManage: row.members_can_manage !== false,
  accessPolicyVersion: Number(row.access_policy_version ?? 1),
  accessPolicyUpdatedBy: typeof row.access_policy_updated_by === "string" ? row.access_policy_updated_by : null,
  accessPolicyUpdatedAt: new Date(String(row.access_policy_updated_at ?? row.updated_at)),
  brand: String(row.brand),
  iconDataUrl: typeof row.icon_data_url === "string" ? row.icon_data_url : null,
  policySupport: row.policy_support as ConnectorRegistryRecord["policySupport"],
  source: row.source as ConnectorRegistryRecord["source"],
  credentialMode: row.credential_mode === "tenant" ? "tenant" : "deployment",
  oauthClientId: typeof row.oauth_client_id === "string" ? row.oauth_client_id : null,
  credentialsUpdatedBy: typeof row.credentials_updated_by === "string" ? row.credentials_updated_by : null,
  credentialsUpdatedAt: row.credentials_updated_at ? new Date(String(row.credentials_updated_at)) : null,
  adminConsentGrantedAt: row.admin_consent_granted_at ? new Date(String(row.admin_consent_granted_at)) : null,
  adminConsentProviderTenantId: typeof row.admin_consent_provider_tenant_id === "string" ? row.admin_consent_provider_tenant_id : null,
  adminConsentRequestedBy: typeof row.admin_consent_requested_by === "string" ? row.admin_consent_requested_by : null,
  sharePointAdminConsentGrantedAt: row.sharepoint_admin_consent_granted_at ? new Date(String(row.sharepoint_admin_consent_granted_at)) : null,
  sharePointAdminConsentProviderTenantId: typeof row.sharepoint_admin_consent_provider_tenant_id === "string" ? row.sharepoint_admin_consent_provider_tenant_id : null,
  sharePointAdminConsentRequestedBy: typeof row.sharepoint_admin_consent_requested_by === "string" ? row.sharepoint_admin_consent_requested_by : null,
  createdBy: String(row.created_by),
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
});

const mapConnectionStateRow = (row: Record<string, unknown>): ConnectorConnectionStateRecord => ({
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  connectorId: String(row.connector_id),
  state: row.state as ConnectorConnectionState,
  connectedAt: row.connected_at ? new Date(String(row.connected_at)) : null,
  expiresAt: row.expires_at ? new Date(String(row.expires_at)) : null,
  updatedAt: new Date(String(row.updated_at)),
});

const mapMicrosoft365SharePointSiteRow = (row: Record<string, unknown>): Microsoft365SharePointSiteRecord => ({
  tenantId: String(row.tenant_id),
  id: String(row.id),
  connectorId: "microsoft-365",
  displayName: String(row.display_name),
  siteUrl: String(row.site_url),
  hostname: String(row.hostname),
  sitePath: String(row.site_path),
  accessLevel: row.access_level === "write" ? "write" : "read",
  graphSiteId: typeof row.graph_site_id === "string" ? row.graph_site_id : null,
  driveIds: Array.isArray(row.drive_ids) ? row.drive_ids.map(String) : [],
  status: row.status as Microsoft365SharePointSiteStatus,
  microsoftAccessStatus: row.microsoft_access_status as Microsoft365SharePointMicrosoftAccessStatus,
  microsoftPermissionId: typeof row.microsoft_permission_id === "string" ? row.microsoft_permission_id : null,
  microsoftGrantedAt: row.microsoft_granted_at ? new Date(String(row.microsoft_granted_at)) : null,
  microsoftLastError: typeof row.microsoft_last_error === "string" ? row.microsoft_last_error : null,
  lastVerifiedAt: row.last_verified_at ? new Date(String(row.last_verified_at)) : null,
  lastVerificationError: typeof row.last_verification_error === "string" ? row.last_verification_error : null,
  createdBy: String(row.created_by),
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
});

const mapPolicyChangeRow = (row: Record<string, unknown>): ConnectorPolicyChangeEvent => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  connectorId: String(row.connector_id),
  actorUserId: String(row.actor_user_id),
  changeKind: row.change_kind as ConnectorPolicyChangeKind,
  outcome: row.outcome as ConnectorPolicyChangeOutcome,
  oldVersion: Number(row.old_version),
  newVersion: Number(row.new_version),
  oldPolicyHash: String(row.old_policy_hash),
  newPolicyHash: String(row.new_policy_hash),
  reviewedDefinitionHash: typeof row.reviewed_definition_hash === "string" ? row.reviewed_definition_hash : null,
  failureCode: typeof row.failure_code === "string" ? row.failure_code : null,
  correlationId: String(row.correlation_id),
  occurredAt: new Date(String(row.occurred_at)),
});

const mapPolicyWorkspaceDeliveryRow = (row: Record<string, unknown>): ConnectorPolicyWorkspaceDeliveryReceipt => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  changeEventId: String(row.change_event_id),
  workspaceId: String(row.workspace_id),
  ownerSubjectId: String(row.owner_subject_id),
  grantId: String(row.grant_id),
  workspaceState: row.workspace_state as ConnectorPolicyWorkspaceDeliveryReceipt["workspaceState"],
  outcome: row.outcome as ConnectorPolicyWorkspaceDeliveryOutcome,
  failureCode: typeof row.failure_code === "string" ? row.failure_code : null,
  occurredAt: new Date(String(row.occurred_at)),
});

const makePolicyChangeEvent = (input: Omit<ConnectorPolicyChangeEvent, "id" | "occurredAt">, occurredAt = new Date()): ConnectorPolicyChangeEvent => ({
  id: randomUUID(),
  ...input,
  occurredAt,
});

const policyChangeValues = (event: ConnectorPolicyChangeEvent) => [
  event.id,
  event.tenantId,
  event.connectorId,
  event.actorUserId,
  event.changeKind,
  event.outcome,
  event.oldVersion,
  event.newVersion,
  event.oldPolicyHash,
  event.newPolicyHash,
  event.reviewedDefinitionHash,
  event.failureCode,
  event.correlationId,
  event.occurredAt,
];

const values = (record: SaveConnectorRegistryRecord) => [
  record.tenantId,
  record.id,
  record.serverId,
  record.serverName,
  record.name,
  record.shortDescription,
  record.description,
  record.category,
  JSON.stringify(record.services),
  record.endpointUrl,
  JSON.stringify(record.authorizationOrigins),
  JSON.stringify(record.scopes),
  JSON.stringify(record.toolPolicies ?? {}),
  JSON.stringify(record.toolDefinitionHashes ?? {}),
  record.brand,
  record.iconDataUrl ?? null,
  record.policySupport,
  record.source,
  record.createdBy,
];

export class PostgresConnectorRegistryStore implements ConnectorRegistryStore {
  constructor(private readonly pool: pg.Pool) {}

  static fromConnectionString(connectionString: string) {
    return new PostgresConnectorRegistryStore(new pg.Pool({ connectionString, max: 5 }));
  }

  async close() { await this.pool.end(); }

  async seedConnectors(_tenantId: string, connectors: SaveConnectorRegistryRecord[]) {
    for (const connector of connectors) {
      await this.pool.query(
        `INSERT INTO connector_registry (
          tenant_id,id,server_id,server_name,name,short_description,description,category,services,
          endpoint_url,authorization_origins,scopes,tool_policies,tool_definition_hashes,brand,icon_data_url,policy_support,source,created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19)
        ON CONFLICT (tenant_id,id) DO UPDATE SET
          -- A tenant that supplied its own OAuth application owns its gateway
          -- row. Reseeding the catalog refreshes the presentation around it but
          -- must never point the tenant back at the shared server.
          server_id=CASE WHEN connector_registry.credential_mode='tenant' THEN connector_registry.server_id ELSE EXCLUDED.server_id END,
          server_name=CASE WHEN connector_registry.credential_mode='tenant' THEN connector_registry.server_name ELSE EXCLUDED.server_name END,
          name=EXCLUDED.name,
          short_description=EXCLUDED.short_description,
          description=EXCLUDED.description,
          category=EXCLUDED.category,
          services=EXCLUDED.services,
          endpoint_url=EXCLUDED.endpoint_url,
          authorization_origins=EXCLUDED.authorization_origins,
          scopes=EXCLUDED.scopes,
          brand=EXCLUDED.brand,
          icon_data_url=EXCLUDED.icon_data_url,
          policy_support=EXCLUDED.policy_support,
          updated_at=now()
        WHERE connector_registry.source='built-in'`,
        values(connector),
      );
    }
  }

  async listConnectors(tenantId: string) {
    const result = await this.pool.query(
      "SELECT * FROM connector_registry WHERE tenant_id=$1 ORDER BY category,name,id",
      [tenantId],
    );
    return result.rows.map(mapRow);
  }

  async getConnector(tenantId: string, connectorId: string) {
    const result = await this.pool.query(
      "SELECT * FROM connector_registry WHERE tenant_id=$1 AND id=$2",
      [tenantId, connectorId],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async listConnectionStates(tenantId: string, subjectId: string) {
    const result = await this.pool.query(
      "SELECT * FROM connector_connection_state WHERE tenant_id=$1 AND subject_id=$2 ORDER BY connector_id",
      [tenantId, subjectId],
    );
    return result.rows.map(mapConnectionStateRow);
  }

  async getConnectionState(tenantId: string, subjectId: string, connectorId: string) {
    const result = await this.pool.query(
      "SELECT * FROM connector_connection_state WHERE tenant_id=$1 AND subject_id=$2 AND connector_id=$3",
      [tenantId, subjectId, connectorId],
    );
    return result.rowCount ? mapConnectionStateRow(result.rows[0]) : null;
  }

  async saveConnectionState(record: SaveConnectorConnectionStateRecord) {
    const result = await this.pool.query(
      `INSERT INTO connector_connection_state (tenant_id,subject_id,connector_id,state,connected_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id,subject_id,connector_id) DO UPDATE SET
         state=EXCLUDED.state,
         connected_at=EXCLUDED.connected_at,
         expires_at=EXCLUDED.expires_at,
         updated_at=now()
       RETURNING *`,
      [record.tenantId, record.subjectId, record.connectorId, record.state, record.connectedAt, record.expiresAt],
    );
    return mapConnectionStateRow(result.rows[0]);
  }

  async deleteConnectionState(tenantId: string, subjectId: string, connectorId: string) {
    const result = await this.pool.query(
      "DELETE FROM connector_connection_state WHERE tenant_id=$1 AND subject_id=$2 AND connector_id=$3",
      [tenantId, subjectId, connectorId],
    );
    return Boolean(result.rowCount);
  }

  async deleteConnectorConnectionStates(tenantId: string, connectorId: string) {
    const result = await this.pool.query(
      "DELETE FROM connector_connection_state WHERE tenant_id=$1 AND connector_id=$2",
      [tenantId, connectorId],
    );
    return result.rowCount ?? 0;
  }

  async listMicrosoft365SharePointSites(tenantId: string) {
    const result = await this.pool.query(
      `SELECT * FROM microsoft365_sharepoint_sites
       WHERE tenant_id=$1 ORDER BY display_name,id`,
      [tenantId],
    );
    return result.rows.map(mapMicrosoft365SharePointSiteRow);
  }

  async getMicrosoft365SharePointSite(tenantId: string, siteId: string) {
    const result = await this.pool.query(
      "SELECT * FROM microsoft365_sharepoint_sites WHERE tenant_id=$1 AND id=$2::uuid",
      [tenantId, siteId],
    );
    return result.rowCount ? mapMicrosoft365SharePointSiteRow(result.rows[0]) : null;
  }

  async createMicrosoft365SharePointSite(input: CreateMicrosoft365SharePointSiteInput) {
    const result = await this.pool.query(
      `INSERT INTO microsoft365_sharepoint_sites (
         tenant_id,id,display_name,site_url,hostname,site_path,access_level,created_by
       ) VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [input.tenantId, randomUUID(), input.displayName, input.siteUrl, input.hostname, input.sitePath, input.accessLevel, input.createdBy],
    );
    return mapMicrosoft365SharePointSiteRow(result.rows[0]);
  }

  async recordMicrosoft365SharePointSiteVerification(tenantId: string, siteId: string, input: {
    graphSiteId: string;
    driveIds: string[];
    verifiedAt?: Date;
  }) {
    const result = await this.pool.query(
      `UPDATE microsoft365_sharepoint_sites SET
         graph_site_id=$3,
         drive_ids=$4::jsonb,
         status='verified',
         last_verified_at=$5,
         last_verification_error=NULL,
         updated_at=now()
       WHERE tenant_id=$1 AND id=$2::uuid
       RETURNING *`,
      [tenantId, siteId, input.graphSiteId, JSON.stringify([...new Set(input.driveIds)].sort()), input.verifiedAt ?? new Date()],
    );
    return result.rowCount ? mapMicrosoft365SharePointSiteRow(result.rows[0]) : null;
  }

  async recordMicrosoft365SharePointSiteVerificationFailure(tenantId: string, siteId: string, error: string) {
    const result = await this.pool.query(
      `UPDATE microsoft365_sharepoint_sites SET
         graph_site_id=CASE WHEN microsoft_access_status='granted' THEN graph_site_id ELSE NULL END,
         drive_ids='[]'::jsonb,
         status='verification_failed',
         last_verified_at=NULL,
         last_verification_error=$3,
         updated_at=now()
       WHERE tenant_id=$1 AND id=$2::uuid
       RETURNING *`,
      [tenantId, siteId, error.slice(0, 320)],
    );
    return result.rowCount ? mapMicrosoft365SharePointSiteRow(result.rows[0]) : null;
  }

  async recordMicrosoft365SharePointSiteGrant(tenantId: string, siteId: string, input: {
    graphSiteId: string;
    driveIds: string[];
    accessLevel: Microsoft365SharePointSiteAccessLevel;
    microsoftPermissionId: string;
    grantedAt?: Date;
  }) {
    const result = await this.pool.query(
      `UPDATE microsoft365_sharepoint_sites SET
         graph_site_id=$3,
         drive_ids=$4::jsonb,
         access_level=$5,
         status='verified',
         last_verified_at=$7,
         last_verification_error=NULL,
         microsoft_access_status='granted',
         microsoft_permission_id=$6,
         microsoft_granted_at=$7,
         microsoft_last_error=NULL,
         updated_at=now()
       WHERE tenant_id=$1 AND id=$2::uuid
       RETURNING *`,
      [
        tenantId,
        siteId,
        input.graphSiteId,
        JSON.stringify([...new Set(input.driveIds)].sort()),
        input.accessLevel,
        input.microsoftPermissionId,
        input.grantedAt ?? new Date(),
      ],
    );
    return result.rowCount ? mapMicrosoft365SharePointSiteRow(result.rows[0]) : null;
  }

  async recordMicrosoft365SharePointSiteGrantFailure(tenantId: string, siteId: string, error: string) {
    const result = await this.pool.query(
      `UPDATE microsoft365_sharepoint_sites SET
         microsoft_access_status='grant_failed',
         microsoft_permission_id=NULL,
         microsoft_granted_at=NULL,
         microsoft_last_error=$3,
         updated_at=now()
       WHERE tenant_id=$1 AND id=$2::uuid
       RETURNING *`,
      [tenantId, siteId, error.slice(0, 320)],
    );
    return result.rowCount ? mapMicrosoft365SharePointSiteRow(result.rows[0]) : null;
  }

  async recordMicrosoft365SharePointSiteRevocationFailure(tenantId: string, siteId: string, error: string) {
    const result = await this.pool.query(
      `UPDATE microsoft365_sharepoint_sites SET
         microsoft_access_status='revocation_failed',
         microsoft_last_error=$3,
         updated_at=now()
       WHERE tenant_id=$1 AND id=$2::uuid
       RETURNING *`,
      [tenantId, siteId, error.slice(0, 320)],
    );
    return result.rowCount ? mapMicrosoft365SharePointSiteRow(result.rows[0]) : null;
  }

  async deleteMicrosoft365SharePointSite(tenantId: string, siteId: string) {
    const result = await this.pool.query(
      "DELETE FROM microsoft365_sharepoint_sites WHERE tenant_id=$1 AND id=$2::uuid RETURNING *",
      [tenantId, siteId],
    );
    return result.rowCount ? mapMicrosoft365SharePointSiteRow(result.rows[0]) : null;
  }

  async saveConnector(record: SaveConnectorRegistryRecord) {
    const result = await this.pool.query(
      `INSERT INTO connector_registry (
        tenant_id,id,server_id,server_name,name,short_description,description,category,services,
        endpoint_url,authorization_origins,scopes,tool_policies,tool_definition_hashes,brand,icon_data_url,policy_support,source,created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19)
      RETURNING *`,
      values(record),
    );
    return mapRow(result.rows[0]);
  }

  async updateAccessPolicy(tenantId: string, connectorId: string, input: { enabled: boolean; membersCanManage: boolean; updatedBy: string }) {
    const result = await this.pool.query(
      `UPDATE connector_registry SET
         enabled=$3,
         members_can_manage=$4,
         access_policy_version=access_policy_version+1,
         access_policy_updated_by=$5,
         access_policy_updated_at=now(),
         updated_at=now()
       WHERE tenant_id=$1 AND id=$2
       RETURNING *`,
      [tenantId, connectorId, input.enabled, input.membersCanManage, input.updatedBy],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async updateToolPolicies(tenantId: string, connectorId: string, review: ConnectorToolPolicyReview) {
    const { toolPolicies, toolDefinitionHashes } = reviewedToolPolicies(review);
    const result = await this.pool.query(
      `UPDATE connector_registry SET
         tool_policies=$3::jsonb,
         tool_definition_hashes=$4::jsonb,
         access_policy_version=access_policy_version+1,
         access_policy_updated_at=now(),
         updated_at=now()
       WHERE tenant_id=$1 AND id=$2
       RETURNING *`,
      [tenantId, connectorId, JSON.stringify(toolPolicies), JSON.stringify(toolDefinitionHashes)],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async applyAccessPolicyChange(tenantId: string, connectorId: string, input: {
    enabled: boolean;
    membersCanManage: boolean;
    updatedBy: string;
    expectedVersion: number;
    correlationId: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query(
        "SELECT * FROM connector_registry WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, connectorId],
      );
      if (!currentResult.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      const current = mapRow(currentResult.rows[0]);
      const oldPolicyHash = connectorPolicyDocumentHash(current);
      if (current.accessPolicyVersion !== input.expectedVersion) {
        const event = makePolicyChangeEvent({
          tenantId,
          connectorId,
          actorUserId: input.updatedBy,
          changeKind: "access_policy",
          outcome: "conflict",
          oldVersion: current.accessPolicyVersion,
          newVersion: current.accessPolicyVersion,
          oldPolicyHash,
          newPolicyHash: oldPolicyHash,
          reviewedDefinitionHash: null,
          failureCode: "CONNECTOR_POLICY_VERSION_CONFLICT",
          correlationId: input.correlationId,
        });
        await client.query(
          `INSERT INTO connector_policy_change_events (
             id,tenant_id,connector_id,actor_user_id,change_kind,outcome,old_version,new_version,
             old_policy_hash,new_policy_hash,reviewed_definition_hash,failure_code,correlation_id,occurred_at
           ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          policyChangeValues(event),
        );
        await client.query("COMMIT");
        return { connector: current, event };
      }
      const updatedResult = await client.query(
        `UPDATE connector_registry SET
           enabled=$3,
           members_can_manage=$4,
           access_policy_version=access_policy_version+1,
           access_policy_updated_by=$5,
           access_policy_updated_at=now(),
           updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING *`,
        [tenantId, connectorId, input.enabled, input.membersCanManage, input.updatedBy],
      );
      const connector = mapRow(updatedResult.rows[0]);
      const event = makePolicyChangeEvent({
        tenantId,
        connectorId,
        actorUserId: input.updatedBy,
        changeKind: "access_policy",
        outcome: "applied",
        oldVersion: current.accessPolicyVersion,
        newVersion: connector.accessPolicyVersion,
        oldPolicyHash,
        newPolicyHash: connectorPolicyDocumentHash(connector),
        reviewedDefinitionHash: null,
        failureCode: null,
        correlationId: input.correlationId,
      });
      await client.query(
        `INSERT INTO connector_policy_change_events (
           id,tenant_id,connector_id,actor_user_id,change_kind,outcome,old_version,new_version,
           old_policy_hash,new_policy_hash,reviewed_definition_hash,failure_code,correlation_id,occurred_at
         ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        policyChangeValues(event),
      );
      await client.query("COMMIT");
      return { connector, event };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async applyToolPolicyChange(tenantId: string, connectorId: string, input: ConnectorToolPolicyReview & {
    updatedBy: string;
    expectedVersion: number;
    reviewedDefinitionHash: string;
    correlationId: string;
  }) {
    const { toolPolicies, toolDefinitionHashes } = reviewedToolPolicies(input);
    if (!isDefinitionHash(input.reviewedDefinitionHash)) throw new Error("Reviewed connector definition hash must be a SHA-256 digest");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query(
        "SELECT * FROM connector_registry WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, connectorId],
      );
      if (!currentResult.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      const current = mapRow(currentResult.rows[0]);
      const oldPolicyHash = connectorPolicyDocumentHash(current);
      if (current.accessPolicyVersion !== input.expectedVersion) {
        const event = makePolicyChangeEvent({
          tenantId,
          connectorId,
          actorUserId: input.updatedBy,
          changeKind: "tool_policy",
          outcome: "conflict",
          oldVersion: current.accessPolicyVersion,
          newVersion: current.accessPolicyVersion,
          oldPolicyHash,
          newPolicyHash: oldPolicyHash,
          reviewedDefinitionHash: input.reviewedDefinitionHash,
          failureCode: "CONNECTOR_POLICY_VERSION_CONFLICT",
          correlationId: input.correlationId,
        });
        await client.query(
          `INSERT INTO connector_policy_change_events (
             id,tenant_id,connector_id,actor_user_id,change_kind,outcome,old_version,new_version,
             old_policy_hash,new_policy_hash,reviewed_definition_hash,failure_code,correlation_id,occurred_at
           ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          policyChangeValues(event),
        );
        await client.query("COMMIT");
        return { connector: current, event };
      }
      const updatedResult = await client.query(
        `UPDATE connector_registry SET
           tool_policies=$3::jsonb,
           tool_definition_hashes=$4::jsonb,
           access_policy_version=access_policy_version+1,
           access_policy_updated_by=$5,
           access_policy_updated_at=now(),
           updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING *`,
        [tenantId, connectorId, JSON.stringify(toolPolicies), JSON.stringify(toolDefinitionHashes), input.updatedBy],
      );
      const connector = mapRow(updatedResult.rows[0]);
      const event = makePolicyChangeEvent({
        tenantId,
        connectorId,
        actorUserId: input.updatedBy,
        changeKind: "tool_policy",
        outcome: "applied",
        oldVersion: current.accessPolicyVersion,
        newVersion: connector.accessPolicyVersion,
        oldPolicyHash,
        newPolicyHash: connectorPolicyDocumentHash(connector),
        reviewedDefinitionHash: input.reviewedDefinitionHash,
        failureCode: null,
        correlationId: input.correlationId,
      });
      await client.query(
        `INSERT INTO connector_policy_change_events (
           id,tenant_id,connector_id,actor_user_id,change_kind,outcome,old_version,new_version,
           old_policy_hash,new_policy_hash,reviewed_definition_hash,failure_code,correlation_id,occurred_at
         ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        policyChangeValues(event),
      );
      await client.query("COMMIT");
      return { connector, event };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordToolPolicyConflict(tenantId: string, connectorId: string, input: {
    actorUserId: string;
    reviewedDefinitionHash: string;
    failureCode: string;
    correlationId: string;
  }) {
    if (!isDefinitionHash(input.reviewedDefinitionHash)) throw new Error("Reviewed connector definition hash must be a SHA-256 digest");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query(
        "SELECT * FROM connector_registry WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, connectorId],
      );
      if (!currentResult.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      const current = mapRow(currentResult.rows[0]);
      const policyHash = connectorPolicyDocumentHash(current);
      const event = makePolicyChangeEvent({
        tenantId,
        connectorId,
        actorUserId: input.actorUserId,
        changeKind: "tool_policy",
        outcome: "conflict",
        oldVersion: current.accessPolicyVersion,
        newVersion: current.accessPolicyVersion,
        oldPolicyHash: policyHash,
        newPolicyHash: policyHash,
        reviewedDefinitionHash: input.reviewedDefinitionHash,
        failureCode: input.failureCode,
        correlationId: input.correlationId,
      });
      await client.query(
        `INSERT INTO connector_policy_change_events (
           id,tenant_id,connector_id,actor_user_id,change_kind,outcome,old_version,new_version,
           old_policy_hash,new_policy_hash,reviewed_definition_hash,failure_code,correlation_id,occurred_at
         ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        policyChangeValues(event),
      );
      await client.query("COMMIT");
      return event;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async appendPolicyWorkspaceDeliveryReceipts(receipts: Omit<ConnectorPolicyWorkspaceDeliveryReceipt, "id" | "occurredAt">[]) {
    if (!receipts.length) return [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const saved: ConnectorPolicyWorkspaceDeliveryReceipt[] = [];
      for (const receipt of receipts) {
        const result = await client.query(
          `INSERT INTO connector_policy_workspace_delivery_receipts (
             id,tenant_id,change_event_id,workspace_id,owner_subject_id,grant_id,workspace_state,outcome,failure_code,occurred_at
           ) VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [randomUUID(), receipt.tenantId, receipt.changeEventId, receipt.workspaceId, receipt.ownerSubjectId,
            receipt.grantId, receipt.workspaceState, receipt.outcome, receipt.failureCode, new Date()],
        );
        saved.push(mapPolicyWorkspaceDeliveryRow(result.rows[0]));
      }
      await client.query("COMMIT");
      return saved;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async latestPolicyDelivery(tenantId: string, connectorId: string) {
    const eventResult = await this.pool.query(
      `SELECT * FROM connector_policy_change_events
       WHERE tenant_id=$1 AND connector_id=$2 AND outcome='applied'
       ORDER BY occurred_at DESC,id DESC LIMIT 1`,
      [tenantId, connectorId],
    );
    if (!eventResult.rowCount) return null;
    const event = mapPolicyChangeRow(eventResult.rows[0]);
    const receiptsResult = await this.pool.query(
      `SELECT * FROM connector_policy_workspace_delivery_receipts
       WHERE tenant_id=$1 AND change_event_id=$2::uuid
       ORDER BY occurred_at DESC,id DESC`,
      [tenantId, event.id],
    );
    return { event, receipts: receiptsResult.rows.map(mapPolicyWorkspaceDeliveryRow) };
  }

  async createDiscoveryEgressPermit(input: CreateConnectorDiscoveryEgressPermitInput) {
    const permit = createDiscoveryPermit(input);
    const result = await this.pool.query<{ created_at: Date | string }>(
      `INSERT INTO connector_discovery_egress_permits (id,tenant_id,origin,expires_at,created_by)
       SELECT $1::uuid,$2,permit_origin.origin,$4,$5
       FROM unnest($3::text[]) AS permit_origin(origin)
       RETURNING created_at`,
      [permit.id, permit.tenantId, permit.origins, permit.expiresAt, permit.createdBy],
    );
    return {
      ...permit,
      createdAt: result.rowCount ? new Date(result.rows[0]!.created_at) : permit.createdAt,
    };
  }

  async deleteDiscoveryEgressPermit(tenantId: string, permitId: string) {
    const result = await this.pool.query(
      "DELETE FROM connector_discovery_egress_permits WHERE tenant_id=$1 AND id=$2::uuid",
      [tenantId, permitId],
    );
    return Boolean(result.rowCount);
  }

  // Built-in connectors are authorized from the source catalog, not from this
  // table, so a built-in row withdrawn from the catalog cannot keep its egress
  // grant in an installation that already seeded it. Only tenant-owned custom
  // connectors and unexpired discovery permits contribute here.
  async listEnabledEgressOrigins(now = new Date()) {
    const result = await this.pool.query<{ origin: string }>(
      `WITH connector_origins AS (
         SELECT endpoint_url AS origin FROM connector_registry WHERE enabled AND source='custom'
         UNION
         SELECT jsonb_array_elements_text(authorization_origins) AS origin FROM connector_registry WHERE enabled AND source='custom'
       ), active_discovery_permit_origins AS (
         SELECT origin FROM connector_discovery_egress_permits WHERE expires_at>$1
       )
       SELECT origin FROM connector_origins
       UNION
       SELECT origin FROM active_discovery_permit_origins`,
      [now],
    );
    return [...new Set(result.rows
      .map((row) => normalizeEgressOrigin(row.origin))
      .filter((origin): origin is string => Boolean(origin)))].sort();
  }

  async recordConnectorAdminConsent(tenantId: string, connectorId: string, input: RecordConnectorAdminConsentInput) {
    const result = await this.pool.query(
      `UPDATE connector_registry SET
         admin_consent_granted_at=$3,
         admin_consent_provider_tenant_id=$4,
         admin_consent_requested_by=$5,
         updated_at=now()
       WHERE tenant_id=$1 AND id=$2
       RETURNING *`,
      [tenantId, connectorId, input.grantedAt ?? new Date(), input.providerTenantId, input.requestedBy],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async clearConnectorAdminConsent(tenantId: string, connectorId: string) {
    const result = await this.pool.query(
      `UPDATE connector_registry SET
         admin_consent_granted_at=NULL,
         admin_consent_provider_tenant_id=NULL,
         admin_consent_requested_by=NULL,
         updated_at=now()
       WHERE tenant_id=$1 AND id=$2
       RETURNING *`,
      [tenantId, connectorId],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async recordSharePointAdminConsent(tenantId: string, connectorId: string, input: RecordConnectorAdminConsentInput) {
    const result = await this.pool.query(
      `UPDATE connector_registry SET
         sharepoint_admin_consent_granted_at=$3,
         sharepoint_admin_consent_provider_tenant_id=$4,
         sharepoint_admin_consent_requested_by=$5,
         updated_at=now()
       WHERE tenant_id=$1 AND id=$2
       RETURNING *`,
      [tenantId, connectorId, input.grantedAt ?? new Date(), input.providerTenantId, input.requestedBy],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async clearSharePointAdminConsent(tenantId: string, connectorId: string) {
    const result = await this.pool.query(
      `UPDATE connector_registry SET
         sharepoint_admin_consent_granted_at=NULL,
         sharepoint_admin_consent_provider_tenant_id=NULL,
         sharepoint_admin_consent_requested_by=NULL,
         updated_at=now()
       WHERE tenant_id=$1 AND id=$2
       RETURNING *`,
      [tenantId, connectorId],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async saveConnectorCredentials(tenantId: string, connectorId: string, input: SaveConnectorCredentialsInput) {
    const result = await this.pool.query(
      `UPDATE connector_registry SET
         server_id=$3,
         server_name=$4,
         credential_mode='tenant',
         oauth_client_id=$5,
         credentials_updated_by=$6,
         credentials_updated_at=now(),
         updated_at=now()
       WHERE tenant_id=$1 AND id=$2
       RETURNING *`,
      [tenantId, connectorId, input.serverId, input.serverName, input.oauthClientId, input.updatedBy],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async clearConnectorCredentials(tenantId: string, connectorId: string, input: { serverId: string; serverName: string }) {
    const result = await this.pool.query(
      `UPDATE connector_registry SET
         server_id=$3,
         server_name=$4,
         credential_mode='deployment',
         oauth_client_id=NULL,
         credentials_updated_by=NULL,
         credentials_updated_at=NULL,
         updated_at=now()
       WHERE tenant_id=$1 AND id=$2
       RETURNING *`,
      [tenantId, connectorId, input.serverId, input.serverName],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async updateIcon(tenantId: string, connectorId: string, iconDataUrl: string | null) {
    const result = await this.pool.query(
      "UPDATE connector_registry SET icon_data_url=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND source='custom' RETURNING *",
      [tenantId, connectorId, iconDataUrl],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async deleteConnector(tenantId: string, connectorId: string) {
    const result = await this.pool.query(
      "DELETE FROM connector_registry WHERE tenant_id=$1 AND id=$2 AND source='custom' RETURNING *",
      [tenantId, connectorId],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }
}

export class MemoryConnectorRegistryStore implements ConnectorRegistryStore {
  private readonly records = new Map<string, ConnectorRegistryRecord>();
  private readonly connectionStates = new Map<string, ConnectorConnectionStateRecord>();
  private readonly microsoft365SharePointSites = new Map<string, Microsoft365SharePointSiteRecord>();
  private readonly discoveryEgressPermits = new Map<string, ConnectorDiscoveryEgressPermit>();
  private readonly policyChangeEvents: ConnectorPolicyChangeEvent[] = [];
  private readonly policyDeliveryReceipts: ConnectorPolicyWorkspaceDeliveryReceipt[] = [];
  private key(tenantId: string, connectorId: string) { return `${tenantId}:${connectorId}`; }
  private connectionStateKey(tenantId: string, subjectId: string, connectorId: string) { return `${tenantId}\u0000${subjectId}\u0000${connectorId}`; }
  private microsoft365SharePointSiteKey(tenantId: string, siteId: string) { return `${tenantId}\u0000${siteId}`; }
  private discoveryPermitKey(tenantId: string, permitId: string) { return `${tenantId}\u0000${permitId}`; }

  async seedConnectors(_tenantId: string, connectors: SaveConnectorRegistryRecord[]) {
    for (const connector of connectors) {
      const key = this.key(connector.tenantId, connector.id);
      const current = this.records.get(key);
      if (!current) await this.saveConnector(connector);
      else if (current.source === "built-in") {
        this.records.set(key, cloneConnectorRecord({
          ...current,
          ...connector,
          // A tenant that supplied its own OAuth application owns its gateway
          // row; reseeding must not point it back at the shared server.
          ...(current.credentialMode === "tenant"
            ? { serverId: current.serverId, serverName: current.serverName }
            : {}),
          services: [...connector.services],
          authorizationOrigins: [...connector.authorizationOrigins],
          scopes: [...connector.scopes],
          toolPolicies: { ...current.toolPolicies },
          toolDefinitionHashes: { ...current.toolDefinitionHashes },
          updatedAt: new Date(),
        }));
      }
    }
  }

  async listConnectors(tenantId: string) {
    return [...this.records.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((left, right) => left.category.localeCompare(right.category) || left.name.localeCompare(right.name))
      .map(cloneConnectorRecord);
  }

  async getConnector(tenantId: string, connectorId: string) {
    const record = this.records.get(this.key(tenantId, connectorId));
    return record ? cloneConnectorRecord(record) : null;
  }

  async listConnectionStates(tenantId: string, subjectId: string) {
    return [...this.connectionStates.values()]
      .filter((record) => record.tenantId === tenantId && record.subjectId === subjectId)
      .sort((left, right) => left.connectorId.localeCompare(right.connectorId));
  }

  async getConnectionState(tenantId: string, subjectId: string, connectorId: string) {
    return this.connectionStates.get(this.connectionStateKey(tenantId, subjectId, connectorId)) ?? null;
  }

  async saveConnectionState(record: SaveConnectorConnectionStateRecord) {
    if (!this.records.has(this.key(record.tenantId, record.connectorId))) throw new Error("Connector does not exist");
    const now = new Date();
    const saved = { ...record, updatedAt: now };
    this.connectionStates.set(this.connectionStateKey(record.tenantId, record.subjectId, record.connectorId), saved);
    return saved;
  }

  async deleteConnectionState(tenantId: string, subjectId: string, connectorId: string) {
    return this.connectionStates.delete(this.connectionStateKey(tenantId, subjectId, connectorId));
  }

  async deleteConnectorConnectionStates(tenantId: string, connectorId: string) {
    let removed = 0;
    for (const [key, state] of this.connectionStates) {
      if (state.tenantId !== tenantId || state.connectorId !== connectorId) continue;
      this.connectionStates.delete(key);
      removed += 1;
    }
    return removed;
  }

  async listMicrosoft365SharePointSites(tenantId: string) {
    return [...this.microsoft365SharePointSites.values()]
      .filter((site) => site.tenantId === tenantId)
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id))
      .map(cloneMicrosoft365SharePointSite);
  }

  async getMicrosoft365SharePointSite(tenantId: string, siteId: string) {
    const site = this.microsoft365SharePointSites.get(this.microsoft365SharePointSiteKey(tenantId, siteId));
    return site ? cloneMicrosoft365SharePointSite(site) : null;
  }

  async createMicrosoft365SharePointSite(input: CreateMicrosoft365SharePointSiteInput) {
    if (!this.records.has(this.key(input.tenantId, "microsoft-365"))) throw new Error("Microsoft 365 connector does not exist");
    if ([...this.microsoft365SharePointSites.values()].some((site) => site.tenantId === input.tenantId && site.siteUrl === input.siteUrl)) {
      throw new Error("SharePoint site already exists");
    }
    const now = new Date();
    const site: Microsoft365SharePointSiteRecord = {
      ...input,
      id: randomUUID(),
      connectorId: "microsoft-365",
      graphSiteId: null,
      driveIds: [],
      status: "pending",
      microsoftAccessStatus: "pending",
      microsoftPermissionId: null,
      microsoftGrantedAt: null,
      microsoftLastError: null,
      lastVerifiedAt: null,
      lastVerificationError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.microsoft365SharePointSites.set(this.microsoft365SharePointSiteKey(site.tenantId, site.id), site);
    return cloneMicrosoft365SharePointSite(site);
  }

  async recordMicrosoft365SharePointSiteVerification(tenantId: string, siteId: string, input: {
    graphSiteId: string;
    driveIds: string[];
    verifiedAt?: Date;
  }) {
    const key = this.microsoft365SharePointSiteKey(tenantId, siteId);
    const current = this.microsoft365SharePointSites.get(key);
    if (!current) return null;
    const saved: Microsoft365SharePointSiteRecord = {
      ...current,
      graphSiteId: input.graphSiteId,
      driveIds: [...new Set(input.driveIds)].sort(),
      status: "verified",
      lastVerifiedAt: input.verifiedAt ?? new Date(),
      lastVerificationError: null,
      updatedAt: new Date(),
    };
    this.microsoft365SharePointSites.set(key, saved);
    return cloneMicrosoft365SharePointSite(saved);
  }

  async recordMicrosoft365SharePointSiteVerificationFailure(tenantId: string, siteId: string, error: string) {
    const key = this.microsoft365SharePointSiteKey(tenantId, siteId);
    const current = this.microsoft365SharePointSites.get(key);
    if (!current) return null;
    const saved: Microsoft365SharePointSiteRecord = {
      ...current,
      graphSiteId: current.microsoftAccessStatus === "granted" ? current.graphSiteId : null,
      driveIds: [],
      status: "verification_failed",
      lastVerifiedAt: null,
      lastVerificationError: error.slice(0, 320),
      updatedAt: new Date(),
    };
    this.microsoft365SharePointSites.set(key, saved);
    return cloneMicrosoft365SharePointSite(saved);
  }

  async recordMicrosoft365SharePointSiteGrant(tenantId: string, siteId: string, input: {
    graphSiteId: string;
    driveIds: string[];
    accessLevel: Microsoft365SharePointSiteAccessLevel;
    microsoftPermissionId: string;
    grantedAt?: Date;
  }) {
    const key = this.microsoft365SharePointSiteKey(tenantId, siteId);
    const current = this.microsoft365SharePointSites.get(key);
    if (!current) return null;
    const grantedAt = input.grantedAt ?? new Date();
    const saved: Microsoft365SharePointSiteRecord = {
      ...current,
      graphSiteId: input.graphSiteId,
      driveIds: [...new Set(input.driveIds)].sort(),
      accessLevel: input.accessLevel,
      status: "verified",
      lastVerifiedAt: grantedAt,
      lastVerificationError: null,
      microsoftAccessStatus: "granted",
      microsoftPermissionId: input.microsoftPermissionId,
      microsoftGrantedAt: grantedAt,
      microsoftLastError: null,
      updatedAt: new Date(),
    };
    this.microsoft365SharePointSites.set(key, saved);
    return cloneMicrosoft365SharePointSite(saved);
  }

  async recordMicrosoft365SharePointSiteGrantFailure(tenantId: string, siteId: string, error: string) {
    const key = this.microsoft365SharePointSiteKey(tenantId, siteId);
    const current = this.microsoft365SharePointSites.get(key);
    if (!current) return null;
    const saved: Microsoft365SharePointSiteRecord = {
      ...current,
      microsoftAccessStatus: "grant_failed",
      microsoftPermissionId: null,
      microsoftGrantedAt: null,
      microsoftLastError: error.slice(0, 320),
      updatedAt: new Date(),
    };
    this.microsoft365SharePointSites.set(key, saved);
    return cloneMicrosoft365SharePointSite(saved);
  }

  async recordMicrosoft365SharePointSiteRevocationFailure(tenantId: string, siteId: string, error: string) {
    const key = this.microsoft365SharePointSiteKey(tenantId, siteId);
    const current = this.microsoft365SharePointSites.get(key);
    if (!current) return null;
    const saved: Microsoft365SharePointSiteRecord = {
      ...current,
      microsoftAccessStatus: "revocation_failed",
      microsoftLastError: error.slice(0, 320),
      updatedAt: new Date(),
    };
    this.microsoft365SharePointSites.set(key, saved);
    return cloneMicrosoft365SharePointSite(saved);
  }

  async deleteMicrosoft365SharePointSite(tenantId: string, siteId: string) {
    const key = this.microsoft365SharePointSiteKey(tenantId, siteId);
    const current = this.microsoft365SharePointSites.get(key);
    if (!current) return null;
    this.microsoft365SharePointSites.delete(key);
    return cloneMicrosoft365SharePointSite(current);
  }

  async saveConnector(record: SaveConnectorRegistryRecord) {
    const key = this.key(record.tenantId, record.id);
    if (this.records.has(key)) throw new Error("Connector already exists");
    // Mirrors connector_registry_custom_server_name_key. A tenant-owned row
    // names a server in a gateway that may be shared by every tenant, so its
    // name has to be unique across tenants and not only within one. Built-in
    // rows deliberately repeat the same shared name per tenant.
    if (record.source === "custom" && [...this.records.values()].some((existing) => (
      existing.source === "custom" && existing.serverName === record.serverName
    ))) {
      throw new Error("Connector gateway server name already exists");
    }
    const now = new Date();
    const saved: ConnectorRegistryRecord = {
      ...record,
      services: [...record.services],
      authorizationOrigins: [...record.authorizationOrigins],
      scopes: [...record.scopes],
      toolPolicies: record.toolPolicies ?? {},
      toolDefinitionHashes: record.toolDefinitionHashes ?? {},
      iconDataUrl: record.iconDataUrl ?? null,
      enabled: record.enabled ?? true,
      membersCanManage: record.membersCanManage ?? true,
      accessPolicyVersion: 1,
      accessPolicyUpdatedBy: null,
      accessPolicyUpdatedAt: now,
      credentialMode: "deployment",
      oauthClientId: null,
      credentialsUpdatedBy: null,
      credentialsUpdatedAt: null,
      adminConsentGrantedAt: null,
      adminConsentProviderTenantId: null,
      adminConsentRequestedBy: null,
      sharePointAdminConsentGrantedAt: null,
      sharePointAdminConsentProviderTenantId: null,
      sharePointAdminConsentRequestedBy: null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(key, cloneConnectorRecord(saved));
    return cloneConnectorRecord(saved);
  }

  async updateAccessPolicy(tenantId: string, connectorId: string, input: { enabled: boolean; membersCanManage: boolean; updatedBy: string }) {
    const key = this.key(tenantId, connectorId);
    const record = this.records.get(key);
    if (!record) return null;
    const now = new Date();
    const saved = {
      ...record,
      enabled: input.enabled,
      membersCanManage: input.membersCanManage,
      accessPolicyVersion: record.accessPolicyVersion + 1,
      accessPolicyUpdatedBy: input.updatedBy,
      accessPolicyUpdatedAt: now,
      updatedAt: now,
    };
    this.records.set(key, cloneConnectorRecord(saved));
    return cloneConnectorRecord(saved);
  }

  async updateToolPolicies(tenantId: string, connectorId: string, review: ConnectorToolPolicyReview) {
    const { toolPolicies, toolDefinitionHashes } = reviewedToolPolicies(review);
    const key = this.key(tenantId, connectorId);
    const record = this.records.get(key);
    if (!record) return null;
    const saved = {
      ...record,
      toolPolicies: { ...toolPolicies },
      toolDefinitionHashes: { ...toolDefinitionHashes },
      accessPolicyVersion: record.accessPolicyVersion + 1,
      accessPolicyUpdatedAt: new Date(),
      updatedAt: new Date(),
    };
    this.records.set(key, cloneConnectorRecord(saved));
    return cloneConnectorRecord(saved);
  }

  async applyAccessPolicyChange(tenantId: string, connectorId: string, input: {
    enabled: boolean;
    membersCanManage: boolean;
    updatedBy: string;
    expectedVersion: number;
    correlationId: string;
  }) {
    const key = this.key(tenantId, connectorId);
    const current = this.records.get(key);
    if (!current) return null;
    const oldPolicyHash = connectorPolicyDocumentHash(current);
    if (current.accessPolicyVersion !== input.expectedVersion) {
      const event = makePolicyChangeEvent({
        tenantId,
        connectorId,
        actorUserId: input.updatedBy,
        changeKind: "access_policy",
        outcome: "conflict",
        oldVersion: current.accessPolicyVersion,
        newVersion: current.accessPolicyVersion,
        oldPolicyHash,
        newPolicyHash: oldPolicyHash,
        reviewedDefinitionHash: null,
        failureCode: "CONNECTOR_POLICY_VERSION_CONFLICT",
        correlationId: input.correlationId,
      });
      this.policyChangeEvents.push(event);
      return { connector: cloneConnectorRecord(current), event: { ...event } };
    }
    const now = new Date();
    const connector = {
      ...current,
      enabled: input.enabled,
      membersCanManage: input.membersCanManage,
      accessPolicyVersion: current.accessPolicyVersion + 1,
      accessPolicyUpdatedBy: input.updatedBy,
      accessPolicyUpdatedAt: now,
      updatedAt: now,
    };
    this.records.set(key, cloneConnectorRecord(connector));
    const event = makePolicyChangeEvent({
      tenantId,
      connectorId,
      actorUserId: input.updatedBy,
      changeKind: "access_policy",
      outcome: "applied",
      oldVersion: current.accessPolicyVersion,
      newVersion: connector.accessPolicyVersion,
      oldPolicyHash,
      newPolicyHash: connectorPolicyDocumentHash(connector),
      reviewedDefinitionHash: null,
      failureCode: null,
      correlationId: input.correlationId,
    }, now);
    this.policyChangeEvents.push(event);
    return { connector: cloneConnectorRecord(connector), event: { ...event } };
  }

  async applyToolPolicyChange(tenantId: string, connectorId: string, input: ConnectorToolPolicyReview & {
    updatedBy: string;
    expectedVersion: number;
    reviewedDefinitionHash: string;
    correlationId: string;
  }) {
    const { toolPolicies, toolDefinitionHashes } = reviewedToolPolicies(input);
    if (!isDefinitionHash(input.reviewedDefinitionHash)) throw new Error("Reviewed connector definition hash must be a SHA-256 digest");
    const key = this.key(tenantId, connectorId);
    const current = this.records.get(key);
    if (!current) return null;
    const oldPolicyHash = connectorPolicyDocumentHash(current);
    if (current.accessPolicyVersion !== input.expectedVersion) {
      const event = makePolicyChangeEvent({
        tenantId,
        connectorId,
        actorUserId: input.updatedBy,
        changeKind: "tool_policy",
        outcome: "conflict",
        oldVersion: current.accessPolicyVersion,
        newVersion: current.accessPolicyVersion,
        oldPolicyHash,
        newPolicyHash: oldPolicyHash,
        reviewedDefinitionHash: input.reviewedDefinitionHash,
        failureCode: "CONNECTOR_POLICY_VERSION_CONFLICT",
        correlationId: input.correlationId,
      });
      this.policyChangeEvents.push(event);
      return { connector: cloneConnectorRecord(current), event: { ...event } };
    }
    const now = new Date();
    const connector = {
      ...current,
      toolPolicies: { ...toolPolicies },
      toolDefinitionHashes: { ...toolDefinitionHashes },
      accessPolicyVersion: current.accessPolicyVersion + 1,
      accessPolicyUpdatedBy: input.updatedBy,
      accessPolicyUpdatedAt: now,
      updatedAt: now,
    };
    this.records.set(key, cloneConnectorRecord(connector));
    const event = makePolicyChangeEvent({
      tenantId,
      connectorId,
      actorUserId: input.updatedBy,
      changeKind: "tool_policy",
      outcome: "applied",
      oldVersion: current.accessPolicyVersion,
      newVersion: connector.accessPolicyVersion,
      oldPolicyHash,
      newPolicyHash: connectorPolicyDocumentHash(connector),
      reviewedDefinitionHash: input.reviewedDefinitionHash,
      failureCode: null,
      correlationId: input.correlationId,
    }, now);
    this.policyChangeEvents.push(event);
    return { connector: cloneConnectorRecord(connector), event: { ...event } };
  }

  async recordToolPolicyConflict(tenantId: string, connectorId: string, input: {
    actorUserId: string;
    reviewedDefinitionHash: string;
    failureCode: string;
    correlationId: string;
  }) {
    if (!isDefinitionHash(input.reviewedDefinitionHash)) throw new Error("Reviewed connector definition hash must be a SHA-256 digest");
    const current = this.records.get(this.key(tenantId, connectorId));
    if (!current) return null;
    const policyHash = connectorPolicyDocumentHash(current);
    const event = makePolicyChangeEvent({
      tenantId,
      connectorId,
      actorUserId: input.actorUserId,
      changeKind: "tool_policy",
      outcome: "conflict",
      oldVersion: current.accessPolicyVersion,
      newVersion: current.accessPolicyVersion,
      oldPolicyHash: policyHash,
      newPolicyHash: policyHash,
      reviewedDefinitionHash: input.reviewedDefinitionHash,
      failureCode: input.failureCode,
      correlationId: input.correlationId,
    });
    this.policyChangeEvents.push(event);
    return { ...event };
  }

  async appendPolicyWorkspaceDeliveryReceipts(receipts: Omit<ConnectorPolicyWorkspaceDeliveryReceipt, "id" | "occurredAt">[]) {
    const saved = receipts.map((receipt) => ({ id: randomUUID(), ...receipt, occurredAt: new Date() }));
    for (const receipt of saved) {
      const event = this.policyChangeEvents.find((candidate) => candidate.id === receipt.changeEventId && candidate.tenantId === receipt.tenantId);
      if (!event) throw new Error("Connector policy change event does not exist for tenant");
      this.policyDeliveryReceipts.push(receipt);
    }
    return saved.map((receipt) => ({ ...receipt }));
  }

  async latestPolicyDelivery(tenantId: string, connectorId: string) {
    const event = this.policyChangeEvents
      .filter((candidate) => candidate.tenantId === tenantId && candidate.connectorId === connectorId && candidate.outcome === "applied")
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime() || right.id.localeCompare(left.id))[0];
    if (!event) return null;
    return {
      event: { ...event },
      receipts: this.policyDeliveryReceipts
        .filter((receipt) => receipt.tenantId === tenantId && receipt.changeEventId === event.id)
        .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime() || right.id.localeCompare(left.id))
        .map((receipt) => ({ ...receipt })),
    };
  }

  async createDiscoveryEgressPermit(input: CreateConnectorDiscoveryEgressPermitInput) {
    const permit = createDiscoveryPermit(input);
    this.discoveryEgressPermits.set(this.discoveryPermitKey(permit.tenantId, permit.id), cloneDiscoveryPermit(permit));
    return cloneDiscoveryPermit(permit);
  }

  async deleteDiscoveryEgressPermit(tenantId: string, permitId: string) {
    return this.discoveryEgressPermits.delete(this.discoveryPermitKey(tenantId, permitId));
  }

  // Built-in connectors are authorized from the source catalog, not from this
  // table, so a built-in row withdrawn from the catalog cannot keep its egress
  // grant in an installation that already seeded it. Only tenant-owned custom
  // connectors and unexpired discovery permits contribute here.
  async listEnabledEgressOrigins(now = new Date()) {
    const origins = new Set<string>();
    for (const connector of this.records.values()) {
      if (!connector.enabled || connector.source !== "custom") continue;
      const endpointOrigin = normalizeEgressOrigin(connector.endpointUrl);
      if (endpointOrigin) origins.add(endpointOrigin);
      for (const authorizationOrigin of connector.authorizationOrigins) {
        const normalized = normalizeEgressOrigin(authorizationOrigin);
        if (normalized) origins.add(normalized);
      }
    }
    for (const permit of this.discoveryEgressPermits.values()) {
      if (permit.expiresAt <= now) continue;
      for (const origin of permit.origins) origins.add(origin);
    }
    return [...origins].sort();
  }

  async recordConnectorAdminConsent(tenantId: string, connectorId: string, input: RecordConnectorAdminConsentInput) {
    const key = this.key(tenantId, connectorId);
    const record = this.records.get(key);
    if (!record) return null;
    const saved: ConnectorRegistryRecord = {
      ...record,
      adminConsentGrantedAt: input.grantedAt ?? new Date(),
      adminConsentProviderTenantId: input.providerTenantId,
      adminConsentRequestedBy: input.requestedBy,
      updatedAt: new Date(),
    };
    this.records.set(key, cloneConnectorRecord(saved));
    return cloneConnectorRecord(saved);
  }

  async clearConnectorAdminConsent(tenantId: string, connectorId: string) {
    const key = this.key(tenantId, connectorId);
    const record = this.records.get(key);
    if (!record) return null;
    const saved: ConnectorRegistryRecord = {
      ...record,
      adminConsentGrantedAt: null,
      adminConsentProviderTenantId: null,
      adminConsentRequestedBy: null,
      updatedAt: new Date(),
    };
    this.records.set(key, cloneConnectorRecord(saved));
    return cloneConnectorRecord(saved);
  }

  async recordSharePointAdminConsent(tenantId: string, connectorId: string, input: RecordConnectorAdminConsentInput) {
    const key = this.key(tenantId, connectorId);
    const record = this.records.get(key);
    if (!record) return null;
    const saved: ConnectorRegistryRecord = {
      ...record,
      sharePointAdminConsentGrantedAt: input.grantedAt ?? new Date(),
      sharePointAdminConsentProviderTenantId: input.providerTenantId,
      sharePointAdminConsentRequestedBy: input.requestedBy,
      updatedAt: new Date(),
    };
    this.records.set(key, cloneConnectorRecord(saved));
    return cloneConnectorRecord(saved);
  }

  async clearSharePointAdminConsent(tenantId: string, connectorId: string) {
    const key = this.key(tenantId, connectorId);
    const record = this.records.get(key);
    if (!record) return null;
    const saved: ConnectorRegistryRecord = {
      ...record,
      sharePointAdminConsentGrantedAt: null,
      sharePointAdminConsentProviderTenantId: null,
      sharePointAdminConsentRequestedBy: null,
      updatedAt: new Date(),
    };
    this.records.set(key, cloneConnectorRecord(saved));
    return cloneConnectorRecord(saved);
  }

  async saveConnectorCredentials(tenantId: string, connectorId: string, input: SaveConnectorCredentialsInput) {
    const key = this.key(tenantId, connectorId);
    const record = this.records.get(key);
    if (!record) return null;
    if ([...this.records.values()].some((existing) => (
      existing.serverName === input.serverName && !(existing.tenantId === tenantId && existing.id === connectorId)
    ))) {
      throw new Error("Connector gateway server name already exists");
    }
    const saved: ConnectorRegistryRecord = {
      ...record,
      serverId: input.serverId,
      serverName: input.serverName,
      credentialMode: "tenant",
      oauthClientId: input.oauthClientId,
      credentialsUpdatedBy: input.updatedBy,
      credentialsUpdatedAt: new Date(),
      updatedAt: new Date(),
    };
    this.records.set(key, cloneConnectorRecord(saved));
    return cloneConnectorRecord(saved);
  }

  async clearConnectorCredentials(tenantId: string, connectorId: string, input: { serverId: string; serverName: string }) {
    const key = this.key(tenantId, connectorId);
    const record = this.records.get(key);
    if (!record) return null;
    const saved: ConnectorRegistryRecord = {
      ...record,
      serverId: input.serverId,
      serverName: input.serverName,
      credentialMode: "deployment",
      oauthClientId: null,
      credentialsUpdatedBy: null,
      credentialsUpdatedAt: null,
      updatedAt: new Date(),
    };
    this.records.set(key, cloneConnectorRecord(saved));
    return cloneConnectorRecord(saved);
  }

  async updateIcon(tenantId: string, connectorId: string, iconDataUrl: string | null) {
    const key = this.key(tenantId, connectorId);
    const record = this.records.get(key);
    if (!record || record.source !== "custom") return null;
    const saved = { ...record, iconDataUrl, updatedAt: new Date() };
    this.records.set(key, cloneConnectorRecord(saved));
    return cloneConnectorRecord(saved);
  }

  async deleteConnector(tenantId: string, connectorId: string) {
    const key = this.key(tenantId, connectorId);
    const record = this.records.get(key);
    if (!record || record.source !== "custom") return null;
    this.records.delete(key);
    for (const [stateKey, state] of this.connectionStates) {
      if (state.tenantId === tenantId && state.connectorId === connectorId) this.connectionStates.delete(stateKey);
    }
    return cloneConnectorRecord(record);
  }
}
