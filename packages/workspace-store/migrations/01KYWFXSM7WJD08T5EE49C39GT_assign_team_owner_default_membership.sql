-- id: 01KYWFXSM7WJD08T5EE49C39GT
-- depends-on: 01KYWF9N4BHQHM0HQ77A62XMQW

INSERT INTO allocation_memberships (id,tenant_id,allocation_unit_id,user_id,effective_from,assigned_by)
SELECT gen_random_uuid(),unit.tenant_id,unit.id,unit.owner_user_id,now(),unit.created_by
FROM allocation_units unit
WHERE unit.status='active'
  AND NOT EXISTS (
    SELECT 1 FROM allocation_memberships membership
    WHERE membership.tenant_id=unit.tenant_id
      AND membership.allocation_unit_id=unit.id
      AND membership.user_id=unit.owner_user_id
      AND membership.effective_to IS NULL
  );

WITH candidates AS (
  SELECT unit.*,row_number() OVER (PARTITION BY unit.tenant_id,unit.owner_user_id ORDER BY unit.created_at,unit.id) AS ordinal
  FROM allocation_units unit
  WHERE unit.status='active'
)
INSERT INTO default_spending_team_assignments (id,tenant_id,allocation_unit_id,user_id,effective_from,assigned_by)
SELECT gen_random_uuid(),candidate.tenant_id,candidate.id,candidate.owner_user_id,now(),candidate.created_by
FROM candidates candidate
WHERE candidate.ordinal=1
  AND NOT EXISTS (
    SELECT 1 FROM default_spending_team_assignments assignment
    WHERE assignment.tenant_id=candidate.tenant_id
      AND assignment.user_id=candidate.owner_user_id
      AND assignment.effective_to IS NULL
  );
