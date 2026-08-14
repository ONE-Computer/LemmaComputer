-- id: 01M00D3M7EHG3KTDDH1V03CN2Q
-- depends-on: 01KZZC2PF84X2A61A2VMACBDD7

ALTER TABLE egress_security_groups
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by text REFERENCES users(id);

CREATE INDEX egress_security_groups_active_tenant_idx
  ON egress_security_groups (tenant_id, updated_at DESC)
  WHERE archived_at IS NULL;
