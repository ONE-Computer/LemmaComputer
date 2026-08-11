import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import test from "node:test";

type CoverageStatus = "covered" | "not-applicable";

type IsolationResource = {
  store: "authentication" | "control";
  resource: string;
  authority: "better-auth" | "lemmacomputer";
  scope: "account" | "organization" | "platform-operator" | "global";
  scopeKey: string;
  operationProfile: string;
  evidence: string[];
};

type IsolationManifest = {
  schemaVersion: number;
  requiredOperations: string[];
  operationProfiles: Record<string, Record<string, CoverageStatus>>;
  resources: IsolationResource[];
};

const rootUrl = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, rootUrl), "utf8");

const createdTables = (sql: string) => [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?([A-Za-z0-9_]+)"?/g)]
  .map((match) => match[1]!);

test("the tenant isolation manifest owns every persisted authentication and control-plane table", async () => {
  const manifest = JSON.parse(await read("config/tenant-isolation-manifest.json")) as IsolationManifest;
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.requiredOperations, [
    "read", "create", "update", "delete", "list", "search", "export", "stream", "privileged",
  ]);

  const authSql = await Promise.all([
    "packages/auth-store/migrations/001_better_auth_1_6_26.sql",
    "packages/auth-store/migrations/002_database_rate_limits.sql",
    "packages/auth-store/migrations/003_better_auth_sso_1_6_26.sql",
  ].map(read));
  const workspaceMigrationDirectory = new URL("packages/workspace-store/migrations/", rootUrl);
  const workspaceMigrations = (await readdir(workspaceMigrationDirectory))
    .filter((path) => path.endsWith(".sql"))
    .sort()
    .map((path) => `packages/workspace-store/migrations/${path}`);
  const controlSql = await Promise.all(workspaceMigrations.map(read));
  const required = [
    ...authSql.flatMap(createdTables).map((resource) => `authentication:${resource}`),
    ...controlSql.flatMap(createdTables).map((resource) => `control:${resource}`),
  ];
  const declared = manifest.resources.map(({ store, resource }) => `${store}:${resource}`);
  assert.equal(new Set(declared).size, declared.length, "isolation resources must not be declared twice");
  for (const resource of required) {
    assert.equal(declared.includes(resource), true, `missing isolation declaration for ${resource}`);
  }

  for (const resource of manifest.resources) {
    assert.ok(resource.scopeKey.trim(), `${resource.store}:${resource.resource} requires a scope key`);
    const operations = manifest.operationProfiles[resource.operationProfile];
    assert.ok(operations, `${resource.store}:${resource.resource} references an unknown operation profile`);
    assert.deepEqual(Object.keys(operations).sort(), [...manifest.requiredOperations].sort(),
      `${resource.store}:${resource.resource} must classify every operation through its profile`);
    assert.ok(resource.evidence.length > 0, `${resource.store}:${resource.resource} requires test evidence`);
    for (const evidence of resource.evidence) {
      await assert.doesNotReject(access(new URL(evidence, rootUrl)),
        `${resource.store}:${resource.resource} references missing evidence ${evidence}`);
    }
  }

  const activityEvents = manifest.resources.find((resource) => (
    resource.store === "control" && resource.resource === "activity_events"
  ));
  assert.ok(activityEvents, "activity_events requires an isolation declaration");
  assert.equal(
    manifest.operationProfiles[activityEvents.operationProfile]?.stream,
    "covered",
    "the live activity-event resource must classify streaming as a covered tenant-scoped operation",
  );
});

test("the reviewed isolation matrix explains the two-database authority boundary", async () => {
  const matrix = await read("docs/tenant-isolation-matrix.md");
  assert.match(matrix, /# Tenant and authentication isolation matrix/);
  assert.match(matrix, /Better Auth proves who authenticated/);
  assert.match(matrix, /LemmaComputer decides which organization and resources/);
  assert.match(matrix, /read.*create.*update.*delete.*list.*search.*export.*stream.*privileged/is);
  assert.match(matrix, /customer-managed.*exactly one organization/is);
  assert.match(matrix, /config\/tenant-isolation-manifest\.json/);
  assert.match(matrix, /every persisted authentication and control-plane table/i);
});

test("authentication secrets remain outside the product control schema", async () => {
  const workspaceMigrationDirectory = new URL("packages/workspace-store/migrations/", rootUrl);
  const workspaceMigrations = (await readdir(workspaceMigrationDirectory))
    .filter((path) => path.endsWith(".sql"))
    .sort();
  const controlSql = (await Promise.all(workspaceMigrations.map((path) => read(
    `packages/workspace-store/migrations/${path}`,
  )))).join("\n");
  const schemaOnly = controlSql.replace(/^\s*--.*$/gm, "");

  for (const authenticationSecretColumn of [
    "password", "password_hash", "access_token", "refresh_token", "id_token",
    "client_secret", "mfa_secret", "totp_secret", "backup_codes", "passkey",
  ]) {
    assert.doesNotMatch(
      schemaOnly,
      new RegExp(`(?:^|[,\\n]\\s*)"?${authenticationSecretColumn}"?\\s+(?:text|varchar|bytea|jsonb)\\b`, "i"),
      `control schema must not persist Better Auth secret column ${authenticationSecretColumn}`,
    );
  }

  const authSql = (await Promise.all([
    "packages/auth-store/migrations/001_better_auth_1_6_26.sql",
    "packages/auth-store/migrations/002_database_rate_limits.sql",
    "packages/auth-store/migrations/003_better_auth_sso_1_6_26.sql",
  ].map(read))).join("\n");
  for (const productAuthorityTable of [
    "organizations", "organization_memberships", "organization_roles",
    "organization_invitations", "product_sessions", "user_roles", "workspaces",
  ]) {
    assert.doesNotMatch(
      authSql,
      new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+"?${productAuthorityTable}"?`, "i"),
      `authentication schema must not own product authority table ${productAuthorityTable}`,
    );
  }
});
