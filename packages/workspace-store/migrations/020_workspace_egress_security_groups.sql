CREATE TABLE IF NOT EXISTS workspace_egress_security_group_assignments (
  tenant_id text NOT NULL REFERENCES tenants(id),
  subject_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_id text NOT NULL,
  security_group_version_id text NOT NULL REFERENCES egress_security_group_versions(id),
  assigned_by text NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject_id, grant_id)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='workspace_egress_security_group_assignments'
      AND column_name='security_group_version_id'
  )
  AND to_regclass('public.workspace_identities') IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='policy_assignments'
      AND column_name='workspace_identity_id'
  ) THEN
    EXECUTE $migration$
      INSERT INTO workspace_egress_security_group_assignments (
        tenant_id,
        subject_id,
        grant_id,
        security_group_version_id,
        assigned_by,
        assigned_at
      )
      SELECT DISTINCT ON (pa.tenant_id, pa.user_id, wi.grant_id)
        pa.tenant_id,
        pa.user_id,
        wi.grant_id,
        pa.egress_security_group_version_id,
        pa.assigned_by,
        pa.assigned_at
      FROM policy_assignments pa
      JOIN workspace_identities wi ON wi.id=pa.workspace_identity_id
      WHERE pa.revoked_at IS NULL
        AND pa.egress_security_group_version_id IS NOT NULL
      ORDER BY pa.tenant_id, pa.user_id, wi.grant_id, pa.assigned_at DESC
      ON CONFLICT (tenant_id, subject_id, grant_id) DO NOTHING
    $migration$;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='workspace_egress_security_group_assignments'
      AND column_name='security_group_version_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS workspace_egress_security_group_version_idx
      ON workspace_egress_security_group_assignments (security_group_version_id);
  END IF;
END
$$;
