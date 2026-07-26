CREATE TABLE IF NOT EXISTS connector_registry (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  server_name TEXT NOT NULL,
  name TEXT NOT NULL,
  short_description TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Productivity','Developer tools','Communication','Data and analytics','Other')),
  services JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(services) = 'array'),
  endpoint_url TEXT NOT NULL,
  authorization_origins JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(authorization_origins) = 'array'),
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scopes) = 'array'),
  brand TEXT NOT NULL DEFAULT 'generic',
  policy_support TEXT NOT NULL DEFAULT 'automatic' CHECK (policy_support IN ('governed','automatic')),
  source TEXT NOT NULL DEFAULT 'custom' CHECK (source IN ('built-in','custom')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,server_name),
  UNIQUE (tenant_id,server_id)
);

CREATE INDEX IF NOT EXISTS connector_registry_tenant_category_idx
  ON connector_registry (tenant_id,category,name);
