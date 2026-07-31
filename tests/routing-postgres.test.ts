import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  PostgresRoutingStore,
  PostgresTeamStore,
  PostgresUsageLedgerStore,
} from "@onecomputer/workspace-store";
import type { ModelRoutingDecision } from "@onecomputer/model-router";
const connectionString = process.env.ROUTING_TEST_DATABASE_URL;
const classPolicy = (id: string) => ({
  capabilityFloor: {
    vision: false,
    tools: false,
    streaming: true,
    contextTokens: 8000,
    outputTokens: 1000,
  },
  evaluationThreshold: "0.800000",
  qualityPosture: "standard" as const,
  costPosture: "balanced" as const,
  latencyPosture: "balanced" as const,
  requiredModalities: ["text" as const],
  requiredResidency: ["sg"],
  eligibleDeploymentIds: [id],
  safeDefault: false,
});
test(
  "PostgreSQL governed routing preserves tenant/version integrity, atomic decisions, replay, and immutable observations",
  { skip: !connectionString },
  async () => {
    const pool = new pg.Pool({ connectionString });
    const teams = PostgresTeamStore.fromConnectionString(connectionString!);
    const usage = PostgresUsageLedgerStore.fromConnectionString(
      connectionString!,
    );
    const routing = PostgresRoutingStore.fromConnectionString(
      connectionString!,
    );
    const suffix = randomUUID();
    const tenant = `routing-${suffix}`;
    const other = `routing-other-${suffix}`;
    const admin = `admin-${suffix}`;
    const outsider = `outside-${suffix}`;
    const user = `user-${suffix}`;
    const mapping = randomUUID();
    const otherMapping = randomUUID();
    const deployment = randomUUID();
    const otherDeployment = randomUUID();
    try {
      await pool.query(
        "INSERT INTO tenants(id,external_tenant_id,display_name) VALUES($1,$2,'Routing'),($3,$4,'Other')",
        [tenant, `ext-${tenant}`, other, `ext-${other}`],
      );
      await pool.query(
        "INSERT INTO users(id,tenant_id,email,display_name) VALUES($1,$3,$4,'Admin'),($2,$3,$5,'User'),($6,$7,$8,'Outside')",
        [
          admin,
          user,
          tenant,
          `${admin}@test.invalid`,
          `${user}@test.invalid`,
          outsider,
          other,
          `${outsider}@test.invalid`,
        ],
      );
      await pool.query(
        "INSERT INTO user_roles(user_id,role,assigned_by) VALUES($1,'employee',$1),($1,'administrator',$1),($2,'employee',$1),($3,'employee',$3)",
        [admin, user, outsider],
      );
      const team = await teams.createTeam({
        tenantId: tenant,
        createdBy: admin,
        displayName: "Finance",
        description: "",
        ownerUserId: admin,
        costCenterCode: "CC-R",
      });
      await teams.createTeam({
        tenantId: other,
        createdBy: outsider,
        displayName: "Other",
        description: "",
        ownerUserId: outsider,
        costCenterCode: "CC-O",
      });
      await teams.assignMembership({
        tenantId: tenant,
        teamId: team.id,
        userId: user,
        assignedBy: admin,
        makeDefault: true,
      });
      const rateCard = await usage.createRateCard({
        tenantId: tenant,
        provider: "openai",
        providerAccountId: "account",
        baseModel: "private/luna",
        deploymentId: "private-lite",
        currency: "USD",
        source: "pinned_catalogue",
        sourceVersion: "routing-v1",
        sourceHash: "a".repeat(64),
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        effectiveTo: new Date("2027-01-01T00:00:00Z"),
        rates: [
          {
            unit: "input_uncached_token",
            amountPerUnit: "1",
            unitScale: "1000000",
          },
          { unit: "output_token", amountPerUnit: "2", unitScale: "1000000" },
        ],
      });
      await pool.query(
        "INSERT INTO ai_routing_mapping_versions(id,tenant_id,revision_note,created_by) VALUES($1,$2,'v1',$3),($4,$5,'other',$6)",
        [mapping, tenant, admin, otherMapping, other, outsider],
      );
      const capabilities = {
        vision: false,
        tools: false,
        streaming: true,
        contextTokens: 32000,
        outputTokens: 8000,
        residency: ["sg"],
      };
      await pool.query(
        "INSERT INTO ai_routing_deployments(id,tenant_id,mapping_version_id,service_class,provider,provider_model,provider_deployment,rate_card_id,capabilities,approved,evaluation_passed) VALUES($1,$2,$3,'lite','openai','private/luna','private-lite',$4,$5,true,true),($6,$7,$8,'lite','openai','other','other-lite',NULL,$5,true,true)",
        [
          deployment,
          tenant,
          mapping,
          rateCard,
          capabilities,
          otherDeployment,
          other,
          otherMapping,
        ],
      );
      const scope = {
        allowedServiceClasses: ["lite"] as const,
        allowedDeploymentIds: [deployment],
        explicitSelectionAllowed: true,
        forceServiceClass: null,
        safeDefault: "lite" as const,
      };
      const policies = {
        lite: { ...classPolicy(deployment), safeDefault: true },
        balanced: classPolicy(deployment),
        pro: classPolicy(deployment),
      };
      await assert.rejects(
        routing.createPolicy({
          tenantId: tenant,
          teamId: team.id,
          mappingVersionId: otherMapping,
          billingCurrency: "USD",
          serviceClassPolicies: policies,
          identity: scope,
          team: null,
          createdBy: admin,
        }),
        /mapping not found/,
      );
      const policy = await routing.createPolicy({
        tenantId: tenant,
        teamId: team.id,
        mappingVersionId: mapping,
        billingCurrency: "USD",
        serviceClassPolicies: policies,
        identity: scope,
        team: null,
        createdBy: admin,
      });
      const review = await routing.createReview({
        tenantId: tenant,
        teamId: team.id,
        sampleSize: 10,
        evaluationPassed: true,
        expectedSavings: "1",
        currency: "USD",
        fallbackRate: "0",
        errorRate: "0",
        regretRate: "0",
        reviewerUserId: admin,
        reviewNote: "Representative routing evidence passed",
        reviewedAt: new Date(),
      });
      await assert.rejects(
        routing.createRollout({
          tenantId: tenant,
          teamId: team.id,
          policyVersionId: policy,
          mappingVersionId: otherMapping,
          mode: "enabled",
          fixedDeploymentId: deployment,
          evidenceReviewId: review.id,
          reason: "mismatch",
          createdBy: admin,
        }),
        /do not match/,
      );
      const rollout = await routing.createRollout({
        tenantId: tenant,
        teamId: team.id,
        policyVersionId: policy,
        mappingVersionId: mapping,
        mode: "shadow",
        fixedDeploymentId: deployment,
        evidenceReviewId: review.id,
        reason: "qualify",
        createdBy: admin,
      });
      const effective = await routing.resolveEffectivePolicy(tenant, team.id, [
        { unit: "input_uncached_token", quantity: "1000" },
        { unit: "output_token", quantity: "100" },
      ]);
      assert.equal(
        effective?.policy.deployments[0]?.expectedCost?.amount,
        "0.001200000000",
      );
      assert.equal(
        effective?.policy.deployments[0]?.expectedCost?.currency,
        "USD",
      );
      const decision = (
        requestId: string,
        currency = "USD",
        candidateIds = [deployment],
      ): ModelRoutingDecision => ({
        requestId,
        requestedAlias: "onecomputer-auto",
        requestedServiceClass: "auto",
        selectedServiceClass: "lite",
        taskClass: "short",
        confidence: "0.900000",
        signals: ["short_prompt"],
        reasonCode: "task_class_short",
        escalationReason: null,
        policyVersionId: policy,
        mappingVersionId: mapping,
        selectedDeployment: {
          id: deployment,
          provider: "openai",
          model: "private/luna",
          deployment: "private-lite",
          rateCardId: rateCard,
          expectedCost: { amount: "0.001200000000", currency },
        },
        executedDeployment: {
          id: deployment,
          provider: "openai",
          model: "private/luna",
          deployment: "private-lite",
        },
        candidateIds,
        ineligible: [],
        affinityKey: null,
        affinityMovedReason: null,
        routerOverheadMs: "1.000000",
        mode: "shadow",
        shadow: true,
      });
      const badRequest = `bad-${suffix}`;
      await assert.rejects(
        routing.recordDecision({
          tenantId: tenant,
          teamId: team.id,
          userId: user,
          taskId: "task",
          rolloutVersionId: rollout.id,
          decision: decision(badRequest, "USD", [randomUUID()]),
        }),
      );
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM ai_routing_decisions WHERE tenant_id=$1 AND request_id=$2",
              [tenant, badRequest],
            )
          ).rows[0].count,
        ),
        0,
      );
      const requestId = `request-${suffix}`;
      const recorded = await routing.recordDecision({
        tenantId: tenant,
        teamId: team.id,
        userId: user,
        taskId: "task",
        rolloutVersionId: rollout.id,
        decision: decision(requestId),
      });
      assert.equal(recorded.status, "created");
      assert.equal(
        (
          await routing.recordDecision({
            tenantId: tenant,
            teamId: team.id,
            userId: user,
            taskId: "task",
            rolloutVersionId: rollout.id,
            decision: decision(requestId),
          })
        ).status,
        "duplicate",
      );
      assert.equal(
        (await routing.decisionByRequest(tenant, requestId))?.id,
        recorded.id,
      );
      const snapshot = (await teams.getCurrentDefaultSpendingTeam(
        tenant,
        user,
      ))!;
      const admitted = await usage.admitAttempt({
        tenantId: tenant,
        sourceSystem: "litellm",
        sourceAttemptId: `attempt-${suffix}`,
        subjectId: user,
        team: snapshot,
        workspaceId: "workspace",
        agentId: "agent",
        taskId: "task",
        taskBindingProvenance: "explicit_signed",
        contextKind: "chat",
        policyVersionId: policy,
        requestedAlias: "onecomputer-auto",
        requestedServiceClass: "auto",
        selectedServiceClass: "lite",
        routeMappingVersion: mapping,
        attemptKind: "inference",
        resolvedProvider: "openai",
        providerAccountId: "account",
        resolvedModel: "private/luna",
        resolvedDeploymentId: "private-lite",
        admittedAt: new Date("2026-02-01T00:00:00Z"),
      });
      assert.equal(admitted.status, "created");
      const event = await usage.appendUsageEvent({
        tenantId: tenant,
        admissionId: admitted.admissionId!,
        sourceSystem: "litellm",
        sourceEventId: `event-${suffix}`,
        eventType: "usage",
        occurredAt: new Date("2026-02-01T00:00:01Z"),
        outcome: "failure",
        units: [
          { unit: "input_uncached_token", quantity: "1000" },
          { unit: "output_token", quantity: "100" },
        ],
      });
      assert.equal(event.status, "created");
      const observed = await routing.appendObservation({
        tenantId: tenant,
        decisionId: recorded.id,
        usageEventId: event.eventId!,
        outcome: "error",
        deploymentHealth: "unavailable",
        actualCost: event.providerCost!,
        currency: event.currency!,
        latencyMs: 50,
      });
      assert.equal(observed.status, "created");
      assert.equal(
        (
          await routing.appendObservation({
            tenantId: tenant,
            decisionId: recorded.id,
            usageEventId: event.eventId!,
            outcome: "error",
            deploymentHealth: "unavailable",
            actualCost: event.providerCost!,
            currency: event.currency!,
            latencyMs: 50,
          })
        ).status,
        "duplicate",
      );
      const health = await pool.query(
        "SELECT id,status,expires_at,observed_at FROM ai_routing_deployment_health_observations WHERE tenant_id=$1 AND deployment_id=$2",
        [tenant, deployment],
      );
      assert.equal(health.rowCount, 1);
      assert.equal(health.rows[0].status, "unavailable");
      assert.ok(health.rows[0].expires_at > health.rows[0].observed_at);
      const effectiveAfterFailure = await routing.resolveEffectivePolicy(
        tenant,
        team.id,
        [
          { unit: "input_uncached_token", quantity: "1000" },
          { unit: "output_token", quantity: "100" },
        ],
      );
      assert.equal(effectiveAfterFailure?.policy.deployments[0]?.healthy, false);
      await assert.rejects(
        pool.query("UPDATE ai_routing_deployment_health_observations SET status='healthy' WHERE tenant_id=$1 AND id=$2", [tenant, health.rows[0].id]),
        /immutable/,
      );
      await assert.rejects(
        routing.appendObservation({
          tenantId: other,
          decisionId: recorded.id,
          usageEventId: event.eventId!,
          outcome: "success",
        }),
      );
      await assert.rejects(
        pool.query(
          "UPDATE ai_routing_decision_observations SET latency_ms=51 WHERE tenant_id=$1 AND id=$2",
          [tenant, observed.id],
        ),
        /immutable/,
      );
      const availabilityDecision: ModelRoutingDecision = {
        ...decision(`availability-${suffix}`, "EUR", []),
        reasonCode: "availability_escalation",
        escalationReason: "availability",
        ineligible: [{ deploymentId: deployment, reasonCode: "health" }],
      };
      const availabilityRecord = await routing.recordDecision({
        tenantId: tenant,
        teamId: team.id,
        userId: user,
        taskId: "task-eur",
        rolloutVersionId: rollout.id,
        decision: availabilityDecision,
      });
      const availabilityEvidence = await routing.decision(tenant, availabilityRecord.id);
      assert.equal(availabilityEvidence?.reason_code, "availability_escalation");
      assert.equal(availabilityEvidence?.escalation_reason, "availability");
      assert.deepEqual(
        (availabilityEvidence?.candidates as Array<Record<string, unknown>>).map((candidate) => candidate.reason_code),
        ["health"],
      );
      const report = await routing.shadowReport(tenant, team.id);
      assert.equal(report.sampleSize, 2);
      assert.equal(report.currency, null);
      assert.equal(report.expectedCost, null);
      assert.equal((await routing.adminReadModel(other, team.id)).policy, null);
    } finally {
      await Promise.all([
        pool.end(),
        teams.close(),
        usage.close(),
        routing.close(),
      ]);
    }
  },
);
