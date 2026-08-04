import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { IdentityContext } from "@lemmacomputer/contracts";
import { PostgresWorkspaceStore } from "@lemmacomputer/workspace-store";

const connectionString = process.env.WORKSPACE_SETTINGS_TEST_DATABASE_URL;

test("PostgreSQL workspace settings persist governed Auto and reject unknown model aliases", {
  skip: !connectionString,
}, async () => {
  const store = PostgresWorkspaceStore.fromConnectionString(connectionString!);
  const pool = new pg.Pool({ connectionString });
  const identity: IdentityContext = {
    tenantId: `workspace-settings-test-${randomUUID()}`,
    subjectId: "owner",
    audience: "lemmacomputer-control",
  };
  const grantId = "workspace-project-workspace";
  try {
    await store.migrate();
    const saved = await store.saveSandboxSettings(identity, {
      grantId,
      profileId: "disposable-open-v1",
      applicationIds: ["google-chrome"],
      modelAlias: "lemmacomputer-auto",
      requestedServiceClass: "auto",
      agentIds: ["claude-desktop", "claude-cli"],
    });
    assert.equal(saved.modelAlias, "lemmacomputer-auto");
    assert.equal((await store.getSandboxSettings(identity, grantId))?.modelAlias, "lemmacomputer-auto");
    await assert.rejects(
      pool.query(
        `UPDATE sandbox_settings SET model_alias='lemmacomputer-unknown' WHERE tenant_id=$1 AND subject_id=$2 AND grant_id=$3`,
        [identity.tenantId, identity.subjectId, grantId],
      ),
      /sandbox_settings_model_alias_check/,
    );
  } finally {
    await pool.query("DELETE FROM sandbox_settings WHERE tenant_id=$1", [identity.tenantId]);
    await Promise.all([store.close(), pool.end()]);
  }
});
