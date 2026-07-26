import pg from "pg";

export type ConnectorCategory = "Productivity" | "Developer tools" | "Communication" | "Data and analytics" | "Other";

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
  brand: string;
  policySupport: "governed" | "automatic";
  source: "built-in" | "custom";
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SaveConnectorRegistryRecord = Omit<ConnectorRegistryRecord, "createdAt" | "updatedAt">;

export interface ConnectorRegistryStore {
  seedConnectors(tenantId: string, connectors: SaveConnectorRegistryRecord[]): Promise<void>;
  listConnectors(tenantId: string): Promise<ConnectorRegistryRecord[]>;
  getConnector(tenantId: string, connectorId: string): Promise<ConnectorRegistryRecord | null>;
  saveConnector(record: SaveConnectorRegistryRecord): Promise<ConnectorRegistryRecord>;
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
  brand: String(row.brand),
  policySupport: row.policy_support as ConnectorRegistryRecord["policySupport"],
  source: row.source as ConnectorRegistryRecord["source"],
  createdBy: String(row.created_by),
  createdAt: new Date(String(row.created_at)),
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
  record.brand,
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
          endpoint_url,authorization_origins,scopes,brand,policy_support,source,created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16)
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

  async saveConnector(record: SaveConnectorRegistryRecord) {
    const result = await this.pool.query(
      `INSERT INTO connector_registry (
        tenant_id,id,server_id,server_name,name,short_description,description,category,services,
        endpoint_url,authorization_origins,scopes,brand,policy_support,source,created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16)
      RETURNING *`,
      values(record),
    );
    return mapRow(result.rows[0]);
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
  private key(tenantId: string, connectorId: string) { return `${tenantId}:${connectorId}`; }

  async seedConnectors(_tenantId: string, connectors: SaveConnectorRegistryRecord[]) {
    for (const connector of connectors) {
      const key = this.key(connector.tenantId, connector.id);
      const current = this.records.get(key);
      if (!current) await this.saveConnector(connector);
      else if (current.source === "built-in") {
        this.records.set(key, { ...current, ...connector, updatedAt: new Date() });
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

  async saveConnector(record: SaveConnectorRegistryRecord) {
    const key = this.key(record.tenantId, record.id);
    if (this.records.has(key)) throw new Error("Connector already exists");
    const now = new Date();
    const saved = { ...record, createdAt: now, updatedAt: now };
    this.records.set(key, saved);
    return saved;
  }

  async deleteConnector(tenantId: string, connectorId: string) {
    const key = this.key(tenantId, connectorId);
    const record = this.records.get(key);
    if (!record || record.source !== "custom") return null;
    this.records.delete(key);
    return record;
  }
}
