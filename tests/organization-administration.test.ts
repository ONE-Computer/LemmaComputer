import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { shouldAssignDefaultPolicyOnAuthentication } from "@lemmacomputer/workspace-store";

test("first-time organization members receive the default policy without restoring a revoked returning member", () => {
  assert.equal(shouldAssignDefaultPolicyOnAuthentication(false, false), true);
  assert.equal(shouldAssignDefaultPolicyOnAuthentication(true, false), false);
  assert.equal(shouldAssignDefaultPolicyOnAuthentication(true, true), true);
});

test("connector access policy is additive, tenant-owned, and migration-backed", async () => {
  const migration = await readFile(new URL("../packages/workspace-store/migrations/026_connector_access_policy.sql", import.meta.url), "utf8");
  const store = await readFile(new URL("../packages/workspace-store/src/connector-registry.ts", import.meta.url), "utf8");
  assert.match(migration, /enabled BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(migration, /members_can_manage BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(store, /access_policy_version=access_policy_version\+1/);
  assert.match(store, /WHERE tenant_id=\$1 AND id=\$2/);
});
