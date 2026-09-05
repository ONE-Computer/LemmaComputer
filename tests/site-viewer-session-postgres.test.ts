import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { readSiteViewerSession } from "@lemmacomputer/auth-store";

test("site viewer session lookup returns no credentials and follows revocation and verification", { skip: !process.env.SITE_VIEWER_AUTH_TEST_DATABASE_URL }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.SITE_VIEWER_AUTH_TEST_DATABASE_URL });
  const userId = randomUUID(), sessionId = randomUUID();
  try {
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified") VALUES ($1,$2,$3,true)', [userId, "Viewer", `${userId}@example.test`]);
    await pool.query('INSERT INTO "session" (id,"userId",token,"expiresAt","updatedAt") VALUES ($1,$2,$3,now()+interval \'1 hour\',now())', [sessionId, userId, "never-return-this-login-token"]);
    const value = await readSiteViewerSession(pool, sessionId, userId);
    assert.equal(value.user.id, userId);
    assert.equal(value.session.id, sessionId);
    assert.ok(!JSON.stringify(value).includes("never-return-this-login-token"));
    assert.equal(await readSiteViewerSession(pool, sessionId, randomUUID()), null);
    await pool.query('UPDATE "user" SET "emailVerified"=false WHERE id=$1', [userId]);
    assert.equal(await readSiteViewerSession(pool, sessionId, userId), null);
    await pool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [userId]);
    await pool.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [sessionId]);
    assert.equal(await readSiteViewerSession(pool, sessionId, userId), null);
    await pool.query('DELETE FROM "session" WHERE id=$1', [sessionId]);
    assert.equal(await readSiteViewerSession(pool, sessionId, userId), null);
  } finally {
    await pool.query('DELETE FROM "user" WHERE id=$1', [userId]);
    await pool.end();
  }
});
