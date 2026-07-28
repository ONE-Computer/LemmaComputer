import { PostgresWorkspaceStore } from "@onecomputer/workspace-store";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const store = PostgresWorkspaceStore.fromConnectionString(process.env.DATABASE_URL);
try {
  const report = await store.migrate();
  const messages = [
    ...(report.baselined ? ["Verified and baselined legacy schema at migration 028."] : []),
    ...(report.applied.length ? [`Applied migrations: ${report.applied.join(", ")}`] : []),
  ];
  process.stdout.write(`${messages.length ? messages.join("\n") : "Database schema is current; no migrations applied."}\n`);
} finally {
  await store.close();
}
