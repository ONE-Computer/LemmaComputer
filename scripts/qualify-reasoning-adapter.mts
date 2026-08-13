import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { agentReasoningAdapterReview, reasoningRouteReview } from "@lemmacomputer/model-router";

const identifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const boundedTextSchema = z.string().trim().min(1).max(500);
const effortSchema = z.enum(["low", "medium", "high"]);
const requiredObservationSchema = z.literal(true);
const nonnegativeDecimalSchema = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);

const usageUnitSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("reported"), quantity: nonnegativeDecimalSchema }),
  z.strictObject({ status: z.literal("unavailable") }),
]);

const moneyEvidenceSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.enum(["provider-confirmed", "estimated"]),
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount: nonnegativeDecimalSchema,
  }),
  z.strictObject({ status: z.literal("unavailable") }),
]);

const liveLevelSchema = z.strictObject({
  requestedEffort: effortSchema,
  resolvedEffort: effortSchema,
  conversationId: identifierSchema,
  taskId: identifierSchema,
  usageAttemptId: identifierSchema,
  streamedTextObserved: requiredObservationSchema,
  toolLifecycle: z.strictObject({
    started: requiredObservationSchema,
    terminalState: z.literal("completed"),
  }),
  turnTerminalState: z.literal("completed"),
  latencyMs: z.number().int().positive().max(3_600_000),
  usage: z.strictObject({
    providerConfirmed: requiredObservationSchema,
    inputTokens: usageUnitSchema,
    outputTokens: usageUnitSchema,
    reasoningTokens: usageUnitSchema,
    cacheReadTokens: usageUnitSchema,
    cacheWriteTokens: usageUnitSchema,
    cost: moneyEvidenceSchema,
  }),
});

