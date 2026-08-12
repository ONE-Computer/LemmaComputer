import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { productReleaseVerificationKeySetSchema } from "@lemmacomputer/contracts";
import { PostgresProtectedWorkspacePolicyStore } from "@lemmacomputer/workspace-store";
import {
  parseProductPolicyRelease,
  ProtectedWorkspacePolicyAdministrationService,
} from "../apps/control-api/src/protected-workspace-policy.js";

const connectionString = process.env.POLICY_TEST_DATABASE_URL;
const root = new URL("../", import.meta.url);
const readJson = async (path: string) => JSON.parse(await readFile(new URL(path, root), "utf8")) as unknown;
const selection = (applicationIds: Array<"firefox" | "google-chrome"> = ["firefox"]) => ({
  workspaceProfile: "kasm-persistent-standard" as const,
  agentIds: ["claude-cli" as const],
  applicationIds,
  modelAlias: "lemmacomputer-claude" as const,
  serviceClass: "balanced" as const,
  reasoningEffort: "medium" as const,
  egressMode: "restricted" as const,
  connectorIds: ["microsoft-365"],
});

test("protected policy persistence is signed, immutable, append-only, and tenant scoped", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const trustRootInput = await readJson("config/product-policy/product-release-trust.json");
  const trustRoot = productReleaseVerificationKeySetSchema.parse(trustRootInput);
  const envelope = await readJson("config/product-policy/protected-baselines/office-worker-claude-v1.json");
  const release = parseProductPolicyRelease(trustRootInput, envelope, new Date("2026-08-12T05:00:00.000Z"));
  const store = PostgresProtectedWorkspacePolicyStore.fromConnectionString(connectionString!, trustRoot);
  const administration = new ProtectedWorkspacePolicyAdministrationService(store, release);
  const suffix = crypto.randomUUID();
  const tenant = `protected-policy-${suffix}`;
  const otherTenant = `protected-policy-other-${suffix}`;
  const administrator = `protected-policy-admin-${suffix}`;
  const member = `protected-policy-member-${suffix}`;
  const outsider = `protected-policy-outsider-${suffix}`;
  try {
    await pool.query(
      "INSERT INTO tenants(id,external_tenant_id,display_name) VALUES($1,$2,'Policy tenant'),($3,$4,'Other policy tenant')",
      [tenant, `external-${tenant}`, otherTenant, `external-${otherTenant}`],
    );
    await pool.query(
      `INSERT INTO users(id,tenant_id,email,display_name) VALUES
       ($1,$2,$3,'Administrator'),($4,$2,$5,'Member'),($6,$7,$8,'Outsider')`,
      [
        administrator,
        tenant,
        `${administrator}@test.invalid`,
        member,
        `${member}@test.invalid`,
        outsider,
        otherTenant,
        `${outsider}@test.invalid`,
      ],
    );

    const automaticOverview = await administration.overview(tenant);
    const installed = await store.getLatestReleaseOwnedBaseline(tenant);
    assert.ok(installed);
    assert.equal(automaticOverview.baseline.immutable, true);
    assert.equal(automaticOverview.baseline.editableByOrganization, false);
    assert.equal(installed.templateVersionId, "pbtv_office_worker_claude_1");
    assert.equal(installed.sourceCommit, "30e04d9610a17d24a0d6717fc3f99f562c5626e9");
    assert.equal((await administration.overview(tenant)).baseline.envelopeDigest, installed.envelopeDigest,
      "automatic release installation is idempotent");

    const firstOrganizationPolicy = await store.createOrganizationPolicyVersion({
      tenantId: tenant,
      constraints: { agents: { allow: ["claude-cli"], deny: [] } },
      revisionNote: "Members use Claude CLI",
      createdBy: administrator,
    });
    const secondOrganizationPolicy = await store.createOrganizationPolicyVersion({
      tenantId: tenant,
      constraints: {
        agents: { allow: ["claude-desktop", "claude-cli"], deny: [] },
        applications: { allow: ["firefox", "google-chrome"], deny: [] },
      },
      revisionNote: "Permit both office browser choices",
      createdBy: administrator,
    });
    assert.equal(firstOrganizationPolicy.version, 1);
    assert.equal(secondOrganizationPolicy.version, 2);
    assert.deepEqual((await store.listOrganizationPolicyVersions(tenant)).map((item) => item.version), [2, 1]);

    const automaticallyAssigned = await administration.assignMember({
      tenantId: tenant,
      subjectId: administrator,
      selection: selection(),
      assignedBy: administrator,
    });
    assert.equal(automaticallyAssigned.protectedTemplateVersionId, installed.templateVersionId);
    assert.equal(automaticallyAssigned.organizationPolicyVersionId, secondOrganizationPolicy.policyVersionId,
      "new assignments snapshot the latest organization overlay");
    await assert.rejects(
      administration.assignMember({
        tenantId: tenant,
        subjectId: member,
        selection: { ...selection(), agentIds: ["hermes-claw"] },
        assignedBy: administrator,
      }),
      /denied/i,
      "an organization administrator cannot expand the product-owned agent ceiling",
    );

    const firstAssignment = await store.assignMemberSelection({
      tenantId: tenant,
      subjectId: member,
      protectedTemplateVersionId: installed.templateVersionId,
      organizationPolicyVersionId: firstOrganizationPolicy.policyVersionId,
      selection: selection(),
      assignedBy: administrator,
    });
    const replacement = await store.assignMemberSelection({
      tenantId: tenant,
      subjectId: member,
      protectedTemplateVersionId: installed.templateVersionId,
      organizationPolicyVersionId: secondOrganizationPolicy.policyVersionId,
      selection: selection(["firefox", "google-chrome"]),
      assignedBy: administrator,
    });
    assert.equal(firstAssignment.assignmentVersion, 1);
    assert.equal(replacement.assignmentVersion, 2);
    assert.equal(replacement.previousAssignmentId, firstAssignment.id);
    assert.deepEqual((await store.getCurrentMemberAssignment(tenant, member))?.selection.applicationIds, [
      "firefox",
      "google-chrome",
    ]);
    assert.deepEqual((await store.listMemberAssignmentVersions(tenant, member)).map((item) => item.assignmentVersion), [2, 1]);
    const effectiveMemberPolicy = await administration.effectiveMemberPolicy(tenant, member);
    assert.equal(effectiveMemberPolicy.state, "assigned");
    if (effectiveMemberPolicy.state === "assigned") {
      assert.deepEqual(effectiveMemberPolicy.policy.allowed.agentIds, ["claude-desktop", "claude-cli"]);
      assert.deepEqual(effectiveMemberPolicy.policy.selection.applicationIds, ["firefox", "google-chrome"]);
    }
    assert.equal(await store.getCurrentMemberAssignment(otherTenant, member), null);

    await assert.rejects(
      store.assignMemberSelection({
        tenantId: otherTenant,
        subjectId: outsider,
        protectedTemplateVersionId: installed.templateVersionId,
        selection: selection(),
        assignedBy: outsider,
      }),
      /foreign key/i,
      "a tenant cannot reference another tenant's protected template",
    );
    await assert.rejects(
      store.createOrganizationPolicyVersion({
        tenantId: tenant,
        constraints: {},
        revisionNote: "Outsider cannot manage this organization",
        createdBy: outsider,
      }),
      /foreign key/i,
      "a foreign-tenant actor cannot create an organization overlay",
    );

    await assert.rejects(
      pool.query(
        "UPDATE protected_policy_template_versions SET document_hash=$1 WHERE tenant_id=$2 AND template_version_id=$3",
        ["f".repeat(64), tenant, installed.templateVersionId],
      ),
      /immutable/i,
    );
    await assert.rejects(
      pool.query(
        "DELETE FROM organization_workspace_policy_versions WHERE tenant_id=$1 AND id=$2",
        [tenant, firstOrganizationPolicy.policyVersionId],
      ),
      /immutable/i,
    );
    await assert.rejects(
      pool.query(
        "UPDATE member_workspace_policy_assignment_versions SET state='revoked' WHERE tenant_id=$1 AND id=$2",
        [tenant, replacement.id],
      ),
      /immutable/i,
    );

    assert.equal(await administration.revokeMember({ tenantId: tenant, subjectId: member, revokedBy: administrator }), true);
    assert.equal(await store.getCurrentMemberAssignment(tenant, member), null);
    assert.deepEqual(await administration.effectiveMemberPolicy(tenant, member), { state: "revoked" });
    const history = await pool.query(
      `SELECT assignment_version,state FROM member_workspace_policy_assignment_versions
       WHERE tenant_id=$1 AND subject_id=$2 ORDER BY assignment_version`,
      [tenant, member],
    );
    assert.deepEqual(history.rows, [
      { assignment_version: 1, state: "selected" },
      { assignment_version: 2, state: "selected" },
      { assignment_version: 3, state: "revoked" },
    ]);
  } finally {
    await store.close();
    await pool.end();
  }
});
