-- id: 01KZZC2PF84X2A61A2VMACBDD7
-- depends-on: 01KZZAPYYYWCJNZP9VQ25PFZ7K

-- Versions created under the retired release-signed baseline remain immutable
-- audit history. New organization-owned versions start their own version chain
-- and are the only rows used for active organization enforcement.
ALTER TABLE organization_workspace_policy_versions
  ADD COLUMN enforcement_scope text NOT NULL DEFAULT 'legacy_signed_baseline';

ALTER TABLE organization_workspace_policy_versions
  ALTER COLUMN enforcement_scope SET DEFAULT 'organization';

ALTER TABLE organization_workspace_policy_versions
  ADD CONSTRAINT organization_workspace_policy_versions_enforcement_scope_check
  CHECK (enforcement_scope IN ('legacy_signed_baseline', 'organization'));

ALTER TABLE organization_workspace_policy_versions
  DROP CONSTRAINT organization_workspace_policy_versions_tenant_id_version_key;

ALTER TABLE organization_workspace_policy_versions
  DROP CONSTRAINT organization_workspace_policy_versions_tenant_id_document_hash_key;

ALTER TABLE organization_workspace_policy_versions
  ADD CONSTRAINT organization_workspace_policy_versions_scope_version_key
  UNIQUE (tenant_id, enforcement_scope, version);

ALTER TABLE organization_workspace_policy_versions
  ADD CONSTRAINT organization_workspace_policy_versions_scope_hash_key
  UNIQUE (tenant_id, enforcement_scope, document_hash);

DROP INDEX organization_workspace_policy_versions_latest_idx;

CREATE INDEX organization_workspace_policy_versions_latest_idx
  ON organization_workspace_policy_versions (tenant_id, enforcement_scope, version DESC);
