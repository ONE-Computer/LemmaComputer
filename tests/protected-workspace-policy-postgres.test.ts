import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresProtectedWorkspacePolicyStore } from "@lemmacomputer/workspace-store";
import { ProtectedWorkspacePolicyAdministrationService } from "../apps/control-api/src/protected-workspace-policy.js";

const connectionString = process.env.POLICY_TEST_DATABASE_URL;

test("organization workspace policy is optional, append-only, and tenant scoped", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const store = PostgresProtectedWorkspacePolicyStore.fromConnectionString(connectionString!);
  const administration = new ProtectedWorkspacePolicyAdministrationService(store);
  const suffix = crypto.randomUUID();
  const tenant = `organization-policy-${suffix}`;
  const otherTenant = `organization-policy-other-${suffix}`;
  const administrator = `organization-policy-admin-${suffix}`;
  const outsider = `organization-policy-outsider-${suffix}`;
  try {
    await pool.query(
      "INSERT INTO tenants(id,external_tenant_id,display_name) VALUES($1,$2,'Policy tenant'),($3,$4,'Other policy tenant')",
      [tenant, `external-${tenant}`, otherTenant, `external-${otherTenant}`],
    );
    await pool.query(
      `INSERT INTO users(id,tenant_id,email,display_name) VALUES
       ($1,$2,$3,'Administrator'),($4,$5,$6,'Outsider')`,
      [administrator, tenant, `${administrator}@test.invalid`, outsider, otherTenant, `${outsider}@test.invalid`],
    );

    const legacyPolicyId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO organization_workspace_policy_versions (
         tenant_id,id,version,previous_policy_version_id,document_hash,constraints,revision_note,created_by,enforcement_scope
       ) VALUES ($1,$2,1,NULL,$3,$4,'Archived signed baseline overlay',$5,'legacy_signed_baseline')`,
      [tenant, legacyPolicyId, "a".repeat(64), { agents: { allow: ["claude-cli"], deny: [] } }, administrator],
    );

    const initial = await administration.overview(tenant);
    assert.equal(initial.organizationPolicyVersions.length, 0);
    assert.equal(await administration.currentOrganizationPolicy(tenant), null);
    assert.deepEqual(initial.catalog.constraints.agents.allow, [
      "claude-desktop", "claude-cli", "codex-cli", "hermes-desktop", "hermes-claw",
    ]);
    assert.deepEqual(initial.catalog.constraints.workspaceProfiles.allow, ["claude-desktop-standard-v1", "disposable-open-v1"]);
    assert.deepEqual(initial.catalog.constraints.applications.allow, ["firefox", "google-chrome", "visual-studio-code", "obsidian"]);
    assert.deepEqual(initial.catalog.constraints.serviceClasses.allow, ["lite", "balanced", "pro"]);

    const first = await administration.createOrganizationPolicyVersion({
      tenantId: tenant,
      constraints: { agents: { allow: ["claude-cli", "codex-cli"], deny: [] } },
      revisionNote: "Allow the approved command-line agents",
      createdBy: administrator,
    });
    const second = await administration.createOrganizationPolicyVersion({
      tenantId: tenant,
      constraints: {
        agents: { allow: ["claude-cli", "codex-cli"], deny: [] },
        workspaceProfiles: { allow: ["claude-desktop-standard-v1"], deny: [] },
        maximumEgressMode: "restricted",
      },
      revisionNote: "Restrict organization workspaces",
      createdBy: administrator,
    });
    assert.equal(first.version, 1, "the archived baseline chain does not consume organization policy v1");
    assert.equal(second.version, 2);
    assert.equal(second.previousPolicyVersionId, first.policyVersionId);
    assert.deepEqual((await administration.listOrganizationPolicyVersions(tenant)).map((item) => item.version), [2, 1]);
    assert.equal((await administration.currentOrganizationPolicy(tenant))?.policyVersionId, second.policyVersionId);
    assert.equal(await administration.currentOrganizationPolicy(otherTenant), null);

    const archived = await pool.query(
      "SELECT id,enforcement_scope FROM organization_workspace_policy_versions WHERE tenant_id=$1 ORDER BY created_at,id",
      [tenant],
    );
    assert.equal(archived.rows.filter((row) => row.enforcement_scope === "legacy_signed_baseline").length, 1);
    assert.equal(archived.rows.filter((row) => row.enforcement_scope === "organization").length, 2);

    await assert.rejects(
      administration.createOrganizationPolicyVersion({
        tenantId: tenant,
        constraints: {},
        revisionNote: "Foreign actor cannot manage this organization",
        createdBy: outsider,
      }),
      /foreign key/i,
    );
    await assert.rejects(
      pool.query("DELETE FROM organization_workspace_policy_versions WHERE tenant_id=$1 AND id=$2", [tenant, first.policyVersionId]),
      /immutable/i,
    );
    await assert.rejects(
      pool.query("UPDATE organization_workspace_policy_versions SET revision_note='Changed' WHERE tenant_id=$1 AND id=$2", [tenant, legacyPolicyId]),
      /immutable/i,
    );
  } finally {
    await store.close();
    await pool.end();
  }
});
