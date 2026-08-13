import { LemmaComputerError } from "@lemmacomputer/contracts";
import type { ProviderSettingRecord, SpendRange, SpendReport } from "@lemmacomputer/workspace-store";
import { z } from "zod";

const dateTime = z.string().datetime({ offset: true });
const querySchema = z.strictObject({
  from: dateTime.optional(),
  to: dateTime.optional(),
  asOf: dateTime.optional(),
});

export const parsePersonalAiUsageQuery = (input: unknown, now = new Date()): SpendRange => {
  const parsed = querySchema.parse(input ?? {});
  const asOf = parsed.asOf ? new Date(parsed.asOf) : now;
  const to = parsed.to ? new Date(parsed.to) : asOf;
  const from = parsed.from
    ? new Date(parsed.from)
    : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  const duration = to.getTime() - from.getTime();
  if (duration <= 0 || duration > 366 * 86_400_000 || asOf.getTime() < from.getTime()) {
    throw new LemmaComputerError("PERSONAL_AI_USAGE_RANGE_INVALID", "Choose a date range of up to 366 days", 400);
  }
  return { from, to, receivedBefore: asOf };
};

const personalGroup = <T extends { costs: unknown; providerConfirmedCosts: unknown; usage: unknown }>(group: T) => ({
  costs: group.costs,
  providerConfirmedCosts: group.providerConfirmedCosts,
  usage: group.usage,
  attemptCount: "attemptCount" in group ? group.attemptCount : 0,
  eventCount: "eventCount" in group ? group.eventCount : 0,
  failedAttemptCount: "failedAttemptCount" in group ? group.failedAttemptCount : 0,
  unknownCostEventCount: "unknownCostEventCount" in group ? group.unknownCostEventCount : 0,
  incompleteCostEventCount: "incompleteCostEventCount" in group ? group.incompleteCostEventCount : 0,
  correctedEventCount: "correctedEventCount" in group ? group.correctedEventCount : 0,
});

export const personalAiUsageReport = (
  report: SpendReport,
  providers: ProviderSettingRecord[] = [],
) => ({
  contractVersion: 1 as const,
  range: report.range,
  asOf: report.asOf,
  state: report.state,
  totals: {
    ...personalGroup(report.totals),
    delayedAttemptCount: report.totals.delayedAttemptCount,
  },
  costCoverage: {
    status: report.costCoverage.status,
    unpricedUsage: report.costCoverage.unpricedUsage,
    delayedReporting: report.costCoverage.delayedReporting,
    failedWithoutUsage: report.costCoverage.failedWithoutUsage,
  },
  breakdowns: {
    workspaces: report.breakdowns.workspaces.map((group) => ({
      workspaceId: group.workspaceId,
      ...personalGroup(group),
    })),
    agents: report.breakdowns.agents.map((group) => ({
      agentId: group.agentId,
      ...personalGroup(group),
    })),
  },
  providerUsage: report.breakdowns.resolvedModels.map((group) => ({
    provider: group.provider,
    usage: group.usage,
  })),
  servingGridAssumptions: providers
    .filter((provider) => typeof provider.configuration.emissionsRegion === "string")
    .map((provider) => ({
      provider: provider.provider,
      emissionsRegion: provider.configuration.emissionsRegion!,
    })),
  trend: report.trend && {
    previousRange: report.trend.previousRange,
    costs: report.trend.costs,
    providerConfirmedCosts: report.trend.providerConfirmedCosts,
    attemptCount: report.trend.attemptCount,
    attemptCountDelta: report.trend.attemptCountDelta,
    costDeltas: report.trend.costDeltas,
  },
  privacy: {
    scope: "authenticated_member" as const,
    description: "Only AI usage attributed to your active organization membership is included.",
    contentExcluded: true,
  },
});
