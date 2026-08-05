import pg from "pg";
import { backfillOrganizationRbac } from "../packages/workspace-store/src/organization-rbac-backfill.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const batchSize = Number(process.env.ORGANIZATION_RBAC_BACKFILL_BATCH_SIZE ?? "100");
const pool = new pg.Pool({ connectionString, max: 2 });
try {
  const result = await backfillOrganizationRbac(pool, batchSize);
  if (result.remainingUsers || result.remainingIdentities || result.remainingSessions) {
    throw new Error(`organization RBAC backfill is incomplete: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`Organization RBAC backfill complete: ${JSON.stringify(result)}\n`);
} finally {
  await pool.end();
}
