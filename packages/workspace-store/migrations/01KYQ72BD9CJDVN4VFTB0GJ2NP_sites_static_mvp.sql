-- id: 01KYQ72BD9CJDVN4VFTB0GJ2NP
-- depends-on: 01KYQ071TRQQVWZZFSAG0EFJ3Y

-- Forward-only migration. Add safe, bounded SQL below.

CREATE TABLE sites (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  state text NOT NULL CHECK (state IN ('ready')),
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  source_workspace_id uuid NOT NULL,
  source_agent_id text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, subject_id, slug),
  UNIQUE (id, tenant_id, subject_id)
);

CREATE INDEX sites_owner_updated_idx
  ON sites (tenant_id, subject_id, updated_at DESC);

CREATE TABLE site_revisions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  site_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  artifact_sha256 char(64) NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  content_html text NOT NULL CHECK (octet_length(content_html) BETWEEN 1 AND 524288),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 524288),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, subject_id, site_id, revision),
  FOREIGN KEY (site_id, tenant_id, subject_id)
    REFERENCES sites (id, tenant_id, subject_id)
    ON DELETE CASCADE
);

CREATE INDEX site_revisions_owner_site_idx
  ON site_revisions (tenant_id, subject_id, site_id, revision DESC);