export const reasoningAdapterEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  qualificationId: identifierSchema,
  recordedAt: z.string().datetime({ offset: true }),
  sourceCommit: gitCommitSchema,
  runtime: z.strictObject({
    reviewState: z.enum(["candidate", "qualified"]),
    agentCatalogId: identifierSchema,
    clientVersion: identifierSchema,
    discoveryId: identifierSchema.optional(),
    qualificationId: identifierSchema.optional(),
    proposedEffortLevels: z.array(effortSchema).min(1).max(3),
  }),
  route: z.strictObject({
    reviewState: z.enum(["candidate", "qualified"]),
    discoveryId: identifierSchema.optional(),
    qualificationId: identifierSchema,
    provider: z.enum(["foundry", "openai", "anthropic", "bedrock", "glm"]),
    providerModel: identifierSchema,
    deploymentId: identifierSchema,
    mappingVersionId: identifierSchema,
  }),
  levels: z.array(liveLevelSchema).min(1).max(3),
  autoResolution: z.strictObject({
    conversationId: identifierSchema,
    resolvedEffort: effortSchema,
    organizationMaximumApplied: requiredObservationSchema,
  }),
  resume: z.strictObject({
    conversationId: identifierSchema,
    requestedEffort: effortSchema,
    resolvedEffort: effortSchema,
    sameSignedBindingSemantics: requiredObservationSchema,
    streamedTextObserved: requiredObservationSchema,
    toolTerminalState: z.literal("completed"),
    turnTerminalState: z.literal("completed"),
  }),
  concurrency: z.strictObject({
    firstConversationId: identifierSchema,
    firstEffort: effortSchema,
    secondConversationId: identifierSchema,
    secondEffort: effortSchema,
    signedBindingsIsolated: requiredObservationSchema,
    usageAttemptsIsolated: requiredObservationSchema,
  }),
  negativeCases: z.strictObject({
    forgedNativeReasoningField: z.literal("failed-closed"),
    overPolicyEffort: z.literal("failed-closed"),
    staleRuntimeVersion: z.literal("failed-closed"),
    unsupportedRoute: z.literal("failed-closed"),
    providerMismatch: z.literal("failed-closed"),
  }),
  hiddenReasoningSuppression: z.strictObject({
    transcript: requiredObservationSchema,
    activity: requiredObservationSchema,
    logs: requiredObservationSchema,
    artifacts: requiredObservationSchema,
  }),
  evidenceLimitations: z.array(boundedTextSchema).max(20),
}).superRefine((value, context) => {
  const proposed = new Set(value.runtime.proposedEffortLevels);
  if (proposed.size !== value.runtime.proposedEffortLevels.length) {
    context.addIssue({ code: "custom", path: ["runtime", "proposedEffortLevels"], message: "Proposed effort levels must be unique" });
  }
  const observed = new Set(value.levels.map((level) => level.requestedEffort));
  if (observed.size !== value.levels.length || proposed.size !== observed.size || [...proposed].some((effort) => !observed.has(effort))) {
    context.addIssue({ code: "custom", path: ["levels"], message: "Every proposed effort level needs exactly one live observation" });
  }
  value.levels.forEach((level, index) => {
    if (level.requestedEffort !== level.resolvedEffort) {
      context.addIssue({ code: "custom", path: ["levels", index, "resolvedEffort"], message: "An explicitly qualified level must resolve without substitution" });
    }
  });
  if (!proposed.has(value.autoResolution.resolvedEffort)) {
    context.addIssue({ code: "custom", path: ["autoResolution", "resolvedEffort"], message: "Auto must resolve to a proposed qualified level" });
  }
  if (value.route.reviewState === "candidate" && !value.route.discoveryId) {
    context.addIssue({ code: "custom", path: ["route", "discoveryId"], message: "A candidate route must name its reviewed discovery" });
  }
  if (value.route.reviewState === "qualified" && value.route.discoveryId) {
    context.addIssue({ code: "custom", path: ["route", "discoveryId"], message: "A qualified route must use only its qualification ID" });
  }
  if (value.runtime.reviewState === "candidate" && (!value.runtime.discoveryId || value.runtime.qualificationId)) {
    context.addIssue({ code: "custom", path: ["runtime"], message: "A candidate runtime must use only its reviewed discovery ID" });
  }
  if (value.runtime.reviewState === "qualified" && (!value.runtime.qualificationId || value.runtime.discoveryId)) {
    context.addIssue({ code: "custom", path: ["runtime"], message: "A qualified runtime must use only its qualification ID" });
  }
  const resumed = value.levels.find((level) => level.conversationId === value.resume.conversationId);
  if (!resumed || resumed.requestedEffort !== value.resume.requestedEffort || resumed.resolvedEffort !== value.resume.resolvedEffort) {
    context.addIssue({ code: "custom", path: ["resume"], message: "Resume evidence must retain one observed conversation effort" });
  }
  const first = value.levels.find((level) => level.conversationId === value.concurrency.firstConversationId);
  const second = value.levels.find((level) => level.conversationId === value.concurrency.secondConversationId);
  if (
    !first || !second
    || first.requestedEffort !== value.concurrency.firstEffort
    || second.requestedEffort !== value.concurrency.secondEffort
    || first.conversationId === second.conversationId
    || first.requestedEffort === second.requestedEffort
  ) {
    context.addIssue({ code: "custom", path: ["concurrency"], message: "Concurrency evidence needs two observed conversations at different efforts" });
  }
});

export type ReasoningAdapterEvidence = z.infer<typeof reasoningAdapterEvidenceSchema>;

export class ReasoningAdapterQualificationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReasoningAdapterQualificationError";
  }
}

const fail = (code: string): never => {
  throw new ReasoningAdapterQualificationError(code);
};

