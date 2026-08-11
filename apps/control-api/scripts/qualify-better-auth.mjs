import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { betterAuth } from "better-auth";
import { passkey } from "@better-auth/passkey";
import { sso, validateDiscoveryUrl, validateSAMLTimestamp } from "@better-auth/sso";

const repositoryRoot = new URL("../../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, repositoryRoot), "utf8"));

const [rootPackage, controlPackage, lockfile, qualification] = await Promise.all([
  readJson("package.json"),
  readJson("apps/control-api/package.json"),
  readJson("package-lock.json"),
  readJson("config/better-auth-qualification.json"),
]);

for (const [packageName, expectedVersion] of Object.entries(qualification.packages)) {
  assert.equal(controlPackage.dependencies[packageName], expectedVersion, `${packageName} must be an exact Control API dependency`);
  const lockPath = `apps/control-api/node_modules/${packageName}`;
  assert.equal(lockfile.packages[lockPath]?.version, expectedVersion, `${packageName} lockfile version must match qualification contract`);
}

assert.equal(rootPackage.scripts["qualify:better-auth"], "npm run qualify:better-auth -w @lemmacomputer/control-api");
assert.equal(qualification.mount.component, "control-api");
assert.equal(qualification.mount.routeNamespace, "/api/v1/auth/customer");
assert.equal(qualification.mount.applicationStartupRunsMigrations, false);
assert.equal(qualification.databases.crossDatabaseForeignKeys, false);
assert.equal(qualification.authorization.providerClaims, "non-authoritative");
assert.equal(qualification.authorization.implicitEmailLinking, false);
assert.equal(typeof betterAuth, "function", "Better Auth core entrypoint must load");
assert.equal(typeof passkey, "function", "Better Auth passkey plugin entrypoint must load");
assert.equal(typeof sso, "function", "Better Auth SSO plugin entrypoint must load");
assert.equal(typeof validateDiscoveryUrl, "function", "SSO discovery validation entrypoint must load");
assert.equal(typeof validateSAMLTimestamp, "function", "SSO timestamp validation entrypoint must load");

console.log(JSON.stringify({
  status: "passed",
  packages: qualification.packages,
  routeNamespace: qualification.mount.routeNamespace,
  requiredGateCount: qualification.requiredGates.length,
}));
