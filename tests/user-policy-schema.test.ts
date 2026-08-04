import { discoverWorkspaceMigrations } from "@lemmacomputer/workspace-store";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("policy assignments are user-scoped in both fresh and upgraded databases", async () => {
  const [foundation, cleanup, identityPolicy, migrations] = await Promise.all([
    source("packages/workspace-store/migrations/004_identity_policy.sql"),
    source("packages/workspace-store/migrations/025_user_scoped_policy_assignments.sql"),
    source("packages/workspace-store/src/identity-policy.ts"),
    discoverWorkspaceMigrations(),
  ]);

  assert.doesNotMatch(foundation, /workspace_identities|workspace_identity_id/);
  assert.match(foundation, /ON policy_assignments \(user_id\)\s+WHERE revoked_at IS NULL/);
  assert.match(cleanup, /DROP COLUMN IF EXISTS workspace_identity_id/);
  assert.match(cleanup, /DROP TABLE IF EXISTS workspace_identities/);
  assert.match(cleanup, /PARTITION BY user_id/);
  assert.ok(migrations.some((migration) => migration.fileName === "025_user_scoped_policy_assignments.sql"));
  assert.doesNotMatch(identityPolicy, /workspaceIdentityId|workspace_identity_id|workspace_identities/);
});
