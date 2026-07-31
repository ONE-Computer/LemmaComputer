import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  ManagedRoutingProvider,
  ModelRoutingDecision,
  ModelRoutingPolicy,
  ProductServiceClass,
  RoutingAffinityStore,
  RoutingCapabilities,
  RoutingMode,
  RoutingPolicyScope,
  ServiceClassPolicy,
  SessionAffinity,
} from "@onecomputer/model-router";
import {
  PostgresUsageLedgerStore,
  priceUsage,
  type UsageAmount,
} from "./usage-ledger.js";

export type RoutingRollout = {
  id: string;
  tenantId: string;
  teamId: string;
  policyVersionId: string;
  mappingVersionId: string;
  mode: RoutingMode;
  fixedDeploymentId: string;
  evidenceReviewId: string | null;
  previousRolloutVersionId: string | null;
  reason: string;
  createdBy: string;
  createdAt: Date;
};
export type RoutingEvidenceReview = {
  id: string;
  tenantId: string;
  teamId: string;
  sampleSize: number;
  evaluationPassed: boolean;
  expectedSavings: string | null;
  currency: string | null;
  fallbackRate: string;
  errorRate: string;
  regretRate: string;
  reviewerUserId: string;
  reviewNote: string;
  reviewedAt: Date;
};
export type RoutingAdminReadModel = {
  teamId: string;
  policy: null | {
    id: string;
    mappingVersionId: string;
    billingCurrency: string;
    serviceClassPolicies: Record<ProductServiceClass, ServiceClassPolicy>;
    identity: RoutingPolicyScope;
    team: RoutingPolicyScope | null;
    requiredResidency: string | null;
    createdAt: Date;
  };
  rollout: RoutingRollout | null;
  review: RoutingEvidenceReview | null;
  deployments: Array<{
    id: string;
    serviceClass: ProductServiceClass;
    provider: string;
    providerModel: string;
    providerDeployment: string;
    rateCardId: string | null;
    approved: boolean;
    evaluationPassed: boolean;
  }>;
};
export type RoutingShadowReport = {
  teamId: string;
  sampleSize: number;
  selectedDistribution: Record<string, number>;
  executedDistribution: Record<string, number>;
  expectedCost: string | null;
  actualCost: string | null;
  currency: string | null;
  estimatedSavings: string | null;
  fallbackRate: string;
  errorRate: string;
  regretRate: string;
  routerOverheadMs: string;
  decisions: Array<{
    id: string;
    createdAt: Date;
    selectedServiceClass: string;
    reasonCode: string;
    shadow: boolean;
    expectedCost: string;
    currency: string;
    outcome: string | null;
  }>;
};
export type RecordRoutingDecisionInput = {
  tenantId: string;
  teamId: string | null;
  userId: string;
  taskId: string;
  rolloutVersionId: string;
  decision: ModelRoutingDecision;
  outcome?: string;
  actualCost?: string;
  actualCurrency?: string;
  usageEventId?: string;
};
export type ResolvedRoutingPolicy = {
  rollout: RoutingRollout;
  policy: ModelRoutingPolicy;
};
export interface RoutingStore extends RoutingAffinityStore {
  createPolicy(input: {
    tenantId: string;
    teamId: string;
    mappingVersionId: string;
    billingCurrency: string;
    serviceClassPolicies: Record<ProductServiceClass, ServiceClassPolicy>;
    identity: RoutingPolicyScope;
    team: RoutingPolicyScope | null;
    requiredResidency?: string;
    createdBy: string;
  }): Promise<string>;
  createReview(input: {
    tenantId: string;
    teamId: string;
    sampleSize: number;
    evaluationPassed: boolean;
    expectedSavings?: string;
    currency?: string;
    fallbackRate: string;
    errorRate: string;
    regretRate: string;
    reviewerUserId: string;
    reviewNote: string;
    reviewedAt: Date;
  }): Promise<RoutingEvidenceReview>;
  createRollout(input: {
    tenantId: string;
    teamId: string;
    policyVersionId: string;
    mappingVersionId: string;
    mode: RoutingMode;
    fixedDeploymentId: string;
    evidenceReviewId?: string;
    reason: string;
    createdBy: string;
  }): Promise<RoutingRollout>;
  adminReadModel(
    tenantId: string,
    teamId: string,
  ): Promise<RoutingAdminReadModel>;
  shadowReport(tenantId: string, teamId: string): Promise<RoutingShadowReport>;
  recordDecision(
    input: RecordRoutingDecisionInput,
  ): Promise<{ id: string; status: "created" | "duplicate" }>;
  appendObservation(input: {
    tenantId: string;
    decisionId: string;
    usageEventId: string;
    outcome: "success" | "error" | "regret" | "override";
    actualCost?: string;
    currency?: string;
    latencyMs?: number;
    deploymentHealth?: "healthy" | "unavailable";
  }): Promise<{ id: string; status: "created" | "duplicate" }>;
  resolveEffectivePolicy(
    tenantId: string,
    teamId: string,
    expectedUsage: UsageAmount[],
  ): Promise<ResolvedRoutingPolicy | null>;
  decisionByRequest(
    tenantId: string,
    requestId: string,
  ): Promise<Record<string, unknown> | null>;
  decision(
    tenantId: string,
    id: string,
  ): Promise<Record<string, unknown> | null>;
}
const rolloutFrom = (row: Record<string, unknown>): RoutingRollout => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  teamId: String(row.team_id),
  policyVersionId: String(row.policy_version_id),
  mappingVersionId: String(row.mapping_version_id),
  mode: row.mode as RoutingMode,
  fixedDeploymentId: String(row.fixed_deployment_id),
  evidenceReviewId: row.evidence_review_id
    ? String(row.evidence_review_id)
    : null,
  previousRolloutVersionId: row.previous_rollout_version_id
    ? String(row.previous_rollout_version_id)
    : null,
  reason: String(row.reason),
  createdBy: String(row.created_by),
  createdAt: new Date(String(row.created_at)),
});
const reviewFrom = (row: Record<string, unknown>): RoutingEvidenceReview => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  teamId: String(row.team_id),
  sampleSize: Number(row.sample_size),
  evaluationPassed: Boolean(row.evaluation_passed),
  expectedSavings:
    row.expected_savings === null ? null : String(row.expected_savings),
  currency: row.currency === null ? null : String(row.currency),
  fallbackRate: String(row.fallback_rate),
  errorRate: String(row.error_rate),
  regretRate: String(row.regret_rate),
  reviewerUserId: String(row.reviewer_user_id),
  reviewNote: String(row.review_note),
  reviewedAt: new Date(String(row.reviewed_at)),
});
const subtract = (left: string, right: string) => {
  const scale = 12;
  const parse = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return (
      BigInt(whole!) * 10n ** 12n +
      BigInt(fraction.padEnd(scale, "0").slice(0, scale))
    );
  };
  const value = parse(left) - parse(right);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 10n ** 12n}.${String(absolute % 10n ** 12n).padStart(12, "0")}`;
};

export class PostgresRoutingStore implements RoutingStore {
  private readonly rateCards: PostgresUsageLedgerStore;
  constructor(private readonly pool: pg.Pool) {
    this.rateCards = new PostgresUsageLedgerStore(pool);
  }
  static fromConnectionString(connectionString: string) {
    return new PostgresRoutingStore(new pg.Pool({ connectionString, max: 8 }));
  }
  async close() {
    await this.pool.end();
  }
  async get(tenantId: string, affinityKey: string, now: Date) {
    const result = await this.pool.query(
      "SELECT tenant_id,affinity_hash,service_class,deployment_id,expires_at FROM ai_routing_session_affinity_versions WHERE tenant_id=$1 AND affinity_hash=$2 AND expires_at>$3 ORDER BY created_at DESC LIMIT 1",
      [tenantId, affinityKey, now],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      tenantId: String(row.tenant_id),
      affinityKey: String(row.affinity_hash),
      serviceClass: row.service_class as ProductServiceClass,
      deploymentId: String(row.deployment_id),
      expiresAt: new Date(row.expires_at),
    } as SessionAffinity;
  }
  async put(value: SessionAffinity) {
    await this.pool.query(
      "INSERT INTO ai_routing_session_affinity_versions(id,tenant_id,affinity_hash,service_class,deployment_id,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
      [
        randomUUID(),
        value.tenantId,
        value.affinityKey,
        value.serviceClass,
        value.deploymentId,
        value.expiresAt,
      ],
    );
  }
  async createPolicy(input: Parameters<RoutingStore["createPolicy"]>[0]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`routing-policy:${input.tenantId}:${input.teamId}`],
      );
      const [team, mapping] = await Promise.all([
        client.query(
          "SELECT 1 FROM allocation_units WHERE tenant_id=$1 AND id=$2 AND status='active'",
          [input.tenantId, input.teamId],
        ),
        client.query(
          "SELECT 1 FROM ai_routing_mapping_versions WHERE tenant_id=$1 AND id=$2",
          [input.tenantId, input.mappingVersionId],
        ),
      ]);
      if (!team.rowCount) throw new Error("Active Team not found");
      if (!mapping.rowCount)
        throw new Error("Routing mapping not found for tenant");
      if (
        input.team &&
        (input.team.allowedServiceClasses.some(
          (value) => !input.identity.allowedServiceClasses.includes(value),
        ) ||
          input.team.allowedDeploymentIds.some(
            (value) => !input.identity.allowedDeploymentIds.includes(value),
          ))
      )
        throw new Error("Team routing policy may only narrow identity policy");
      const ids = [
        ...new Set([
          ...input.identity.allowedDeploymentIds,
          ...(input.team?.allowedDeploymentIds ?? []),
          ...Object.values(input.serviceClassPolicies).flatMap(
            (value) => value.eligibleDeploymentIds,
          ),
        ]),
      ];
      const deployments = await client.query(
        "SELECT id FROM ai_routing_deployments WHERE tenant_id=$1 AND mapping_version_id=$2 AND id=ANY($3::uuid[])",
        [input.tenantId, input.mappingVersionId, ids],
      );
      if (deployments.rowCount !== ids.length)
        throw new Error(
          "Every policy deployment must belong to the tenant mapping version",
        );
      const id = randomUUID();
      await client.query(
        "INSERT INTO ai_routing_policy_versions(id,tenant_id,team_id,mapping_version_id,billing_currency,service_class_policies,identity_scope,team_scope,required_residency,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          input.tenantId,
          input.teamId,
          input.mappingVersionId,
          input.billingCurrency,
          input.serviceClassPolicies,
          input.identity,
          input.team,
          input.requiredResidency ?? null,
          input.createdBy,
        ],
      );
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async createReview(input: Parameters<RoutingStore["createReview"]>[0]) {
    const id = randomUUID();
    const result = await this.pool.query(
      "INSERT INTO ai_routing_evidence_reviews(id,tenant_id,team_id,sample_size,evaluation_passed,expected_savings,currency,fallback_rate,error_rate,regret_rate,reviewer_user_id,review_note,reviewed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
      [
        id,
        input.tenantId,
        input.teamId,
        input.sampleSize,
        input.evaluationPassed,
        input.expectedSavings ?? null,
        input.currency ?? null,
        input.fallbackRate,
        input.errorRate,
        input.regretRate,
        input.reviewerUserId,
        input.reviewNote,
        input.reviewedAt,
      ],
    );
    return reviewFrom(result.rows[0]);
  }
  async createRollout(input: Parameters<RoutingStore["createRollout"]>[0]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`routing-rollout:${input.tenantId}:${input.teamId}`],
      );
      const policy = await client.query(
        "SELECT 1 FROM ai_routing_policy_versions WHERE tenant_id=$1 AND id=$2 AND team_id=$3 AND mapping_version_id=$4",
        [
          input.tenantId,
          input.policyVersionId,
          input.teamId,
          input.mappingVersionId,
        ],
      );
      if (!policy.rowCount)
        throw new Error(
          "Routing policy, Team, and mapping version do not match",
        );
      const fixed = await client.query(
        "SELECT 1 FROM ai_routing_deployments WHERE tenant_id=$1 AND id=$2 AND mapping_version_id=$3",
        [input.tenantId, input.fixedDeploymentId, input.mappingVersionId],
      );
      if (!fixed.rowCount)
        throw new Error(
          "Fixed deployment does not belong to the rollout mapping",
        );
      if (input.evidenceReviewId) {
        const review = await client.query(
          "SELECT evaluation_passed FROM ai_routing_evidence_reviews WHERE tenant_id=$1 AND id=$2 AND team_id=$3",
          [input.tenantId, input.evidenceReviewId, input.teamId],
        );
        if (!review.rowCount)
          throw new Error(
            "Routing evidence review does not belong to the Team",
          );
        if (input.mode === "enabled" && !review.rows[0].evaluation_passed)
          throw new Error("Production routing evidence has not passed review");
      } else if (input.mode === "enabled")
        throw new Error(
          "Production routing requires a reviewed evidence record",
        );
      const prior = await client.query(
        "SELECT id FROM ai_routing_rollout_versions WHERE tenant_id=$1 AND team_id=$2 ORDER BY created_at DESC LIMIT 1",
        [input.tenantId, input.teamId],
      );
      const id = randomUUID();
      const result = await client.query(
        "INSERT INTO ai_routing_rollout_versions(id,tenant_id,team_id,policy_version_id,mapping_version_id,mode,fixed_deployment_id,evidence_review_id,previous_rollout_version_id,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
        [
          id,
          input.tenantId,
          input.teamId,
          input.policyVersionId,
          input.mappingVersionId,
          input.mode,
          input.fixedDeploymentId,
          input.evidenceReviewId ?? null,
          prior.rows[0]?.id ?? null,
          input.reason,
          input.createdBy,
        ],
      );
      await client.query("COMMIT");
      return rolloutFrom(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async adminReadModel(
    tenantId: string,
    teamId: string,
  ): Promise<RoutingAdminReadModel> {
    const [policy, rollout, review] = await Promise.all([
      this.pool.query(
        "SELECT * FROM ai_routing_policy_versions WHERE tenant_id=$1 AND team_id=$2 ORDER BY created_at DESC LIMIT 1",
        [tenantId, teamId],
      ),
      this.pool.query(
        "SELECT * FROM ai_routing_rollout_versions WHERE tenant_id=$1 AND team_id=$2 ORDER BY created_at DESC LIMIT 1",
        [tenantId, teamId],
      ),
      this.pool.query(
        "SELECT * FROM ai_routing_evidence_reviews WHERE tenant_id=$1 AND team_id=$2 ORDER BY reviewed_at DESC LIMIT 1",
        [tenantId, teamId],
      ),
    ]);
    const policyRow = policy.rows[0];
    const deployments = policyRow
      ? await this.pool.query(
          "SELECT * FROM ai_routing_deployments WHERE tenant_id=$1 AND mapping_version_id=$2 ORDER BY service_class,id",
          [tenantId, policyRow.mapping_version_id],
        )
      : { rows: [] };
    return {
      teamId,
      policy: policyRow
        ? {
            id: String(policyRow.id),
            mappingVersionId: String(policyRow.mapping_version_id),
            billingCurrency: String(policyRow.billing_currency),
            serviceClassPolicies: policyRow.service_class_policies,
            identity: policyRow.identity_scope,
            team: policyRow.team_scope,
            requiredResidency: policyRow.required_residency
              ? String(policyRow.required_residency)
              : null,
            createdAt: new Date(policyRow.created_at),
          }
        : null,
      rollout: rollout.rowCount ? rolloutFrom(rollout.rows[0]) : null,
      review: review.rowCount ? reviewFrom(review.rows[0]) : null,
      deployments: deployments.rows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        serviceClass: row.service_class as ProductServiceClass,
        provider: String(row.provider),
        providerModel: String(row.provider_model),
        providerDeployment: String(row.provider_deployment),
        rateCardId: row.rate_card_id ? String(row.rate_card_id) : null,
        approved: Boolean(row.approved),
        evaluationPassed: Boolean(row.evaluation_passed),
      })),
    };
  }
  async resolveEffectivePolicy(
    tenantId: string,
    teamId: string,
    expectedUsage: UsageAmount[],
  ): Promise<ResolvedRoutingPolicy | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const rolloutResult = await client.query(
        "SELECT * FROM ai_routing_rollout_versions WHERE tenant_id=$1 AND team_id=$2 ORDER BY created_at DESC LIMIT 1",
        [tenantId, teamId],
      );
      if (!rolloutResult.rowCount) {
        await client.query("COMMIT");
        return null;
      }
      const rollout = rolloutFrom(rolloutResult.rows[0]);
      const policyResult = await client.query(
        "SELECT * FROM ai_routing_policy_versions WHERE tenant_id=$1 AND id=$2 AND team_id=$3 AND mapping_version_id=$4",
        [tenantId, rollout.policyVersionId, teamId, rollout.mappingVersionId],
      );
      if (!policyResult.rowCount)
        throw new Error("Active routing rollout policy is invalid");
      const policyRow = policyResult.rows[0];
      const deploymentResult = await client.query(
        `SELECT d.*,
                CASE WHEN health.status='unavailable' AND health.expires_at>now() THEN false ELSE true END healthy
         FROM ai_routing_deployments d
         LEFT JOIN LATERAL (
           SELECT status,expires_at FROM ai_routing_deployment_health_observations
           WHERE tenant_id=d.tenant_id AND deployment_id=d.id ORDER BY observed_at DESC,id DESC LIMIT 1
         ) health ON true
         WHERE d.tenant_id=$1 AND d.mapping_version_id=$2 ORDER BY d.service_class,d.id`,
        [tenantId, rollout.mappingVersionId],
      );
      const pricedAt = new Date();
      const deployments = [];
      for (const row of deploymentResult.rows) {
        const configuredCardId = row.rate_card_id
          ? String(row.rate_card_id)
          : null;
        const canonical = row.provider_account_id
          ? await this.rateCards.selectEffectiveRateCardInTransaction(client, {
              tenantId,
              provider: String(row.provider),
              providerAccountId: String(row.provider_account_id),
              baseModel: String(row.provider_model),
              deploymentId: String(row.provider_deployment),
              ...(row.region ? { region: String(row.region) } : {}),
              ...(row.provider_service_tier
                ? { providerServiceTier: String(row.provider_service_tier) }
                : {}),
              at: pricedAt,
            })
          : null;
        const card =
          configuredCardId && canonical?.id === configuredCardId
            ? canonical
            : null;
        const priced = card ? priceUsage(expectedUsage, card.rates) : null;
        const capabilities = row.capabilities as RoutingCapabilities;
        deployments.push({
          id: String(row.id),
          provider: row.provider as ManagedRoutingProvider,
          model: String(row.provider_model),
          deployment: String(row.provider_deployment),
          serviceClass: row.service_class as ProductServiceClass,
          mappingVersionId: rollout.mappingVersionId,
          rateCardId: configuredCardId,
          expectedCost:
            priced?.providerCost && card
              ? { amount: priced.providerCost, currency: card.currency }
              : null,
          capabilities,
          approved: Boolean(row.approved),
          healthy: Boolean(row.healthy),
          evaluationPassed: Boolean(row.evaluation_passed),
        });
      }
      const budgetEligibleDeploymentIds = deployments
        .filter(
          (item) =>
            item.expectedCost?.currency === String(policyRow.billing_currency),
        )
        .map(({ id }) => id);
      await client.query("COMMIT");
      return {
        rollout,
        policy: {
          tenantId,
          teamId,
          policyVersionId: String(policyRow.id),
          mappingVersionId: String(policyRow.mapping_version_id),
          mode: rollout.mode,
          fixedDeploymentId: rollout.fixedDeploymentId,
          billingCurrency: String(policyRow.billing_currency),
          serviceClassPolicies: policyRow.service_class_policies,
          identity: policyRow.identity_scope,
          team: policyRow.team_scope,
          deployments,
          budgetEligibleDeploymentIds,
          approvedProviders: [
            ...new Set(
              deployments
                .filter((item) => item.approved)
                .map((item) => item.provider),
            ),
          ],
          ...(policyRow.required_residency
            ? { requiredResidency: String(policyRow.required_residency) }
            : {}),
        },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async recordDecision(input: RecordRoutingDecisionInput) {
    const client = await this.pool.connect();
    const id = randomUUID();
    const d = input.decision;
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO ai_routing_decisions(id,tenant_id,request_id,task_id,team_id,user_id,policy_version_id,mapping_version_id,rollout_version_id,requested_service_class,selected_service_class,selected_deployment_id,executed_deployment_id,rate_card_id,expected_cost,currency,confidence,reason_code,safe_signals,escalation_reason,session_affinity_hash,affinity_moved_reason,router_overhead_ms,shadow,outcome,actual_cost,actual_currency,usage_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) ON CONFLICT(tenant_id,request_id) DO NOTHING RETURNING id`,
        [
          id,
          input.tenantId,
          d.requestId,
          input.taskId,
          input.teamId,
          input.userId,
          d.policyVersionId,
          d.mappingVersionId,
          input.rolloutVersionId,
          d.requestedServiceClass,
          d.selectedServiceClass,
          d.selectedDeployment.id,
          d.executedDeployment.id,
          d.selectedDeployment.rateCardId,
          d.selectedDeployment.expectedCost.amount,
          d.selectedDeployment.expectedCost.currency,
          d.confidence,
          d.reasonCode,
          d.signals,
          d.escalationReason,
          d.affinityKey,
          d.affinityMovedReason,
          d.routerOverheadMs,
          d.shadow,
          input.outcome ?? null,
          input.actualCost ?? null,
          input.actualCurrency ?? null,
          input.usageEventId ?? null,
        ],
      );
      if (!result.rowCount) {
        const prior = await client.query(
          "SELECT id FROM ai_routing_decisions WHERE tenant_id=$1 AND request_id=$2",
          [input.tenantId, d.requestId],
        );
        await client.query("COMMIT");
        return { id: String(prior.rows[0].id), status: "duplicate" as const };
      }
      for (const [ordinal, candidate] of [
        ...d.candidateIds.map((deploymentId) => ({
          deploymentId,
          eligibility: "eligible",
          reasonCode: null,
        })),
        ...d.ineligible.map((item) => ({ ...item, eligibility: "ineligible" })),
      ].entries())
        await client.query(
          "INSERT INTO ai_routing_decision_candidates(tenant_id,decision_id,ordinal,deployment_id,eligibility,reason_code) VALUES($1,$2,$3,$4,$5,$6)",
          [
            input.tenantId,
            id,
            ordinal,
            candidate.deploymentId,
            candidate.eligibility,
            candidate.reasonCode,
          ],
        );
      await client.query("COMMIT");
      return { id, status: "created" as const };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async appendObservation(
    input: Parameters<RoutingStore["appendObservation"]>[0],
  ) {
    const client = await this.pool.connect();
    const id = randomUUID();
    const healthId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [
          `routing-observation:${input.tenantId}:${input.decisionId}:${input.usageEventId}`,
        ],
      );
      const prior = await client.query(
        `SELECT observation.id,observation.outcome,observation.actual_cost::text,
                observation.currency,observation.latency_ms::text,health.status deployment_health
         FROM ai_routing_decision_observations observation
         LEFT JOIN ai_routing_deployment_health_observations health
           ON health.tenant_id=observation.tenant_id AND health.decision_id=observation.decision_id AND health.usage_event_id=observation.usage_event_id
         WHERE observation.tenant_id=$1 AND observation.decision_id=$2 AND observation.usage_event_id=$3`,
        [input.tenantId, input.decisionId, input.usageEventId],
      );
      if (prior.rowCount) {
        const row = prior.rows[0];
        if (
          String(row.outcome) !== input.outcome ||
          (row.actual_cost === null ? null : String(row.actual_cost)) !==
            (input.actualCost ?? null) ||
          (row.currency === null ? null : String(row.currency)) !==
            (input.currency ?? null) ||
          (row.latency_ms === null ? null : Number(row.latency_ms)) !==
            (input.latencyMs ?? null) ||
          (row.deployment_health === null ? null : String(row.deployment_health)) !==
            (input.deploymentHealth ?? null)
        )
          throw new Error(
            "Routing observation replay does not match immutable evidence",
          );
        await client.query("COMMIT");
        return { id: String(row.id), status: "duplicate" as const };
      }
      const evidence = await client.query(
        `SELECT event.price_status,event.provider_cost::text,event.currency,decision.executed_deployment_id
         FROM ai_routing_decisions decision
         JOIN ai_routing_deployments deployment
           ON deployment.tenant_id=decision.tenant_id AND deployment.id=decision.executed_deployment_id
         JOIN ai_usage_events event
           ON event.tenant_id=$1 AND event.id=$3 AND event.event_type='usage'
         JOIN ai_usage_attempt_admissions admission
           ON admission.tenant_id=event.tenant_id AND admission.id=event.admission_id
         WHERE decision.tenant_id=$1 AND decision.id=$2
           AND admission.task_id=decision.task_id
           AND admission.team_id=decision.team_id
           AND admission.subject_id=decision.user_id
           AND admission.resolved_provider=deployment.provider
           AND admission.resolved_model=deployment.provider_model
           AND admission.resolved_deployment_id=deployment.provider_deployment
           AND admission.policy_version_id=decision.policy_version_id::text
           AND admission.route_mapping_version=decision.mapping_version_id::text
           AND admission.selected_service_class=decision.selected_service_class`,
        [input.tenantId, input.decisionId, input.usageEventId],
      );
      if (!evidence.rowCount)
        throw new Error(
          "Routing observation does not match the decision execution evidence",
        );
      const event = evidence.rows[0];
      const actualCost =
        event.price_status === "priced" ? String(event.provider_cost) : null;
      const currency =
        event.price_status === "priced" ? String(event.currency) : null;
      if (
        (input.actualCost ?? null) !== actualCost ||
        (input.currency ?? null) !== currency
      )
        throw new Error(
          "Routing observation cost does not match the immutable usage ledger",
        );
      await client.query(
        "INSERT INTO ai_routing_decision_observations(id,tenant_id,decision_id,usage_event_id,outcome,actual_cost,currency,latency_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          input.tenantId,
          input.decisionId,
          input.usageEventId,
          input.outcome,
          actualCost,
          currency,
          input.latencyMs ?? null,
        ],
      );
      if (input.deploymentHealth) {
        await client.query(
          `INSERT INTO ai_routing_deployment_health_observations(
             id,tenant_id,deployment_id,decision_id,usage_event_id,status,source,expires_at
           ) VALUES(
             $1,$2,$3,$4,$5,$6,'litellm_execution',
             CASE WHEN $6='unavailable' THEN now()+interval '60 seconds' ELSE NULL END
           )`,
          [
            healthId,
            input.tenantId,
            String(event.executed_deployment_id),
            input.decisionId,
            input.usageEventId,
            input.deploymentHealth,
          ],
        );
      }
      await client.query("COMMIT");
      return { id, status: "created" as const };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async decisionByRequest(tenantId: string, requestId: string) {
    const result = await this.pool.query(
      "SELECT id FROM ai_routing_decisions WHERE tenant_id=$1 AND request_id=$2",
      [tenantId, requestId],
    );
    return result.rowCount
      ? this.decision(tenantId, String(result.rows[0].id))
      : null;
  }
  async decision(tenantId: string, id: string) {
    const [result, candidates, observations] = await Promise.all([
      this.pool.query(
        "SELECT d.*,s.provider,s.provider_model selected_model,s.provider_deployment selected_provider_deployment,e.provider executed_provider,e.provider_model executed_model,e.provider_deployment executed_provider_deployment FROM ai_routing_decisions d JOIN ai_routing_deployments s ON s.tenant_id=d.tenant_id AND s.id=d.selected_deployment_id JOIN ai_routing_deployments e ON e.tenant_id=d.tenant_id AND e.id=d.executed_deployment_id WHERE d.tenant_id=$1 AND d.id=$2",
        [tenantId, id],
      ),
      this.pool.query(
        "SELECT c.*,d.provider,d.provider_model,d.provider_deployment FROM ai_routing_decision_candidates c JOIN ai_routing_deployments d ON d.tenant_id=c.tenant_id AND d.id=c.deployment_id WHERE c.tenant_id=$1 AND c.decision_id=$2 ORDER BY c.ordinal",
        [tenantId, id],
      ),
      this.pool.query(
        "SELECT * FROM ai_routing_decision_observations WHERE tenant_id=$1 AND decision_id=$2 ORDER BY observed_at",
        [tenantId, id],
      ),
    ]);
    return result.rowCount
      ? {
          ...result.rows[0],
          candidates: candidates.rows,
          observations: observations.rows,
        }
      : null;
  }
  async shadowReport(
    tenantId: string,
    teamId: string,
  ): Promise<RoutingShadowReport> {
    const result = await this.pool.query(
      "SELECT d.*,o.outcome observation_outcome,o.actual_cost observation_actual_cost,o.currency observation_currency FROM ai_routing_decisions d LEFT JOIN LATERAL (SELECT outcome,actual_cost,currency FROM ai_routing_decision_observations WHERE tenant_id=d.tenant_id AND decision_id=d.id ORDER BY observed_at DESC LIMIT 1) o ON true WHERE d.tenant_id=$1 AND d.team_id=$2 AND d.shadow=true ORDER BY d.created_at DESC LIMIT 1000",
      [tenantId, teamId],
    );
    const selectedDistribution: Record<string, number> = {};
    const executedDistribution: Record<string, number> = {};
    let expected = 0n,
      actual = 0n,
      actualCount = 0,
      overhead = 0n,
      failures = 0,
      regrets = 0;
    const currencies = new Set<string>();
    const parse = (value: string) => {
      const [w, f = ""] = value.split(".");
      return BigInt(w!) * 10n ** 12n + BigInt(f.padEnd(12, "0").slice(0, 12));
    };
    for (const row of result.rows) {
      selectedDistribution[row.selected_service_class] =
        (selectedDistribution[row.selected_service_class] ?? 0) + 1;
      executedDistribution[String(row.executed_deployment_id)] =
        (executedDistribution[String(row.executed_deployment_id)] ?? 0) + 1;
      currencies.add(String(row.currency));
      expected += parse(String(row.expected_cost));
      if (row.observation_actual_cost !== null) {
        actual += parse(String(row.observation_actual_cost));
        actualCount++;
        currencies.add(String(row.observation_currency ?? row.currency));
      }
      overhead += parse(String(row.router_overhead_ms));
      if (row.observation_outcome === "error") failures++;
      if (
        row.observation_outcome === "regret" ||
        row.observation_outcome === "override"
      )
        regrets++;
    }
    const format = (value: bigint) =>
      `${value / 10n ** 12n}.${String(value % 10n ** 12n).padStart(12, "0")}`;
    const size = result.rowCount ?? 0;
    const comparable = size > 0 && currencies.size === 1;
    const currency = comparable ? [...currencies][0]! : null;
    return {
      teamId,
      sampleSize: size,
      selectedDistribution,
      executedDistribution,
      expectedCost: comparable ? format(expected) : null,
      actualCost: comparable && actualCount === size ? format(actual) : null,
      currency,
      estimatedSavings:
        comparable && actualCount === size
          ? subtract(format(actual), format(expected))
          : null,
      fallbackRate: size
        ? String(
            result.rows.filter((row) => row.escalation_reason).length / size,
          )
        : "0",
      errorRate: size ? String(failures / size) : "0",
      regretRate: size ? String(regrets / size) : "0",
      routerOverheadMs: size ? format(overhead / BigInt(size)) : "0",
      decisions: result.rows.slice(0, 100).map((row) => ({
        id: String(row.id),
        createdAt: new Date(row.created_at),
        selectedServiceClass: String(row.selected_service_class),
        reasonCode: String(row.reason_code),
        shadow: Boolean(row.shadow),
        expectedCost: String(row.expected_cost),
        currency: String(row.currency),
        outcome: row.observation_outcome
          ? String(row.observation_outcome)
          : null,
      })),
    };
  }
}
