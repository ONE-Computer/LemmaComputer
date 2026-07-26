ALTER TABLE workspace_egress_security_group_assignments
  ADD COLUMN IF NOT EXISTS security_group_id text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='workspace_egress_security_group_assignments'
      AND column_name='security_group_version_id'
  ) THEN
    EXECUTE $migration$
      UPDATE workspace_egress_security_group_assignments assignment
      SET security_group_id=version.security_group_id
      FROM egress_security_group_versions version
      WHERE assignment.security_group_id IS NULL
        AND version.id=assignment.security_group_version_id
    $migration$;
  END IF;
END
$$;

ALTER TABLE workspace_egress_security_group_assignments
  ALTER COLUMN security_group_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='workspace_egress_security_group_assignments_group_fk'
  ) THEN
    ALTER TABLE workspace_egress_security_group_assignments
      ADD CONSTRAINT workspace_egress_security_group_assignments_group_fk
      FOREIGN KEY (security_group_id) REFERENCES egress_security_groups(id);
  END IF;
END
$$;

DROP INDEX IF EXISTS workspace_egress_security_group_version_idx;

ALTER TABLE workspace_egress_security_group_assignments
  DROP COLUMN IF EXISTS security_group_version_id;

CREATE INDEX IF NOT EXISTS workspace_egress_security_group_idx
  ON workspace_egress_security_group_assignments (security_group_id);
