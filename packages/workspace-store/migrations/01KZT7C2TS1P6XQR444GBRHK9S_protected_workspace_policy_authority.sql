-- id: 01KZT7C2TS1P6XQR444GBRHK9S
-- depends-on: 01KZP5PQK4ZC0B1WG1HD8RWV0A

-- Product-owned baselines are copied into each tenant as an immutable signed
-- release fact. This keeps hosted and customer-managed installations on the
-- same tenant-scoped schema without letting organization policy rewrite the
-- product release envelope.
CREATE TABLE protected_policy_templates (
  tenant_id text NOT NULL REFERENCES tenants(id),
  template_id text NOT NULL CHECK (template_id ~ '^pbt_[a-z0-9][a-z0-9_]{2,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,template_id)
);

CREATE TABLE protected_policy_template_versions (
  tenant_id text NOT NULL,
  template_id text NOT NULL,
  template_version_id text NOT NULL CHECK (template_version_id ~ '^pbtv_[a-z0-9][a-z0-9_]{2,95}$'),
  version integer NOT NULL CHECK (version > 0),
  supersedes_template_version_id text,
  release_id text NOT NULL CHECK (length(trim(release_id)) BETWEEN 1 AND 64),
  source_commit text NOT NULL CHECK (source_commit ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'),
  published_at timestamptz NOT NULL,
  key_id text NOT NULL CHECK (key_id ~ '^prk_[a-z0-9][a-z0-9_]{2,63}$'),
  document_hash text NOT NULL CHECK (document_hash ~ '^[a-f0-9]{64}$'),
  envelope_digest text NOT NULL CHECK (envelope_digest ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  signed_envelope jsonb NOT NULL CHECK (jsonb_typeof(signed_envelope)='object'),
  installed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,template_version_id),
  UNIQUE (tenant_id,template_id,version),
  UNIQUE (tenant_id,template_id,template_version_id),
  UNIQUE (tenant_id,envelope_digest),
  FOREIGN KEY (tenant_id,template_id)
    REFERENCES protected_policy_templates(tenant_id,template_id),
  FOREIGN KEY (tenant_id,template_id,supersedes_template_version_id)
    REFERENCES protected_policy_template_versions(tenant_id,template_id,template_version_id),
  CHECK (
    (version=1 AND supersedes_template_version_id IS NULL)
    OR (version>1 AND supersedes_template_version_id IS NOT NULL)
  )
);

CREATE TABLE organization_workspace_policy_versions (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  previous_policy_version_id uuid,
  document_hash text NOT NULL CHECK (document_hash ~ '^[a-f0-9]{64}$'),
  constraints jsonb NOT NULL CHECK (jsonb_typeof(constraints)='object'),
  revision_note text NOT NULL CHECK (length(trim(revision_note)) BETWEEN 3 AND 240),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,version),
  UNIQUE (tenant_id,document_hash),
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,previous_policy_version_id)
    REFERENCES organization_workspace_policy_versions(tenant_id,id),
  CHECK (
    (version=1 AND previous_policy_version_id IS NULL)
    OR (version>1 AND previous_policy_version_id IS NOT NULL)
  )
);
CREATE INDEX organization_workspace_policy_versions_latest_idx
  ON organization_workspace_policy_versions (tenant_id,version DESC);

-- Member selection changes are append-only versions. A revoke is another
-- immutable row, so the exact baseline, overlay, and selection used before the
-- revoke remain available for audit and later runtime projection.
CREATE TABLE member_workspace_policy_assignment_versions (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  subject_id text NOT NULL,
  assignment_version integer NOT NULL CHECK (assignment_version > 0),
  previous_assignment_id uuid,
  state text NOT NULL CHECK (state IN ('selected','revoked')),
  protected_template_version_id text NOT NULL,
  organization_policy_version_id uuid,
  selection jsonb NOT NULL CHECK (jsonb_typeof(selection)='object'),
  selection_hash text NOT NULL CHECK (selection_hash ~ '^[a-f0-9]{64}$'),
  assigned_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,subject_id,assignment_version),
  UNIQUE (tenant_id,subject_id,id),
  UNIQUE (tenant_id,subject_id,previous_assignment_id),
  FOREIGN KEY (tenant_id,subject_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,assigned_by) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,protected_template_version_id)
    REFERENCES protected_policy_template_versions(tenant_id,template_version_id),
  FOREIGN KEY (tenant_id,organization_policy_version_id)
    REFERENCES organization_workspace_policy_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,subject_id,previous_assignment_id)
    REFERENCES member_workspace_policy_assignment_versions(tenant_id,subject_id,id),
  CHECK (
    (assignment_version=1 AND previous_assignment_id IS NULL)
    OR (assignment_version>1 AND previous_assignment_id IS NOT NULL)
  )
);
CREATE INDEX member_workspace_policy_assignment_versions_latest_idx
  ON member_workspace_policy_assignment_versions (tenant_id,subject_id,assignment_version DESC);

CREATE OR REPLACE FUNCTION lemmacomputer_reject_protected_policy_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Protected workspace policy history rows are immutable';
END;
$$;

CREATE TRIGGER protected_policy_templates_immutable
  BEFORE UPDATE OR DELETE ON protected_policy_templates
  FOR EACH ROW EXECUTE FUNCTION lemmacomputer_reject_protected_policy_history_mutation();
CREATE TRIGGER protected_policy_template_versions_immutable
  BEFORE UPDATE OR DELETE ON protected_policy_template_versions
  FOR EACH ROW EXECUTE FUNCTION lemmacomputer_reject_protected_policy_history_mutation();
CREATE TRIGGER organization_workspace_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON organization_workspace_policy_versions
  FOR EACH ROW EXECUTE FUNCTION lemmacomputer_reject_protected_policy_history_mutation();
CREATE TRIGGER member_workspace_policy_assignment_versions_immutable
  BEFORE UPDATE OR DELETE ON member_workspace_policy_assignment_versions
  FOR EACH ROW EXECUTE FUNCTION lemmacomputer_reject_protected_policy_history_mutation();
