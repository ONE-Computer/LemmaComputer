import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  PostgresRoutingStore,
  PostgresTeamStore,
  PostgresUsageLedgerStore,
} from "@lemmacomputer/workspace-store";
import type { ModelRoutingDecision } from "@lemmacomputer/model-router";
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
    const alternateExecution = randomUUID();
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
      const localOtherTeam = await teams.createTeam({
        tenantId: tenant,
        createdBy: admin,
        displayName: "Operations",
        description: "",
        ownerUserId: admin,
        costCenterCode: "CC-O2",
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
      const publishedMapping = await routing.createMappingVersion({
        tenantId: tenant,
        revisionNote: "Publish administrator-selected service class routes",
        createdBy: admin,
        deployments: [
          {
            serviceClass: "lite",
            provider: "openai",
            providerAccountId: "account",
            providerModel: "private/luna",
            providerDeployment: "private-lite",
            rateCardId: rateCard,
            capabilities,
            approved: true,
            evaluationPassed: false,
          },
          {
            serviceClass: "balanced",
            provider: "openai",
            providerAccountId: "account",
            providerModel: "private/terra",
            providerDeployment: "private-balanced",
            capabilities,
            approved: true,
            evaluationPassed: false,
          },
          {
            serviceClass: "pro",
            provider: "anthropic",
            providerAccountId: "primary",
            providerModel: "private/opus",
            providerDeployment: "private-pro",
            capabilities,
            approved: true,
            evaluationPassed: false,
          },
        ],
      });
      assert.equal(publishedMapping.tenantId, tenant);
      assert.equal(publishedMapping.deployments.length, 3);
      assert.equal(
        (await routing.latestMappingVersion(tenant))?.id,
        publishedMapping.id,
      );
      assert.equal(
        await routing.latestMappingVersion(`missing-${suffix}`),
        null,
      );
      await pool.query(
        "INSERT INTO ai_routing_deployments(id,tenant_id,mapping_version_id,service_class,provider,provider_account_id,provider_model,provider_deployment,rate_card_id,capabilities,approved,evaluation_passed) VALUES($1,$2,$3,'lite','openai','account','private/luna','private-lite',$4,$5,true,true),($6,$7,$8,'lite','openai','other-account','other','other-lite',NULL,$5,true,true)",
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
      await pool.query(
        "INSERT INTO ai_routing_deployments(id,tenant_id,mapping_version_id,service_class,provider,provider_account_id,provider_model,provider_deployment,rate_card_id,capabilities,approved,evaluation_passed) VALUES($1,$2,$3,'lite','openai','account','private/luna','alternate-execution',NULL,$4,true,true)",
        [alternateExecution, tenant, mapping, capabilities],
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
      await assert.rejects(
        routing.createRollout({
          tenantId: tenant,
          teamId: team.id,
          policyVersionId: policy,
          mappingVersionId: otherMapping,
          mode: "enabled",
          fixedDeploymentId: deployment,
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
        reason: "qualify",
        createdBy: admin,
      });
      const effective = await routing.resolveEffectivePolicy(tenant, team.id, [
        { unit: "input_uncached_token", quantity: "1000" },
        { unit: "output_token", quantity: "100" },
      ]);
      const effectiveDeployment = effective?.policy.deployments.find(
        (item) => item.id === deployment,
      );
      assert.equal(effectiveDeployment?.expectedCost?.amount, "0.001200000000");
      const decision = (
        requestId: string,
        currency = "USD",
        candidateIds = [deployment],
      ): ModelRoutingDecision => ({
        requestId,
        requestedAlias: "lemmacomputer-auto",
        requestedServiceClass: "auto",
        selectedServiceClass: "lite",
        selectionStatus: "selected",
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
        requestedAlias: "lemmacomputer-auto",
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
      await assert.rejects(
        routing.appendObservation({
          tenantId: tenant,
          decisionId: recorded.id,
          usageEventId: event.eventId!,
          outcome: "success",
          actualCost: "9.000000000000",
          currency: "USD",
          latencyMs: 50,
        }),
        /cost does not match/,
      );
      await assert.rejects(
        pool.query(
          "INSERT INTO ai_routing_decision_observations(id,tenant_id,decision_id,usage_event_id,outcome,actual_cost,currency,latency_ms) VALUES($1,$2,$3,$4,'success','9','USD',50)",
          [randomUUID(), tenant, recorded.id, event.eventId],
        ),
        /does not match/,
      );
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
      assert.equal(
        effectiveAfterFailure?.policy.deployments.find((item) => item.id === deployment)?.healthy,
        false,
      );
      await assert.rejects(
        pool.query(
          "UPDATE ai_routing_deployment_health_observations SET status='healthy' WHERE tenant_id=$1 AND id=$2",
          [tenant, health.rows[0].id],
        ),
        /immutable/,
      );
      await assert.rejects(
        routing.appendObservation({
          tenantId: tenant,
          decisionId: recorded.id,
          usageEventId: event.eventId!,
          outcome: "error",
          actualCost: event.providerCost!,
          currency: event.currency!,
          latencyMs: 50,
        }),
        /replay does not match/,
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
        ...decision(`availability-${suffix}`, "USD", []),
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
      const availabilityEvidence = await routing.decision(
        tenant,
        availabilityRecord.id,
      );
      assert.equal(
        availabilityEvidence?.reason_code,
        "availability_escalation",
      );
      assert.equal(availabilityEvidence?.escalation_reason, "availability");
      assert.deepEqual(
        (
          availabilityEvidence?.candidates as Array<Record<string, unknown>>
        ).map((candidate) => candidate.reason_code),
        ["health"],
      );
      const report = await routing.shadowReport(tenant, team.id);
      assert.equal(report.sampleSize, 2);
      assert.equal(report.currency, "USD");
      assert.equal(report.expectedCost, "0.002400000000");
      const review = await routing.createReview({
        tenantId: tenant,
        teamId: team.id,
        evaluationPassed: true,
        reviewerUserId: admin,
        reviewNote: "Representative persisted shadow evidence passed",
        reviewedAt: new Date(),
      });
      assert.equal(review.shadowRolloutVersionId, rollout.id);
      assert.equal(review.policyVersionId, policy);
      assert.equal(review.mappingVersionId, mapping);
      assert.equal(review.fixedDeploymentId, deployment);
      assert.equal(review.sampleSize, 2);
      const linked = await pool.query(
        "SELECT decision_id FROM ai_routing_evidence_review_decisions WHERE tenant_id=$1 AND review_id=$2 ORDER BY ordinal",
        [tenant, review.id],
      );
      assert.equal(linked.rowCount, 2);
      await assert.rejects(
        pool.query(
          "UPDATE ai_routing_evidence_review_decisions SET ordinal=3 WHERE tenant_id=$1 AND review_id=$2 AND ordinal=0",
          [tenant, review.id],
        ),
        /immutable/,
      );
      const enabled = await routing.createRollout({
        tenantId: tenant,
        teamId: team.id,
        policyVersionId: policy,
        mappingVersionId: mapping,
        mode: "enabled",
        fixedDeploymentId: deployment,
        evidenceReviewId: review.id,
        reason: "Enable reviewed exact shadow sample",
        createdBy: admin,
      });
      assert.equal(enabled.mode, "enabled");
      const newerShadow = await routing.createRollout({
        tenantId: tenant,
        teamId: team.id,
        policyVersionId: policy,
        mappingVersionId: mapping,
        mode: "shadow",
        fixedDeploymentId: deployment,
        reason: "Begin a fresh shadow evidence window",
        createdBy: admin,
      });
      assert.equal(newerShadow.mode, "shadow");
      await assert.rejects(
        routing.createRollout({
          tenantId: tenant,
          teamId: team.id,
          policyVersionId: policy,
          mappingVersionId: mapping,
          mode: "enabled",
          fixedDeploymentId: deployment,
          evidenceReviewId: review.id,
          reason: "Reject stale review from prior window",
          createdBy: admin,
        }),
        /does not match this shadowed rollout/,
      );
      const mismatchCases = [
        {
          label: "task",
          teamId: team.id,
          userId: user,
          taskId: "other-task",
          routed: decision(`task-mismatch-${suffix}`),
        },
        {
          label: "actor",
          teamId: team.id,
          userId: admin,
          taskId: "task",
          routed: decision(`actor-mismatch-${suffix}`),
        },
        {
          label: "team",
          teamId: localOtherTeam.id,
          userId: user,
          taskId: "task",
          routed: decision(`team-mismatch-${suffix}`),
        },
        {
          label: "execution",
          teamId: team.id,
          userId: user,
          taskId: "task",
          routed: {
            ...decision(`execution-mismatch-${suffix}`),
            executedDeployment: {
              id: alternateExecution,
              provider: "openai" as const,
              model: "private/luna",
              deployment: "alternate-execution",
            },
          },
        },
      ];
      for (const mismatch of mismatchCases) {
        const mismatchDecision = await routing.recordDecision({
          tenantId: tenant,
          teamId: mismatch.teamId,
          userId: mismatch.userId,
          taskId: mismatch.taskId,
          rolloutVersionId: rollout.id,
          decision: mismatch.routed,
        });
        await assert.rejects(
          routing.appendObservation({
            tenantId: tenant,
            decisionId: mismatchDecision.id,
            usageEventId: event.eventId!,
            outcome: "success",
            actualCost: event.providerCost!,
            currency: event.currency!,
            latencyMs: 50,
          }),
          /execution evidence/,
          mismatch.label,
        );
      }

      const foreignRateCard = await usage.createRateCard({
        tenantId: tenant,
        provider: "openai",
        providerAccountId: "account",
        baseModel: "private/foreign",
        deploymentId: "private-lite",
        currency: "USD",
        source: "pinned_catalogue",
        sourceVersion: "routing-foreign-v1",
        sourceHash: "b".repeat(64),
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        effectiveTo: new Date("2027-01-01T00:00:00Z"),
        rates: [
          { unit: "input_uncached_token", amountPerUnit: "1", unitScale: "1" },
        ],
      });
      const foreignPriceDecision = decision(`foreign-price-${suffix}`);
      foreignPriceDecision.selectedDeployment.rateCardId = foreignRateCard;
      await assert.rejects(
        routing.recordDecision({
          tenantId: tenant,
          teamId: team.id,
          userId: user,
          taskId: "task",
          rolloutVersionId: rollout.id,
          decision: foreignPriceDecision,
        }),
        /canonical effective deployment price/,
      );

      const overrideRateCard = await usage.createRateCard({
        tenantId: tenant,
        provider: "openai",
        providerAccountId: "account",
        baseModel: "private/luna",
        deploymentId: "private-lite",
        currency: "USD",
        source: "contract_override",
        sourceVersion: "routing-contract-v2",
        sourceHash: "c".repeat(64),
        effectiveFrom: new Date("2026-01-15T00:00:00Z"),
        approvedBy: admin,
        overrideReason: "New canonical routing contract",
        rates: [
          {
            unit: "input_uncached_token",
            amountPerUnit: "3",
            unitScale: "1000000",
          },
          { unit: "output_token", amountPerUnit: "4", unitScale: "1000000" },
        ],
      });
      assert.equal(
        (
          await usage.selectEffectiveRateCard({
            tenantId: tenant,
            provider: "openai",
            providerAccountId: "account",
            baseModel: "private/luna",
            deploymentId: "private-lite",
            at: new Date(),
          })
        )?.id,
        overrideRateCard,
      );
      const stalePolicy = await routing.resolveEffectivePolicy(
        tenant,
        team.id,
        [
          { unit: "input_uncached_token", quantity: "1000" },
          { unit: "output_token", quantity: "100" },
        ],
      );
      assert.equal(stalePolicy?.policy.deployments[0]?.expectedCost, null);
      assert.deepEqual(stalePolicy?.policy.budgetEligibleDeploymentIds, []);
      await assert.rejects(
        routing.recordDecision({
          tenantId: tenant,
          teamId: team.id,
          userId: user,
          taskId: "task",
          rolloutVersionId: rollout.id,
          decision: decision(`stale-price-${suffix}`),
        }),
        /canonical effective deployment price/,
      );
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
