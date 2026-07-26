-- Policy assignments and connector credentials are user-scoped. Workspace
-- authorization is enforced independently through owned workspace lookups and
-- signed per-workspace runtime grants.

WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY user_id
      ORDER BY assigned_at DESC, id DESC
    ) AS active_rank
  FROM policy_assignments
  WHERE revoked_at IS NULL
)
UPDATE policy_assignments assignment
SET revoked_at=now(),
    revoked_by=assignment.assigned_by
FROM ranked
WHERE assignment.id=ranked.id
  AND ranked.active_rank > 1;

DROP INDEX IF EXISTS policy_assignments_one_active_idx;

ALTER TABLE policy_assignments
  DROP COLUMN IF EXISTS workspace_identity_id;

CREATE UNIQUE INDEX policy_assignments_one_active_idx
  ON policy_assignments (user_id)
  WHERE revoked_at IS NULL;

DROP TABLE IF EXISTS workspace_identities;
