import pg from "pg";

export type OrganizationRbacBackfillResult = {
  usersBackfilled: number;
  organizationsBackfilled: number;
  remainingUsers: number;
  remainingIdentities: number;
  remainingSessions: number;
};

export const backfillOrganizationRbac = async (
  pool: pg.Pool,
  batchSize = 100,
): Promise<OrganizationRbacBackfillResult> => {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error("organization RBAC backfill batch size must be between 1 and 1000");
  }
  const lock = await pool.connect();
  let usersBackfilled = 0;
  let organizationsBackfilled = 0;
  try {
    await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", ["organization-rbac-backfill-v1"]);
    const organizations = await lock.query(
      `INSERT INTO organizations (id,display_name,status,created_at,updated_at)
       SELECT id,display_name,'active',created_at,created_at FROM tenants
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
    );
    organizationsBackfilled = organizations.rowCount ?? 0;

    while (true) {
      await lock.query("BEGIN");
      try {
        const candidates = await lock.query(
          `SELECT u.id,u.tenant_id,u.email,u.display_name,u.status,u.created_at,u.updated_at,
             EXISTS (
               SELECT 1 FROM user_roles role
               WHERE role.user_id=u.id AND role.role='administrator'
             ) AS was_administrator
           FROM users u
           WHERE u.account_user_id IS NULL
           ORDER BY u.id
           FOR UPDATE SKIP LOCKED
           LIMIT $1`,
          [batchSize],
        );
        if (!candidates.rowCount) {
          await lock.query("COMMIT");
          break;
        }
        for (const candidate of candidates.rows) {
          const account = await lock.query(
            `INSERT INTO account_users (legacy_user_id,status,created_at,updated_at)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (legacy_user_id) DO UPDATE SET legacy_user_id=EXCLUDED.legacy_user_id
             RETURNING id`,
            [candidate.id, candidate.status, candidate.created_at, candidate.updated_at],
          );
          const accountUserId = account.rows[0].id;
          await lock.query("UPDATE users SET account_user_id=$2 WHERE id=$1", [candidate.id, accountUserId]);
          await lock.query(
            `UPDATE external_identities
             SET account_user_id=$2
             WHERE user_id=$1 AND account_user_id IS NULL`,
            [candidate.id, accountUserId],
          );
          const membership = await lock.query(
            `INSERT INTO organization_memberships (
               organization_id,account_user_id,subject_user_id,status,role,
               created_by,updated_by,created_at,updated_at
             ) VALUES ($1,$2,$3,$4,$5,$3,$3,$6,$7)
             ON CONFLICT (organization_id,account_user_id) DO UPDATE
               SET subject_user_id=EXCLUDED.subject_user_id
             RETURNING id`,
            [
              candidate.tenant_id,
              accountUserId,
              candidate.id,
              candidate.status === "active" ? "active" : "suspended",
              candidate.was_administrator ? "owner" : "member",
              candidate.created_at,
              candidate.updated_at,
            ],
          );
          await lock.query(
            `UPDATE browser_sessions
             SET membership_id=$2
             WHERE user_id=$1 AND membership_id IS NULL`,
            [candidate.id, membership.rows[0].id],
          );
          usersBackfilled += 1;
        }
        await lock.query("COMMIT");
      } catch (error) {
        await lock.query("ROLLBACK");
        throw error;
      }
    }

    const verification = await lock.query(
      `SELECT
        (SELECT count(*)::integer FROM users WHERE account_user_id IS NULL) AS remaining_users,
        (SELECT count(*)::integer FROM external_identities WHERE account_user_id IS NULL) AS remaining_identities,
        (SELECT count(*)::integer FROM browser_sessions WHERE membership_id IS NULL) AS remaining_sessions`,
    );
    const result = verification.rows[0];
    return {
      usersBackfilled,
      organizationsBackfilled,
      remainingUsers: Number(result.remaining_users),
      remainingIdentities: Number(result.remaining_identities),
      remainingSessions: Number(result.remaining_sessions),
    };
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", ["organization-rbac-backfill-v1"]).catch(() => undefined);
    lock.release();
  }
};
