import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { IdentityContext } from "@lemmacomputer/contracts";
import { MemoryWorkspaceStore, PostgresWorkspaceStore, type WorkspaceStore } from "@lemmacomputer/workspace-store";

const connectionString = process.env.WORKSPACE_SETTINGS_TEST_DATABASE_URL;

for (const backend of ["memory", "postgres"] as const) {
  test(`${backend} status reconciliation fences ownership, generation, lifecycle operations and deletion`, {
    skip: backend === "postgres" && !connectionString,
  }, async () => {
    const postgres = backend === "postgres" ? PostgresWorkspaceStore.fromConnectionString(connectionString!) : null;
    const pool = postgres ? new pg.Pool({ connectionString }) : null;
    const store: WorkspaceStore = postgres ?? new MemoryWorkspaceStore();
    const identity: IdentityContext = {
      tenantId: `status-fence-${randomUUID()}`, subjectId: "owner", audience: "lemmacomputer-control",
    };
    let workspaceId: string | undefined;
    try {
      if (postgres) await postgres.migrate();
      if (pool) {
        await pool.query("INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$1,'Status reconciliation test')", [identity.tenantId]);
        await pool.query("INSERT INTO organizations (id,display_name) VALUES ($1,'Status reconciliation test')", [identity.tenantId]);
      }
      const created = await store.createOrGet(identity, "personal", "status-fence-create");
      workspaceId = created.id;
      const observed = await store.update(created.id, { state: "ready", providerId: "provider-original" });
      assert.deepEqual(await store.reconcile(observed, {
        state: observed.state, providerId: observed.providerId, failureCode: observed.failureCode,
      }), observed, "unchanged polling must not rewrite timestamps");
      const stopped = { state: "stopped" as const, providerId: null, failureCode: null };
      for (const wrongObservation of [
        { ...observed, tenantId: "foreign-tenant" },
        { ...observed, subjectId: "foreign-owner" },
        { ...observed, providerId: "foreign-provider" },
        { ...observed, accessGeneration: observed.accessGeneration + 1 },
        { ...observed, state: "open" as const },
      ]) {
        assert.equal(await store.reconcile(wrongObservation, stopped), null);
        assert.equal(await store.claim(created.id, ["ready"], "stopping", wrongObservation), null);
      }
      assert.deepEqual(await store.getOwned(identity, created.id), observed);

      const claimed = await store.claim(created.id, ["ready"], "restarting");
      assert.ok(claimed);
      assert.equal(await store.reconcile(observed, stopped), null);
      assert.equal(await store.reconcile(claimed, stopped), null, "polling cannot finish the owning operation");
      await store.revokeAccessGrants(created.id);
      // Reuse the provider ID to prove that generation fencing is independent.
      const replacement = await store.finish(created.id, claimed.operationToken!, { state: "ready" });
      assert.equal(await store.reconcile(observed, stopped), null);
      assert.deepEqual(await store.getOwned(identity, created.id), replacement);
      assert.equal(await store.claim(created.id, ["ready"], "stopping", observed), null);
      const accepted = await store.reconcile(replacement, stopped);
      assert.equal(accepted?.state, "stopped");
      assert.equal(accepted?.providerId, null);
      assert.equal(accepted?.accessGeneration, replacement.accessGeneration);
      assert.ok(accepted);
      const validClaim = await store.claim(created.id, ["stopped"], "provisioning", accepted);
      assert.ok(validClaim, "a current observation may claim the lifecycle");
      assert.equal(await store.expireOperation(validClaim, new Date(validClaim.updatedAt.getTime() - 1)), null);
      // PostgreSQL row mapping currently has second precision.
      const cutoff = new Date(validClaim.updatedAt.getTime() + 1_000);
      for (const wrong of [
        { ...validClaim, tenantId: "foreign" },
        { ...validClaim, subjectId: "foreign" },
        { ...validClaim, operationToken: randomUUID() },
        { ...validClaim, accessGeneration: validClaim.accessGeneration + 1 },
        { ...validClaim, providerId: "foreign" },
        { ...validClaim, state: "restarting" as const },
      ]) assert.equal(await store.expireOperation(wrong, cutoff), null);
      const expired = await store.expireOperation(validClaim, cutoff);
      assert.equal(expired?.failureCode, "WORKSPACE_OPERATION_INTERRUPTED");
      assert.equal(expired?.operationToken, null);
      assert.equal(expired?.accessGeneration, validClaim.accessGeneration + 1);
      await assert.rejects(store.finish(created.id, validClaim.operationToken!, stopped));
      await assert.rejects(store.revokeAccessGrants(created.id, validClaim.operationToken!));
      assert.deepEqual(await store.getOwned(identity, created.id), expired);
      await store.update(created.id, stopped);
      await store.tombstone(identity, created.id, "preserve");
      assert.equal(await store.reconcile(accepted, { ...stopped, state: "ready" }), null);
      assert.equal(await store.getOwned(identity, created.id), null);
    } finally {
      if (postgres && pool) {
        try {
          if (workspaceId) await pool.query("DELETE FROM workspaces WHERE id=$1 AND tenant_id=$2", [workspaceId, identity.tenantId]);
          await pool.query("DELETE FROM organizations WHERE id=$1", [identity.tenantId]);
          await pool.query("DELETE FROM tenants WHERE id=$1", [identity.tenantId]);
        } finally {
          await Promise.all([pool.end(), postgres.close()]);
        }
      }
    }
  });
}

test("PostgreSQL workspace settings persist AI-enabled and base workspace selections", {
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
      applicationIds: ["firefox", "google-chrome"],
      modelAlias: "lemmacomputer-auto",
      requestedServiceClass: "auto",
      agentIds: ["claude-desktop", "claude-cli"],
    });
    assert.equal(saved.modelAlias, "lemmacomputer-auto");
    const persisted = await store.getSandboxSettings(identity, grantId);
    assert.equal(persisted?.modelAlias, "lemmacomputer-auto");
    assert.deepEqual(persisted?.applicationIds, ["firefox", "google-chrome"]);

    const baseGrantId = "workspace-base-without-capabilities";
    const base = await store.saveSandboxSettings(identity, {
      grantId: baseGrantId,
      profileId: "claude-desktop-standard-v1",
      applicationIds: [],
      modelAlias: null,
      requestedServiceClass: "balanced",
      agentIds: [],
    });
    assert.deepEqual(base.applicationIds, []);
    assert.deepEqual(base.agentIds, []);
    assert.equal(base.modelAlias, null);
    assert.deepEqual(await store.getSandboxSettings(identity, baseGrantId), base);

    await assert.rejects(
      pool.query(
        `UPDATE sandbox_settings SET model_alias='lemmacomputer-claude' WHERE tenant_id=$1 AND subject_id=$2 AND grant_id=$3`,
        [identity.tenantId, identity.subjectId, baseGrantId],
      ),
      /sandbox_settings_agent_model_pair/,
    );
    await assert.rejects(
      pool.query(
        `UPDATE sandbox_settings SET agent_ids='["claude-cli"]'::jsonb WHERE tenant_id=$1 AND subject_id=$2 AND grant_id=$3`,
        [identity.tenantId, identity.subjectId, baseGrantId],
      ),
      /sandbox_settings_agent_model_pair/,
    );
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
