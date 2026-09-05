import type pg from "pg";

// Only a verified, narrowly scoped site-asset grant may call this lookup.
// Never return the session bearer token, OAuth credentials, or MFA secrets.
export async function readSiteViewerSession(pool: Pick<pg.Pool, "query">, sessionId: string, accountUserId: string) {
  const result = await pool.query(`SELECT
    json_build_object('id', s.id, 'userId', s."userId", 'expiresAt', s."expiresAt") AS session,
    json_build_object('id', u.id, 'email', u.email, 'name', u.name, 'emailVerified', u."emailVerified") AS "user"
    FROM "session" s JOIN "user" u ON u.id = s."userId"
    WHERE s.id = $1::uuid AND s."userId" = $2::uuid AND s."expiresAt" > now() AND u."emailVerified" = true`,
  [sessionId, accountUserId]);
  return result.rows[0] ?? null;
}
