import pg from "pg";
import type { McpToolPolicyDecision } from "@onecomputer/contracts";

export type ConnectorCategory = "Productivity" | "Developer tools" | "Business" | "Communication" | "Data and analytics" | "Other";

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
  enabled: boolean;
  membersCanManage: boolean;
  accessPolicyVersion: number;
  accessPolicyUpdatedBy: string | null;
  accessPolicyUpdatedAt: Date;
  brand: string;
  iconDataUrl: string | null;
  policySupport: "governed" | "automatic";
  source: "built-in" | "custom";
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SaveConnectorRegistryRecord = Omit<
  ConnectorRegistryRecord,
  "createdAt" | "updatedAt" | "toolPolicies" | "iconDataUrl" | "enabled" | "membersCanManage" | "accessPolicyVersion" | "accessPolicyUpdatedBy" | "accessPolicyUpdatedAt"
> & {
  toolPolicies?: Record<string, McpToolPolicyDecision>;
  iconDataUrl?: string | null;
  enabled?: boolean;
  membersCanManage?: boolean;
};

export interface ConnectorRegistryStore {
  seedConnectors(tenantId: string, connectors: SaveConnectorRegistryRecord[]): Promise<void>;
  listConnectors(tenantId: string): Promise<ConnectorRegistryRecord[]>;
  getConnector(tenantId: string, connectorId: string): Promise<ConnectorRegistryRecord | null>;
  listConnectionStates(tenantId: string, subjectId: string): Promise<ConnectorConnectionStateRecord[]>;
  getConnectionState(tenantId: string, subjectId: string, connectorId: string): Promise<ConnectorConnectionStateRecord | null>;
  saveConnectionState(record: SaveConnectorConnectionStateRecord): Promise<ConnectorConnectionStateRecord>;
  deleteConnectionState(tenantId: string, subjectId: string, connectorId: string): Promise<boolean>;
  saveConnector(record: SaveConnectorRegistryRecord): Promise<ConnectorRegistryRecord>;
  updateAccessPolicy(tenantId: string, connectorId: string, input: { enabled: boolean; membersCanManage: boolean; updatedBy: string }): Promise<ConnectorRegistryRecord | null>;
  updateToolPolicies(tenantId: string, connectorId: string, tools: Record<string, McpToolPolicyDecision>): Promise<ConnectorRegistryRecord | null>;
  updateIcon(tenantId: string, connectorId: string, iconDataUrl: string | null): Promise<ConnectorRegistryRecord | null>;
  deleteConnector(tenantId: string, connectorId: string): Promise<ConnectorRegistryRecord | null>;
}

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
  toolPolicies: row.tool_policies && typeof row.tool_policies === "object" && !Array.isArray(row.tool_policies)
    ? row.tool_policies as Record<string, McpToolPolicyDecision>
    : {},
  enabled: row.enabled !== false,
  membersCanManage: row.members_can_manage !== false,
  accessPolicyVersion: Number(row.access_policy_version ?? 1),
  accessPolicyUpdatedBy: typeof row.access_policy_updated_by === "string" ? row.access_policy_updated_by : null,
  accessPolicyUpdatedAt: new Date(String(row.access_policy_updated_at ?? row.updated_at)),
  brand: String(row.brand),
  iconDataUrl: typeof row.icon_data_url === "string" ? row.icon_data_url : null,
  policySupport: row.policy_support as ConnectorRegistryRecord["policySupport"],
  source: row.source as ConnectorRegistryRecord["source"],
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
          endpoint_url,authorization_origins,scopes,tool_policies,brand,icon_data_url,policy_support,source,created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18)
        ON CONFLICT (tenant_id,id) DO UPDATE SET
          server_id=EXCLUDED.server_id,
          server_name=EXCLUDED.server_name,
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

  async saveConnector(record: SaveConnectorRegistryRecord) {
    const result = await this.pool.query(
      `INSERT INTO connector_registry (
        tenant_id,id,server_id,server_name,name,short_description,description,category,services,
        endpoint_url,authorization_origins,scopes,tool_policies,brand,icon_data_url,policy_support,source,created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18)
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

  async updateToolPolicies(tenantId: string, connectorId: string, tools: Record<string, McpToolPolicyDecision>) {
    const result = await this.pool.query(
      "UPDATE connector_registry SET tool_policies=$3::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
      [tenantId, connectorId, JSON.stringify(tools)],
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
  private key(tenantId: string, connectorId: string) { return `${tenantId}:${connectorId}`; }
  private connectionStateKey(tenantId: string, subjectId: string, connectorId: string) { return `${tenantId}\u0000${subjectId}\u0000${connectorId}`; }

  async seedConnectors(_tenantId: string, connectors: SaveConnectorRegistryRecord[]) {
    for (const connector of connectors) {
      const key = this.key(connector.tenantId, connector.id);
      const current = this.records.get(key);
      if (!current) await this.saveConnector(connector);
      else if (current.source === "built-in") {
        this.records.set(key, { ...current, ...connector, toolPolicies: current.toolPolicies, updatedAt: new Date() });
      }
    }
  }

  async listConnectors(tenantId: string) {
    return [...this.records.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((left, right) => left.category.localeCompare(right.category) || left.name.localeCompare(right.name));
  }

  async getConnector(tenantId: string, connectorId: string) {
    return this.records.get(this.key(tenantId, connectorId)) ?? null;
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

  async saveConnector(record: SaveConnectorRegistryRecord) {
    const key = this.key(record.tenantId, record.id);
    if (this.records.has(key)) throw new Error("Connector already exists");
    const now = new Date();
    const saved = {
      ...record,
      toolPolicies: record.toolPolicies ?? {},
      iconDataUrl: record.iconDataUrl ?? null,
      enabled: record.enabled ?? true,
      membersCanManage: record.membersCanManage ?? true,
      accessPolicyVersion: 1,
      accessPolicyUpdatedBy: null,
      accessPolicyUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(key, saved);
    return saved;
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
    this.records.set(key, saved);
    return saved;
  }

  async updateToolPolicies(tenantId: string, connectorId: string, tools: Record<string, McpToolPolicyDecision>) {
    const key = this.key(tenantId, connectorId);
    const record = this.records.get(key);
    if (!record) return null;
    const saved = { ...record, toolPolicies: { ...tools }, updatedAt: new Date() };
    this.records.set(key, saved);
    return saved;
  }

  async updateIcon(tenantId: string, connectorId: string, iconDataUrl: string | null) {
    const key = this.key(tenantId, connectorId);
    const record = this.records.get(key);
    if (!record || record.source !== "custom") return null;
    const saved = { ...record, iconDataUrl, updatedAt: new Date() };
    this.records.set(key, saved);
    return saved;
  }

  async deleteConnector(tenantId: string, connectorId: string) {
    const key = this.key(tenantId, connectorId);
    const record = this.records.get(key);
    if (!record || record.source !== "custom") return null;
    this.records.delete(key);
    for (const [stateKey, state] of this.connectionStates) {
      if (state.tenantId === tenantId && state.connectorId === connectorId) this.connectionStates.delete(stateKey);
    }
    return record;
  }
}