const sensitiveEvidencePattern = /(?:\bBearer\s+[A-Za-z0-9._~-]+|\bsk-[A-Za-z0-9_-]{8,}|api[_ -]?key|client[_ -]?secret|signed\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i;

export const validateReasoningAdapterEvidence = (
  input: unknown,
  options: { expectedSourceCommit?: string } = {},
): ReasoningAdapterEvidence => {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? "";
  } catch {
    fail("EVIDENCE_CONTRACT_INVALID");
  }
  if (sensitiveEvidencePattern.test(serialized)) fail("SENSITIVE_EVIDENCE_REJECTED");
  const parsed = reasoningAdapterEvidenceSchema.safeParse(input);
  if (!parsed.success) fail("EVIDENCE_CONTRACT_INVALID");
  const evidence = parsed.data;
  if (options.expectedSourceCommit && evidence.sourceCommit !== options.expectedSourceCommit) {
    fail("SOURCE_COMMIT_MISMATCH");
  }
  const review = agentReasoningAdapterReview({
    agentCatalogId: evidence.runtime.agentCatalogId,
    clientVersion: evidence.runtime.clientVersion,
  });
  if (!review) fail("RUNTIME_REVIEW_NOT_FOUND");
  if (evidence.runtime.reviewState === "candidate") {
    if (review.reviewStatus !== "discovery") fail("RUNTIME_REVIEW_STATE_MISMATCH");
    if (review.discoveryId !== evidence.runtime.discoveryId) fail("RUNTIME_DISCOVERY_MISMATCH");
  } else {
    if (review.reviewStatus !== "qualified") fail("RUNTIME_REVIEW_STATE_MISMATCH");
    if (review.qualificationId !== evidence.runtime.qualificationId) fail("RUNTIME_QUALIFICATION_MISMATCH");
  }
  if (evidence.runtime.proposedEffortLevels.some((effort) => !review.effortLevels.includes(effort))) {
    fail("RUNTIME_EFFORT_NOT_REVIEWED");
  }
  const routeReview = reasoningRouteReview({
    provider: evidence.route.provider,
    providerModel: evidence.route.providerModel,
  });
  if (!routeReview) fail("ROUTE_REVIEW_NOT_FOUND");
  if (evidence.route.reviewState === "candidate") {
    if (routeReview.reviewStatus !== "discovery") fail("ROUTE_REVIEW_STATE_MISMATCH");
    if (routeReview.discoveryId !== evidence.route.discoveryId) fail("ROUTE_DISCOVERY_MISMATCH");
  } else {
    if (routeReview.reviewStatus !== "qualified") fail("ROUTE_REVIEW_STATE_MISMATCH");
    if (routeReview.qualificationId !== evidence.route.qualificationId) fail("ROUTE_QUALIFICATION_MISMATCH");
  }
  if (evidence.runtime.proposedEffortLevels.some((effort) => !routeReview.effortLevels.includes(effort))) {
    fail("ROUTE_EFFORT_NOT_REVIEWED");
  }
  return evidence;
};

export const runReasoningAdapterQualificationCli = async (argv = process.argv.slice(2)) => {
  const evidenceArgument = argv.find((argument) => argument.startsWith("--evidence="));
  if (!evidenceArgument || argv.length !== 1) fail("USAGE");
  const evidencePath = resolve(evidenceArgument.slice("--evidence=".length));
  let input: unknown;
  try {
    input = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch {
    fail("EVIDENCE_FILE_INVALID");
  }
  let sourceCommit: string;
  try {
    sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    fail("SOURCE_COMMIT_UNAVAILABLE");
  }
  const evidence = validateReasoningAdapterEvidence(input, { expectedSourceCommit: sourceCommit });
  process.stdout.write(
    `Reasoning adapter evidence passed for ${evidence.runtime.agentCatalogId} ${evidence.runtime.clientVersion} through ${evidence.route.provider}/${evidence.route.providerModel}. No credentials or hidden reasoning were read.\n`,
  );
};

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  runReasoningAdapterQualificationCli().catch((error) => {
    const code = error instanceof ReasoningAdapterQualificationError ? error.code : "UNEXPECTED_FAILURE";
    process.stderr.write(`Reasoning adapter qualification failed (${code}). No evidence values were printed.\n`);
    process.exitCode = 1;
  });
}
