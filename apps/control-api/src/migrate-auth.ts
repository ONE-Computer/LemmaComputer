import { PostgresAuthenticationStore } from "@lemmacomputer/auth-store";

if (!process.env.AUTH_DATABASE_URL) throw new Error("AUTH_DATABASE_URL is required");
const store = await PostgresAuthenticationStore.fromConnectionString(process.env.AUTH_DATABASE_URL);
try {
  const report = await store.migrate();
  process.stdout.write(`${report.applied.length ? `Applied authentication migrations: ${report.applied.join(", ")}` : "Authentication database schema is current; no migrations applied."}\n`);
} finally {
  await store.close();
}
