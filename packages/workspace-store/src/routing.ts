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
} from "@lemmacomputer/model-router";
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
  shadowRolloutVersionId: string | null;
  policyVersionId: string | null;
  mappingVersionId: string | null;
  fixedDeploymentId: string | null;
  sampleSize: number;
  sampleWindowStart: Date | null;
  sampleWindowEnd: Date | null;
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
  rolloutVersionId: string | null;
  policyVersionId: string | null;
  mappingVersionId: string | null;
  fixedDeploymentId: string | null;
  sampleWindowStart: Date | null;
  sampleWindowEnd: Date | null;
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
    selectedDeploymentId: string;
    executedDeploymentId: string;
    executedServiceClass: string;
    selectionStatus: string;
    reasonCode: string;
    shadow: boolean;
    expectedCost: string | null;
    currency: string | null;
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
export type RoutingMappingVersion = {
  id: string;
  tenantId: string;
  revisionNote: string;
  createdBy: string;
  createdAt: Date;
  deployments: Array<{
    id: string;
    serviceClass: ProductServiceClass;
    provider: ManagedRoutingProvider;
    providerAccountId: string | null;
    providerModel: string;
    providerDeployment: string;
    region: string | null;
    providerServiceTier: string | null;
    rateCardId: string | null;
    capabilities: RoutingCapabilities;
    approved: boolean;
    evaluationPassed: boolean;
  }>;
};
export interface RoutingStore extends RoutingAffinityStore {
  createMappingVersion(input: {
    tenantId: string;
    revisionNote: string;
    createdBy: string;
    deployments: Array<{
      serviceClass: ProductServiceClass;
      provider: ManagedRoutingProvider;
      providerAccountId?: string;
      providerModel: string;
      providerDeployment: string;
      region?: string;
      providerServiceTier?: string;
      rateCardId?: string;
      capabilities: RoutingCapabilities;
      approved: boolean;
      evaluationPassed: boolean;
    }>;
  }): Promise<RoutingMappingVersion>;
  latestMappingVersion(tenantId: string): Promise<RoutingMappingVersion | null>;
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
    initializeFixedRollout?: boolean;
  }): Promise<string>;
  createReview(input: {
    tenantId: string;
    teamId: string;
    evaluationPassed: boolean;
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
  shadowRolloutVersionId: row.shadow_rollout_version_id
    ? String(row.shadow_rollout_version_id)
    : null,
  policyVersionId: row.policy_version_id ? String(row.policy_version_id) : null,
  mappingVersionId: row.mapping_version_id
    ? String(row.mapping_version_id)
    : null,
  fixedDeploymentId: row.fixed_deployment_id
    ? String(row.fixed_deployment_id)
    : null,
  sampleSize: Number(row.sample_size),
  sampleWindowStart: row.sample_window_start
    ? new Date(String(row.sample_window_start))
    : null,
  sampleWindowEnd: row.sample_window_end
    ? new Date(String(row.sample_window_end))
    : null,
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
  async createMappingVersion(
    input: Parameters<RoutingStore["createMappingVersion"]>[0],
  ): Promise<RoutingMappingVersion> {
    const classes = new Set(input.deployments.map((item) => item.serviceClass));
    if (
      input.deployments.length < 3 ||
      !(["lite", "balanced", "pro"] as ProductServiceClass[]).every((item) =>
        classes.has(item),
      )
    )
      throw new Error(
        "A routing mapping requires at least one Lite, Balanced, and Pro deployment",
      );
    const client = await this.pool.connect();
    const mappingVersionId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`routing-mapping:${input.tenantId}`],
      );
      await client.query(
        "INSERT INTO ai_routing_mapping_versions(id,tenant_id,revision_note,created_by) VALUES($1,$2,$3,$4)",
        [mappingVersionId, input.tenantId, input.revisionNote, input.createdBy],
      );
      for (const deployment of input.deployments) {
        if (deployment.rateCardId) {
          const matchingRateCard = await client.query(
            `SELECT 1 FROM ai_deployment_rate_cards
             WHERE tenant_id=$1 AND id=$2 AND provider=$3
               AND provider_account_id IS NOT DISTINCT FROM $4
               AND base_model=$5 AND deployment_id=$6
               AND region IS NOT DISTINCT FROM $7
               AND provider_service_tier IS NOT DISTINCT FROM $8
             LIMIT 1`,
            [
              input.tenantId,
              deployment.rateCardId,
              deployment.provider,
              deployment.providerAccountId ?? null,
              deployment.providerModel,
              deployment.providerDeployment,
              deployment.region ?? null,
              deployment.providerServiceTier ?? null,
            ],
          );
          if (!matchingRateCard.rowCount)
            throw new Error(
              "Pinned routing rate card does not match its provider deployment",
            );
        }
        await client.query(
          `INSERT INTO ai_routing_deployments(
            id,tenant_id,mapping_version_id,service_class,provider,provider_account_id,
            provider_model,provider_deployment,region,provider_service_tier,rate_card_id,
            capabilities,approved,evaluation_passed
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            randomUUID(),
            input.tenantId,
            mappingVersionId,
            deployment.serviceClass,
            deployment.provider,
            deployment.providerAccountId ?? null,
            deployment.providerModel,
            deployment.providerDeployment,
            deployment.region ?? null,
            deployment.providerServiceTier ?? null,
            deployment.rateCardId ?? null,
            deployment.capabilities,
            deployment.approved,
            deployment.evaluationPassed,
          ],
        );
      }
      await client.query("COMMIT");
      const created = await this.mappingVersion(input.tenantId, mappingVersionId);
      if (!created) throw new Error("Created routing mapping could not be read");
      return created;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async latestMappingVersion(
    tenantId: string,
  ): Promise<RoutingMappingVersion | null> {
    const latest = await this.pool.query(
      "SELECT id FROM ai_routing_mapping_versions WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
      [tenantId],
    );
    return latest.rowCount
      ? this.mappingVersion(tenantId, String(latest.rows[0].id))
      : null;
  }
  private async mappingVersion(
    tenantId: string,
    mappingVersionId: string,
  ): Promise<RoutingMappingVersion | null> {
    const [mapping, deployments] = await Promise.all([
      this.pool.query(
        "SELECT * FROM ai_routing_mapping_versions WHERE tenant_id=$1 AND id=$2 LIMIT 1",
        [tenantId, mappingVersionId],
      ),
      this.pool.query(
        "SELECT * FROM ai_routing_deployments WHERE tenant_id=$1 AND mapping_version_id=$2 ORDER BY service_class,id",
        [tenantId, mappingVersionId],
      ),
    ]);
    if (!mapping.rowCount) return null;
    const row = mapping.rows[0];
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      revisionNote: String(row.revision_note),
      createdBy: String(row.created_by),
      createdAt: new Date(row.created_at),
      deployments: deployments.rows.map((deployment) => ({
        id: String(deployment.id),
        serviceClass: deployment.service_class as ProductServiceClass,
        provider: deployment.provider as ManagedRoutingProvider,
        providerAccountId: deployment.provider_account_id
          ? String(deployment.provider_account_id)
          : null,
        providerModel: String(deployment.provider_model),
        providerDeployment: String(deployment.provider_deployment),
        region: deployment.region ? String(deployment.region) : null,
        providerServiceTier: deployment.provider_service_tier
          ? String(deployment.provider_service_tier)
          : null,
        rateCardId: deployment.rate_card_id
          ? String(deployment.rate_card_id)
          : null,
        capabilities: deployment.capabilities as RoutingCapabilities,
        approved: Boolean(deployment.approved),
        evaluationPassed: Boolean(deployment.evaluation_passed),
      })),
    };
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
      if (input.initializeFixedRollout) {
        const existingRollout = await client.query(
          "SELECT 1 FROM ai_routing_rollout_versions WHERE tenant_id=$1 AND team_id=$2 LIMIT 1",
          [input.tenantId, input.teamId],
        );
        if (!existingRollout.rowCount) {
          const initialClass = input.identity.safeDefault;
          const fixedDeploymentId = input.serviceClassPolicies[initialClass]?.eligibleDeploymentIds[0];
          if (!fixedDeploymentId || !input.identity.allowedDeploymentIds.includes(fixedDeploymentId)) {
            throw new Error("The initial fixed route requires an eligible safe-default deployment");
          }
          await client.query(
            `INSERT INTO ai_routing_rollout_versions(
               id,tenant_id,team_id,policy_version_id,mapping_version_id,mode,
               fixed_deployment_id,evidence_review_id,previous_rollout_version_id,reason,created_by
             ) VALUES($1,$2,$3,$4,$5,'disabled',$6,NULL,NULL,$7,$8)`,
            [randomUUID(), input.tenantId, input.teamId, id, input.mappingVersionId,
              fixedDeploymentId, "Initial fixed route for immediate governed use", input.createdBy],
          );
        }
      }
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
    const report = await this.shadowReport(input.tenantId, input.teamId);
    if (
      !report.rolloutVersionId ||
      !report.policyVersionId ||
      !report.mappingVersionId ||
      !report.fixedDeploymentId ||
      !report.sampleSize
    )
      throw new Error(
        "A non-empty current shadow rollout is required for review",
      );
    const client = await this.pool.connect();
    const id = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`routing-rollout:${input.tenantId}:${input.teamId}`],
      );
      const current = await client.query(
        "SELECT * FROM ai_routing_rollout_versions WHERE tenant_id=$1 AND team_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
        [input.tenantId, input.teamId],
      );
      if (
        !current.rowCount ||
        String(current.rows[0].id) !== report.rolloutVersionId ||
        current.rows[0].mode !== "shadow" ||
        String(current.rows[0].policy_version_id) !== report.policyVersionId ||
        String(current.rows[0].mapping_version_id) !==
          report.mappingVersionId ||
        String(current.rows[0].fixed_deployment_id) !== report.fixedDeploymentId
      )
        throw new Error("The shadow rollout changed before evidence review");
      const result = await client.query(
        "INSERT INTO ai_routing_evidence_reviews(id,tenant_id,team_id,shadow_rollout_version_id,policy_version_id,mapping_version_id,fixed_deployment_id,sample_size,sample_window_start,sample_window_end,evaluation_passed,expected_savings,currency,fallback_rate,error_rate,regret_rate,reviewer_user_id,review_note,reviewed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *",
        [
          id,
          input.tenantId,
          input.teamId,
          report.rolloutVersionId,
          report.policyVersionId,
          report.mappingVersionId,
          report.fixedDeploymentId,
          report.sampleSize,
          report.sampleWindowStart,
          report.sampleWindowEnd,
          input.evaluationPassed,
          report.estimatedSavings,
          report.currency,
          report.fallbackRate,
          report.errorRate,
          report.regretRate,
          input.reviewerUserId,
          input.reviewNote,
          input.reviewedAt,
        ],
      );
      for (const [ordinal, decision] of report.decisions.entries())
        await client.query(
          "INSERT INTO ai_routing_evidence_review_decisions(tenant_id,review_id,decision_id,ordinal) VALUES($1,$2,$3,$4)",
          [input.tenantId, id, decision.id, ordinal],
        );
      await client.query("COMMIT");
      return reviewFrom(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
      if (input.mode === "enabled") {
        if (!input.evidenceReviewId)
          throw new Error(
            "Production routing requires a reviewed evidence record",
          );
        const review = await client.query(
          `SELECT er.evaluation_passed FROM ai_routing_evidence_reviews er
           JOIN ai_routing_rollout_versions sr ON sr.tenant_id=er.tenant_id AND sr.id=er.shadow_rollout_version_id
           WHERE er.tenant_id=$1 AND er.id=$2 AND er.team_id=$3
             AND er.policy_version_id=$4 AND er.mapping_version_id=$5 AND er.fixed_deployment_id=$6
             AND er.sample_size>0 AND sr.mode='shadow'
             AND er.shadow_rollout_version_id=(SELECT id FROM ai_routing_rollout_versions WHERE tenant_id=$1 AND team_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1)
             AND sr.policy_version_id=$4 AND sr.mapping_version_id=$5 AND sr.fixed_deployment_id=$6`,
          [
            input.tenantId,
            input.evidenceReviewId,
            input.teamId,
            input.policyVersionId,
            input.mappingVersionId,
            input.fixedDeploymentId,
          ],
        );
        if (!review.rowCount)
          throw new Error(
            "Routing evidence does not match this shadowed rollout",
          );
        if (!review.rows[0].evaluation_passed)
          throw new Error("Production routing evidence has not passed review");
      } else if (input.evidenceReviewId) {
        const review = await client.query(
          "SELECT 1 FROM ai_routing_evidence_reviews WHERE tenant_id=$1 AND id=$2 AND team_id=$3",
          [input.tenantId, input.evidenceReviewId, input.teamId],
        );
        if (!review.rowCount)
          throw new Error(
            "Routing evidence review does not belong to the Team",
          );
      }
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
    const [policy, rollout] = await Promise.all([
      this.pool.query(
        "SELECT * FROM ai_routing_policy_versions WHERE tenant_id=$1 AND team_id=$2 ORDER BY created_at DESC LIMIT 1",
        [tenantId, teamId],
      ),
      this.pool.query(
        "SELECT * FROM ai_routing_rollout_versions WHERE tenant_id=$1 AND team_id=$2 ORDER BY created_at DESC LIMIT 1",
        [tenantId, teamId],
      ),
    ]);
    const policyRow = policy.rows[0];
    const rolloutRow = rollout.rows[0];
    const review =
      rolloutRow?.mode === "shadow"
        ? await this.pool.query(
            "SELECT * FROM ai_routing_evidence_reviews WHERE tenant_id=$1 AND team_id=$2 AND shadow_rollout_version_id=$3 ORDER BY reviewed_at DESC,id DESC LIMIT 1",
            [tenantId, teamId, rolloutRow.id],
          )
        : rolloutRow?.mode === "enabled" && rolloutRow.evidence_review_id
          ? await this.pool.query(
              "SELECT * FROM ai_routing_evidence_reviews WHERE tenant_id=$1 AND team_id=$2 AND id=$3 AND policy_version_id=$4 AND mapping_version_id=$5 AND fixed_deployment_id=$6 LIMIT 1",
              [
                tenantId,
                teamId,
                rolloutRow.evidence_review_id,
                rolloutRow.policy_version_id,
                rolloutRow.mapping_version_id,
                rolloutRow.fixed_deployment_id,
              ],
            )
          : null;
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
      review: review?.rowCount ? reviewFrom(review.rows[0]) : null,
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
        `INSERT INTO ai_routing_decisions(id,tenant_id,request_id,task_id,team_id,user_id,policy_version_id,mapping_version_id,rollout_version_id,requested_service_class,selected_service_class,selection_status,selected_deployment_id,executed_deployment_id,rate_card_id,expected_cost,currency,confidence,reason_code,safe_signals,escalation_reason,session_affinity_hash,affinity_moved_reason,router_overhead_ms,shadow,outcome,actual_cost,actual_currency,usage_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) ON CONFLICT(tenant_id,request_id) DO NOTHING RETURNING id`,
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
          d.selectionStatus,
          d.selectedDeployment.id,
          d.executedDeployment.id,
          d.selectedDeployment.rateCardId,
          d.selectedDeployment.expectedCost?.amount ?? null,
          d.selectedDeployment.expectedCost?.currency ?? null,
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
          (row.deployment_health === null
            ? null
            : String(row.deployment_health)) !==
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
        "SELECT d.*,s.provider,s.provider_model selected_model,s.provider_deployment selected_provider_deployment,e.provider executed_provider,e.provider_model executed_model,e.provider_deployment executed_provider_deployment,e.capabilities executed_capabilities FROM ai_routing_decisions d JOIN ai_routing_deployments s ON s.tenant_id=d.tenant_id AND s.id=d.selected_deployment_id JOIN ai_routing_deployments e ON e.tenant_id=d.tenant_id AND e.id=d.executed_deployment_id WHERE d.tenant_id=$1 AND d.id=$2",
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
    const rolloutResult = await this.pool.query(
      "SELECT * FROM ai_routing_rollout_versions WHERE tenant_id=$1 AND team_id=$2 AND mode='shadow' ORDER BY created_at DESC,id DESC LIMIT 1",
      [tenantId, teamId],
    );
    if (!rolloutResult.rowCount)
      return {
        teamId,
        rolloutVersionId: null,
        policyVersionId: null,
        mappingVersionId: null,
        fixedDeploymentId: null,
        sampleWindowStart: null,
        sampleWindowEnd: null,
        sampleSize: 0,
        selectedDistribution: {},
        executedDistribution: {},
        expectedCost: null,
        actualCost: null,
        currency: null,
        estimatedSavings: null,
        fallbackRate: "0",
        errorRate: "0",
        regretRate: "0",
        routerOverheadMs: "0",
        decisions: [],
      };
    const rollout = rolloutFrom(rolloutResult.rows[0]);
    const result = await this.pool.query(
      "SELECT d.*,e.service_class executed_service_class,o.outcome observation_outcome,o.actual_cost observation_actual_cost,o.currency observation_currency FROM ai_routing_decisions d JOIN ai_routing_deployments e ON e.tenant_id=d.tenant_id AND e.id=d.executed_deployment_id LEFT JOIN LATERAL (SELECT outcome,actual_cost,currency FROM ai_routing_decision_observations WHERE tenant_id=d.tenant_id AND decision_id=d.id ORDER BY observed_at DESC LIMIT 1) o ON true WHERE d.tenant_id=$1 AND d.team_id=$2 AND d.rollout_version_id=$3 AND d.shadow=true ORDER BY d.created_at DESC,d.id DESC LIMIT 1000",
      [tenantId, teamId, rollout.id],
    );
    const selectedDistribution: Record<string, number> = {};
    const executedDistribution: Record<string, number> = {};
    let expected = 0n,
      expectedCount = 0,
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
      if (row.expected_cost !== null && row.currency !== null) {
        currencies.add(String(row.currency));
        expected += parse(String(row.expected_cost));
        expectedCount++;
      }
      if (
        row.observation_actual_cost !== null &&
        row.observation_currency !== null
      ) {
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
    const comparable =
      size > 0 && expectedCount === size && currencies.size === 1;
    const currency = comparable ? [...currencies][0]! : null;
    return {
      teamId,
      rolloutVersionId: rollout.id,
      policyVersionId: rollout.policyVersionId,
      mappingVersionId: rollout.mappingVersionId,
      fixedDeploymentId: rollout.fixedDeploymentId,
      sampleWindowStart: size ? new Date(result.rows.at(-1).created_at) : null,
      sampleWindowEnd: size ? new Date(result.rows[0].created_at) : null,
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
      decisions: result.rows.map((row) => ({
        id: String(row.id),
        createdAt: new Date(row.created_at),
        selectedServiceClass: String(row.selected_service_class),
        selectedDeploymentId: String(row.selected_deployment_id),
        executedDeploymentId: String(row.executed_deployment_id),
        executedServiceClass: String(row.executed_service_class),
        selectionStatus: String(row.selection_status),
        reasonCode: String(row.reason_code),
        shadow: Boolean(row.shadow),
        expectedCost:
          row.expected_cost === null ? null : String(row.expected_cost),
        currency: row.currency === null ? null : String(row.currency),
        outcome: row.observation_outcome
          ? String(row.observation_outcome)
          : null,
      })),
    };
  }
}
