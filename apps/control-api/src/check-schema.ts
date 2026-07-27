import { PostgresWorkspaceStore } from "@onecomputer/workspace-store";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const store = PostgresWorkspaceStore.fromConnectionString(process.env.DATABASE_URL);
try {
  await store.assertSchemaCompatible();
  process.stdout.write("Database schema is compatible.\n");
} finally {
  await store.close();
}
