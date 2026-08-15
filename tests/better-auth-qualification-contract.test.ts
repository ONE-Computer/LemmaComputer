import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const json = async (path: string) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8")) as Record<string, any>;

const lockedWorkspacePackage = (lockfile: Record<string, any>, workspace: string, packageName: string) => {
  const workspacePath = `${workspace}/node_modules/${packageName}`;
  const rootPath = `node_modules/${packageName}`;
  return lockfile.packages[workspacePath] ?? lockfile.packages[rootPath];
};

test("Better Auth core and plugins are exact, matching production pins", async () => {
  const [rootPackage, controlPackage, lockfile, qualification] = await Promise.all([
    json("package.json"),
    json("apps/control-api/package.json"),
    json("package-lock.json"),
    json("config/better-auth-qualification.json"),
  ]);
  assert.equal(controlPackage.dependencies["better-auth"], "1.6.26");
  assert.equal(controlPackage.dependencies["@better-auth/passkey"], "1.6.26");
  assert.equal(controlPackage.dependencies["@better-auth/sso"], "1.6.26");
  assert.equal(lockedWorkspacePackage(lockfile, "apps/control-api", "better-auth")?.version, "1.6.26");
  assert.equal(lockedWorkspacePackage(lockfile, "apps/control-api", "@better-auth/passkey")?.version, "1.6.26");
  assert.equal(lockedWorkspacePackage(lockfile, "apps/control-api", "@better-auth/sso")?.version, "1.6.26");
  assert.deepEqual(qualification.packages, {
    "better-auth": "1.6.26",
    "@better-auth/passkey": "1.6.26",
    "@better-auth/sso": "1.6.26",
  });
  assert.equal(rootPackage.scripts["qualify:better-auth"], "npm run qualify:better-auth -w @lemmacomputer/control-api");
  assert.equal(controlPackage.scripts["qualify:better-auth"], "node scripts/qualify-better-auth.mjs");
});

test("the qualification contract keeps authentication and product authority operationally separate", async () => {
  const qualification = await json("config/better-auth-qualification.json");
  assert.equal(qualification.schemaVersion, 1);
  assert.equal(qualification.mount.routeNamespace, "/api/v1/auth/customer");
  assert.equal(qualification.mount.component, "control-api");
  assert.equal(qualification.mount.applicationStartupRunsMigrations, false);
  assert.notEqual(qualification.databases.authentication.name, qualification.databases.productControl.name);
  assert.notEqual(qualification.databases.authentication.runtimeRole, qualification.databases.authentication.migrationRole);
  assert.notEqual(qualification.databases.authentication.runtimeRole, qualification.databases.productControl.runtimeRole);
  assert.equal(qualification.databases.crossDatabaseForeignKeys, false);
  assert.equal(qualification.authorization.providerClaims, "non-authoritative");
  assert.equal(qualification.authorization.activeOrganizationSource, "server-resolved-product-membership");
});

test("qualification gates cover every issue #51 security and recovery boundary", async () => {
  const qualification = await json("config/better-auth-qualification.json");
  const required = new Set(qualification.requiredGates);
  for (const gate of [
    "email-verification-and-reset",
    "totp-backup-codes-and-recovery",
    "passkeys",
    "social-login-and-dual-proof-linking",
    "session-and-product-context-revocation",
    "invitation-admission",
    "multi-organization-selection",
    "enterprise-sso-and-lockout-recovery",
    "customer-managed-offline-independence",
    "proxy-origin-csrf-and-rate-limits",
    "audit-and-secret-redaction",
    "auth-database-backup-restore",
    "encryption-key-rotation",
    "dependency-upgrade-and-rollback",
    "cross-tenant-adversarial-isolation",
  ]) {
    assert.equal(required.has(gate), true, `missing qualification gate: ${gate}`);
  }
  assert.deepEqual(qualification.releasePolicy, {
    upgrade: "review-generated-schema-and-run-all-gates",
    rollback: "code-only-when-schema-compatible-otherwise-forward-fix",
  });
});

test("ADR 0004 records the complete issue #51 threat and operability decision", async () => {
  const adr = await readFile(new URL("../docs/adr/0004-better-auth-adoption-and-qualification.md", import.meta.url), "utf8");
  for (const required of [
    "# ADR 0004: Better Auth adoption and qualification",
    "better-auth` `1.6.26",
    "@better-auth/sso` `1.6.26",
    "## Trust boundaries and data flow",
    "## Provider-neutral contracts",
    "## Authentication database and migration operations",
    "## Account and session mapping",
    "## Threat model",
    "## Recovery, linking, and elevation",
    "## Failure and incident response",
    "## Expand, migrate, contract",
    "## Qualification and evidence",
  ]) {
    assert.match(adr, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(adr, /email, domain, provider groups, and provider administrator claims are\s+non-authoritative/i);
  assert.match(adr, /application startup never migrates/i);
  assert.match(adr, /customer-managed.*no required LemmaComputer-hosted identity dependency/is);
});
