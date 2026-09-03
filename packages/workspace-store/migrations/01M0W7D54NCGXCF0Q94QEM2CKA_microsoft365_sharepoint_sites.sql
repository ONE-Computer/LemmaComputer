-- id: 01M0W7D54NCGXCF0Q94QEM2CKA
-- depends-on: 01M0FVF4FWBM708GF5FEQ1EC36

-- Tenant-owned SharePoint site allowlist for the built-in Microsoft 365
-- connector. OAuth credentials remain in LiteLLM; this table stores only the
-- canonical site target and non-secret Graph identifiers learned during an
-- explicit administrator verification.
CREATE TABLE microsoft365_sharepoint_sites (
  tenant_id text NOT NULL,
  id uuid NOT NULL,
  connector_id text NOT NULL DEFAULT 'microsoft-365',
  display_name text NOT NULL,
  site_url text NOT NULL,
  hostname text NOT NULL,
  site_path text NOT NULL,
  graph_site_id text,
  drive_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  last_verified_at timestamptz,
  last_verification_error text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,connector_id)
    REFERENCES connector_registry (tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT microsoft365_sharepoint_sites_connector
    CHECK (connector_id='microsoft-365'),
  CONSTRAINT microsoft365_sharepoint_sites_display_name
    CHECK (char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT microsoft365_sharepoint_sites_url
    CHECK (char_length(site_url) BETWEEN 12 AND 1000),
  CONSTRAINT microsoft365_sharepoint_sites_hostname
    CHECK (char_length(hostname) BETWEEN 1 AND 253 AND hostname=lower(hostname)),
  CONSTRAINT microsoft365_sharepoint_sites_path
    CHECK (char_length(site_path) BETWEEN 1 AND 512 AND site_path NOT LIKE '/%'),
  CONSTRAINT microsoft365_sharepoint_sites_graph_id
    CHECK (graph_site_id IS NULL OR char_length(graph_site_id) BETWEEN 1 AND 1000),
  CONSTRAINT microsoft365_sharepoint_sites_drive_ids
    CHECK (jsonb_typeof(drive_ids)='array'),
  CONSTRAINT microsoft365_sharepoint_sites_status
    CHECK (status IN ('pending','verified','verification_failed')),
  CONSTRAINT microsoft365_sharepoint_sites_verification_state
    CHECK (
      (status='verified' AND graph_site_id IS NOT NULL AND last_verified_at IS NOT NULL AND last_verification_error IS NULL)
      OR status<>'verified'
    ),
  CONSTRAINT microsoft365_sharepoint_sites_error_size
    CHECK (last_verification_error IS NULL OR char_length(last_verification_error)<=320)
);

CREATE UNIQUE INDEX microsoft365_sharepoint_sites_tenant_url_key
  ON microsoft365_sharepoint_sites (tenant_id,site_url);

CREATE UNIQUE INDEX microsoft365_sharepoint_sites_tenant_graph_id_key
  ON microsoft365_sharepoint_sites (tenant_id,graph_site_id)
  WHERE graph_site_id IS NOT NULL;

CREATE INDEX microsoft365_sharepoint_sites_tenant_status_idx
  ON microsoft365_sharepoint_sites (tenant_id,status,display_name,id);
