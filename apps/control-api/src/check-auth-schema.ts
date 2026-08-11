import { PostgresAuthenticationStore } from "@lemmacomputer/auth-store";

if (!process.env.AUTH_DATABASE_URL) throw new Error("AUTH_DATABASE_URL is required");
const store = await PostgresAuthenticationStore.fromConnectionString(process.env.AUTH_DATABASE_URL);
try {
  await store.assertSchemaCompatible();
  process.stdout.write("Authentication database schema is compatible.\n");
} finally {
  await store.close();
}
