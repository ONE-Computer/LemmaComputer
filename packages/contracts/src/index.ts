import { createHash } from "node:crypto";
import { z } from "zod";

export const workspaceStates = [
  "not_created",
  "provisioning",
  "ready",
  "open",
  "restarting",
  "stopping",
  "stopped",
  "failed",
] as const;

export const workspaceStateSchema = z.enum(workspaceStates);
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

export const readinessStateSchema = z.enum(["ready", "checking", "unavailable", "failed"]);
export type ReadinessState = z.infer<typeof readinessStateSchema>;

export const readinessSchema = z.object({
  identity: readinessStateSchema,
  network: readinessStateSchema,
  models: readinessStateSchema,
  tools: readinessStateSchema,
});

export const modelRouteSchema = z.object({
  alias: z.string().min(1).max(128),
  status: z.enum(["ready", "failed"]),
  fallback: z.literal("none"),
  capabilities: z.object({
    vision: z.boolean(),
  }).strict(),
  limits: z.object({
    requestsPerMinute: z.number().int().positive(),
    tokensPerMinute: z.number().int().positive().nullable(),
    maxParallelRequests: z.number().int().positive(),
  }),
});

export const executionModeSchema = z.enum(["managed", "disposable-open"]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const egressModeSchema = z.enum(["restricted", "full-web"]);
export type EgressMode = z.infer<typeof egressModeSchema>;

export const sandboxProfileIds = ["claude-desktop-standard-v1", "kasm-persistent-standard", "disposable-open-v1"] as const;
export const sandboxProfileIdSchema = z.enum(sandboxProfileIds);
export type SandboxProfileId = z.infer<typeof sandboxProfileIdSchema>;

// Applications are an owned, policy-bounded catalog. The reviewed workspace
// image contains both browsers, while each sandbox configuration decides which
// launchers are exposed on its next start.
export const sandboxApplicationIds = ["firefox", "google-chrome"] as const;
export const sandboxApplicationIdSchema = z.enum(sandboxApplicationIds);
export type SandboxApplicationId = z.infer<typeof sandboxApplicationIdSchema>;

export const sandboxApplicationSchema = z.object({
  id: sandboxApplicationIdSchema,
  displayName: z.string().min(1),
  category: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
}).strict();
export type SandboxApplication = z.infer<typeof sandboxApplicationSchema>;

// A policy always refers to a stable ONEComputer alias. Provider Settings can
// replace the private deployment behind this alias without rewriting signed
// workspace policy documents.
export const bedrockApiKeyRouteAlias = "onecomputer-bedrock" as const;

export const sandboxModelAliases = ["onecomputer-claude", "onecomputer-openai", "onecomputer-glm", "onecomputer-assistant", bedrockApiKeyRouteAlias] as const;
export const sandboxModelAliasSchema = z.enum(sandboxModelAliases);
export type SandboxModelAlias = z.infer<typeof sandboxModelAliasSchema>;

// This demo route intentionally has a small, reviewed allow-list. It is not
// an arbitrary Bedrock pass-through: the only private deployment is a global
// Claude Sonnet 4.5 inference profile routed through LiteLLM's Bedrock
// Converse provider. The supported regions are the demo's explicitly checked
// global-profile endpoints, including Singapore.
export const bedrockApiKeyRegions = ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"] as const;
export const bedrockApiKeyRegionSchema = z.enum(bedrockApiKeyRegions);
export type BedrockApiKeyRegion = z.infer<typeof bedrockApiKeyRegionSchema>;

export const bedrockApiKeyModelProfileIds = ["claude-sonnet-4-5-global"] as const;
export const bedrockApiKeyModelProfileIdSchema = z.enum(bedrockApiKeyModelProfileIds);
export type BedrockApiKeyModelProfileId = z.infer<typeof bedrockApiKeyModelProfileIdSchema>;

export const bedrockApiKeyModelProfileSchema = z.object({
  id: bedrockApiKeyModelProfileIdSchema,
  litellmModel: z.string().regex(/^bedrock\/converse\//),
  regions: z.array(bedrockApiKeyRegionSchema).min(1),
  capabilities: z.object({
    vision: z.boolean(),
    streaming: z.boolean(),
    toolCalls: z.boolean(),
    structuredOutput: z.boolean(),
    computerUse: z.boolean(),
  }).strict(),
  limits: z.object({
    contextWindowTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
  }).strict(),
  pricing: z.object({
    inputUsdPerMillionTokens: z.number().positive(),
    outputUsdPerMillionTokens: z.number().positive(),
  }).strict(),
}).strict();
export type BedrockApiKeyModelProfile = z.infer<typeof bedrockApiKeyModelProfileSchema>;

export const approvedBedrockApiKeyModelProfiles: readonly BedrockApiKeyModelProfile[] = Object.freeze([
  bedrockApiKeyModelProfileSchema.parse({
    id: "claude-sonnet-4-5-global",
    litellmModel: "bedrock/converse/global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    regions: bedrockApiKeyRegions,
    capabilities: {
      vision: true,
      streaming: true,
      toolCalls: true,
      structuredOutput: true,
      computerUse: true,
    },
    limits: {
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
    },
    pricing: {
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
    },
  }),
]);

export const bedrockApiKeyRouteConfigurationSchema = z.object({
  // This value is accepted once by a private Control-to-LiteLLM request. It
  // must never appear in a read model, trace, activity event, or workspace.
  apiKey: z.string().trim().min(16).max(4_096),
  region: bedrockApiKeyRegionSchema,
  modelProfileId: bedrockApiKeyModelProfileIdSchema,
}).strict().superRefine((value, context) => {
  const profile = approvedBedrockApiKeyModelProfiles.find((candidate) => candidate.id === value.modelProfileId);
  if (!profile || !profile.regions.includes(value.region)) {
    context.addIssue({
      code: "custom",
      path: ["region"],
      message: "The selected Bedrock inference profile is not approved in that region",
    });
  }
});
export type BedrockApiKeyRouteConfiguration = z.infer<typeof bedrockApiKeyRouteConfigurationSchema>;

export const openAiProviderModelIds = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;
export const openAiProviderModelIdSchema = z.enum(openAiProviderModelIds);
export type OpenAiProviderModelId = z.infer<typeof openAiProviderModelIdSchema>;

export const anthropicProviderModelIds = ["claude-sonnet-4-6", "claude-opus-4-8"] as const;
export const anthropicProviderModelIdSchema = z.enum(anthropicProviderModelIds);
export type AnthropicProviderModelId = z.infer<typeof anthropicProviderModelIdSchema>;

export const glmProviderModelIds = ["glm-5", "glm-5.2"] as const;
export const glmProviderModelIdSchema = z.enum(glmProviderModelIds);
export type GlmProviderModelId = z.infer<typeof glmProviderModelIdSchema>;

export const providerModelIds = [
  ...openAiProviderModelIds,
  ...anthropicProviderModelIds,
  ...glmProviderModelIds,
] as const;
export const providerModelIdSchema = z.enum(providerModelIds);
export type ProviderModelId = z.infer<typeof providerModelIdSchema>;

// Provider Settings persists only read-safe route selection metadata. The API
// key itself is deliberately absent: LiteLLM owns its encrypted credential
// record and Control stores only approved model/region choices.
export const providerSettingMetadataSchema = z.strictObject({
  region: bedrockApiKeyRegionSchema.optional(),
  modelProfileId: bedrockApiKeyModelProfileIdSchema.optional(),
  modelId: providerModelIdSchema.optional(),
}).refine(
  (value) => {
    const hasBedrockSelection = value.region !== undefined || value.modelProfileId !== undefined;
    return hasBedrockSelection
      ? value.region !== undefined && value.modelProfileId !== undefined && value.modelId === undefined
      : true;
  },
  "Provider metadata must contain either an OpenAI model or a complete Bedrock selection",
);
export type ProviderSettingMetadata = z.infer<typeof providerSettingMetadataSchema>;

export const sandboxProfileSchema = z.object({
  id: sandboxProfileIdSchema,
  version: z.literal(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  executionMode: executionModeSchema.default("managed"),
  egressMode: egressModeSchema.default("restricted"),
  dataGuidance: z.string().min(1),
  client: z.enum([
    "ONEComputer managed workspace",
    "ONEComputer open workspace",
    "ONEComputer qualification CLI",
  ]),
  clientVersion: z.string().min(1),
  persistence: z.literal("persistent-home"),
  network: z.literal("gateway-only"),
  resources: z.object({ cpus: z.number().positive(), memoryGiB: z.number().positive() }),
});
export type SandboxProfile = z.infer<typeof sandboxProfileSchema>;

export const agentCatalogIds = ["claude-desktop", "claude-cli", "codex-cli", "opencode-cli", "hermes-desktop", "hermes-claw"] as const;
export const agentCatalogIdSchema = z.enum(agentCatalogIds);
export type AgentCatalogId = z.infer<typeof agentCatalogIdSchema>;

export const chatAgentCatalogIds = ["claude-cli", "codex-cli", "opencode-cli", "hermes-claw"] as const;
export const chatAgentCatalogIdSchema = z.enum(chatAgentCatalogIds);
export type ChatAgentCatalogId = z.infer<typeof chatAgentCatalogIdSchema>;

export const harnessTransportSchema = z.enum(["native", "acp"]);
export type HarnessTransport = z.infer<typeof harnessTransportSchema>;

export const harnessRuntimeCapabilitiesSchema = z.object({
  loadSession: z.boolean(),
  resumeSession: z.boolean(),
  cancelTurn: z.boolean(),
  permissions: z.boolean(),
  fsReadTextFile: z.boolean(),
  fsWriteTextFile: z.boolean(),
  terminal: z.boolean(),
  mcp: z.boolean(),
}).strict();
export type HarnessRuntimeCapabilities = z.infer<typeof harnessRuntimeCapabilitiesSchema>;

export const harnessRuntimeSchema = z.object({
  transport: harnessTransportSchema,
  protocolVersion: z.string().trim().min(1).max(32),
  implementation: z.string().trim().min(1).max(80),
  implementationVersion: z.string().trim().min(1).max(40),
  capabilities: harnessRuntimeCapabilitiesSchema,
}).strict();
export type HarnessRuntime = z.infer<typeof harnessRuntimeSchema>;

export const scheduleStateSchema = z.enum(["enabled", "paused"]);
export type ScheduleState = z.infer<typeof scheduleStateSchema>;

export const scheduleRunStateSchema = z.enum([
  "claimed",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);
export type ScheduleRunState = z.infer<typeof scheduleRunStateSchema>;

export const scheduleCronExpressionSchema = z.string().trim().min(9).max(120).refine(
  (value) => value.split(/\s+/).length === 5,
  "A five-field cron expression is required",
);
export const scheduleTimeZoneSchema = z.string().trim().min(1).max(100);

export const createScheduleSchema = z.object({
  title: z.string().trim().min(1).max(120),
  workspaceId: z.uuid(),
  agentCatalogId: chatAgentCatalogIdSchema,
  prompt: z.string().trim().min(1).max(16_000),
  cronExpression: scheduleCronExpressionSchema,
  timeZone: scheduleTimeZoneSchema,
  state: scheduleStateSchema.default("enabled"),
}).strict();
export type CreateSchedule = z.infer<typeof createScheduleSchema>;

export const updateScheduleSchema = createScheduleSchema.partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one schedule field is required",
);
export type UpdateSchedule = z.infer<typeof updateScheduleSchema>;

export const scheduleSchema = createScheduleSchema.omit({ prompt: true }).extend({
  id: z.uuid(),
  prompt: z.string().max(16_000),
  nextRunAt: z.iso.datetime().nullable(),
  lastRunAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type Schedule = z.infer<typeof scheduleSchema>;

export const scheduleRunSchema = z.object({
  id: z.uuid(),
  scheduleId: z.uuid(),
  scheduledFor: z.iso.datetime(),
  state: scheduleRunStateSchema,
  sessionId: z.string().min(1).max(200).nullable(),
  failureCode: z.string().min(1).max(100).nullable(),
  failureSummary: z.string().min(1).max(500).nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type ScheduleRun = z.infer<typeof scheduleRunSchema>;

export const executeScheduleRunSchema = z.object({
  runId: z.uuid(),
  leaseToken: z.uuid(),
}).strict();

export const agentProfileSchema = z.enum([
  "onecomputer-default-agent",
  "claude-desktop-managed-v1",
  "claude-cli-managed-v1",
  "codex-cli-managed-v1",
  "opencode-cli-managed-v1",
  "hermes-desktop-managed-v1",
  "hermes-claw-managed-v1",
]);
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const agentCatalogEntrySchema = z.object({
  id: agentCatalogIdSchema,
  displayName: z.string().min(1),
  clientVersion: z.string().min(1),
  description: z.string().min(1),
  license: z.string().min(1),
  source: z.url(),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  resources: z.object({ memoryMiB: z.number().int().positive() }),
}).strict();
export type AgentCatalogEntry = z.infer<typeof agentCatalogEntrySchema>;

export const ownedAgentCatalog: readonly AgentCatalogEntry[] = Object.freeze([
  agentCatalogEntrySchema.parse({
    id: "claude-desktop",
    displayName: "Claude Desktop",
    clientVersion: "1.22209.3",
    description: "Managed desktop client routed through ONEComputer.",
    license: "Anthropic commercial distribution",
    source: "https://downloads.claude.ai/claude-desktop/apt/stable/",
    artifactSha256: "d427f46ac9233dbc4d8a441a602f09f750b8a5f05d1fc7a00285d7a6ce07655c",
    resources: { memoryMiB: 1536 },
  }),
  agentCatalogEntrySchema.parse({
    id: "claude-cli",
    displayName: "Claude CLI",
    clientVersion: "2.1.215",
    description: "Pinned Claude CLI routed through its own governed ONEComputer identity.",
    license: "Anthropic commercial distribution",
    source: "https://downloads.claude.ai/claude-code-releases/2.1.215/linux-x64/claude.zst",
    artifactSha256: "7ff9594e53cd89d1af9ceb3c18d3d70be1a5c6d27475e31ee2bed65d748f18c0",
    resources: { memoryMiB: 1024 },
  }),
  agentCatalogEntrySchema.parse({
    id: "codex-cli",
    displayName: "Codex CLI",
    clientVersion: "0.144.4",
    description: "Pinned Codex SDK and CLI runtime routed through its own governed ONEComputer identity.",
    license: "Apache-2.0",
    source: "https://pypi.org/project/openai-codex/0.144.4/",
    artifactSha256: "de1513a6e94b9a8d7728a3b74298bc1469428ade10ba0ef2d5db47dd1cb606f5",
    resources: { memoryMiB: 1024 },
  }),
  agentCatalogEntrySchema.parse({
    id: "opencode-cli",
    displayName: "OpenCode CLI",
    clientVersion: "1.18.10",
    description: "Pinned OpenCode ACP runtime routed through its own governed ONEComputer identity.",
    license: "MIT",
    source: "https://www.npmjs.com/package/opencode-ai/v/1.18.10",
    artifactSha256: "c135d5cb88407888f7d67ddb4a2e30f27109a8b9e8922282674b8abb34226bd8",
    resources: { memoryMiB: 1024 },
  }),
  agentCatalogEntrySchema.parse({
    id: "hermes-desktop",
    displayName: "Hermes Agent Desktop",
    clientVersion: "0.17.0",
    description: "Native Hermes Agent desktop client with a separately governed backend.",
    license: "MIT",
    source: "https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.20",
    artifactSha256: "285f3fc134ff466a90065e1517801a68993733b807158ee8f32aa01613786990",
    resources: { memoryMiB: 1536 },
  }),
  agentCatalogEntrySchema.parse({
    id: "hermes-claw",
    displayName: "Hermes Agent CLI",
    clientVersion: "0.19.0",
    description: "Pinned Hermes Agent CLI configured as a governed ONEComputer client.",
    license: "MIT",
    source: "https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.20",
    artifactSha256: "285f3fc134ff466a90065e1517801a68993733b807158ee8f32aa01613786990",
    resources: { memoryMiB: 768 },
  }),
]);

export const reviewedAgentSkillSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  displayName: z.string().min(1).max(80),
  description: z.string().min(1).max(180),
  defaultPrompt: z.string().min(1).max(240),
}).strict();
export type ReviewedAgentSkill = z.infer<typeof reviewedAgentSkillSchema>;

export const reviewedAgentSkillCatalog: readonly ReviewedAgentSkill[] = Object.freeze([
  reviewedAgentSkillSchema.parse({
    id: "make-a-site",
    displayName: "Make a site",
    description: "Build and publish a simple owner-only Vite site.",
    defaultPrompt: "Use $make-a-site to build and publish a simple site.",
  }),
]);

export const clipboardPolicySchema = z.object({
  enabled: z.boolean(),
  localToWorkspace: z.boolean(),
  workspaceToLocal: z.boolean(),
  maxBytes: z.number().int().positive().max(1_048_576),
}).strict();
export type ClipboardPolicy = z.infer<typeof clipboardPolicySchema>;

export const defaultClipboardPolicy: ClipboardPolicy = Object.freeze({
  enabled: true,
  localToWorkspace: true,
  workspaceToLocal: true,
  maxBytes: 65_536,
});

export const egressProtocolSchema = z.enum(["http", "https"]);
export type EgressProtocol = z.infer<typeof egressProtocolSchema>;

export const egressSecurityGroupRuleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
  action: z.enum(["allow", "deny"]),
  protocol: egressProtocolSchema,
  host: z.string().min(1).max(253),
  includeSubdomains: z.boolean(),
  port: z.number().int().min(1).max(65_535),
  purpose: z.string().min(3).max(240),
}).strict();
export type EgressSecurityGroupRule = z.infer<typeof egressSecurityGroupRuleSchema>;

export const saveEgressSecurityGroupSchema = z.object({
  securityGroupId: z.string().regex(/^esg_[a-z0-9_]{3,96}$/).optional(),
  name: z.string().min(3).max(96),
  description: z.string().min(3).max(500),
  defaultAction: z.enum(["deny", "allow-public-http-https"]).default("deny"),
  rules: z.array(egressSecurityGroupRuleSchema).max(64),
}).strict();
export type SaveEgressSecurityGroup = z.infer<typeof saveEgressSecurityGroupSchema>;

export const assignEgressSecurityGroupSchema = z.object({
  securityGroupVersionId: z.string().regex(/^egv_[a-z0-9_]{3,96}$/),
}).strict();

export const egressSecurityGroupVersionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^egv_[a-z0-9_]{3,96}$/),
  securityGroupId: z.string().regex(/^esg_[a-z0-9_]{3,96}$/),
  tenantId: z.string().min(1).max(128),
  version: z.number().int().positive(),
  name: z.string().min(3).max(96),
  description: z.string().min(3).max(500),
  defaultAction: z.enum(["deny", "allow-public-http-https"]),
  rules: z.array(egressSecurityGroupRuleSchema).max(64),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: z.string().min(1).max(128),
  createdAt: z.iso.datetime(),
  isDefault: z.boolean().optional(),
}).strict();
export type EgressSecurityGroupVersion = z.infer<typeof egressSecurityGroupVersionSchema>;

export const runtimeRestrictedEgressPolicySchema = egressSecurityGroupVersionSchema.pick({
  id: true,
  securityGroupId: true,
  version: true,
  name: true,
  description: true,
  rules: true,
  documentHash: true,
}).extend({
  schemaVersion: z.literal(2),
  mode: z.literal("restricted"),
  defaultAction: z.literal("deny"),
}).strict();

export const runtimeFullWebEgressPolicySchema = z.object({
  schemaVersion: z.literal(2),
  mode: z.literal("full-web"),
  id: z.string().regex(/^egv_[a-z0-9_]{3,96}$/),
  securityGroupId: z.string().regex(/^esg_[a-z0-9_]{3,96}$/),
  version: z.number().int().positive(),
  name: z.string().min(3).max(96),
  description: z.string().min(3).max(500),
  defaultAction: z.literal("allow-public-http-https"),
  rules: z.array(egressSecurityGroupRuleSchema).max(64),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const runtimeEgressPolicyV2Schema = z.discriminatedUnion("mode", [
  runtimeRestrictedEgressPolicySchema,
  runtimeFullWebEgressPolicySchema,
]);
export const runtimeEgressPolicySchema = z.preprocess((value) => {
  if (
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && !("mode" in value)
  ) {
    return { ...value, schemaVersion: 2, mode: "restricted" };
  }
  return value;
}, runtimeEgressPolicyV2Schema);
export type RuntimeEgressPolicy = z.infer<typeof runtimeEgressPolicySchema>;

export const sandboxConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: sandboxProfileIdSchema,
  executionMode: executionModeSchema.default("managed"),
  egressMode: egressModeSchema.default("restricted"),
  applicationIds: z.array(sandboxApplicationIdSchema).min(1).max(sandboxApplicationIds.length),
  agentIds: z.array(agentCatalogIdSchema).min(1).max(agentCatalogIds.length),
  modelAlias: sandboxModelAliasSchema,
  egress: runtimeEgressPolicySchema.nullable(),
}).strict();
export type SandboxConfiguration = z.infer<typeof sandboxConfigurationSchema>;

// The runtime still uses the historical `hermes-claw` catalog identifier.
// Workspace manifests deliberately expose the product name instead, so an
// exported workspace never leaks that implementation detail.
export const workspaceManifestAgentCatalogIds = ["claude-desktop", "claude-cli", "codex-cli", "opencode-cli", "hermes-desktop", "hermes-agent"] as const;
export const workspaceManifestAgentCatalogIdSchema = z.enum(workspaceManifestAgentCatalogIds);
export type WorkspaceManifestAgentCatalogId = z.infer<typeof workspaceManifestAgentCatalogIdSchema>;

export const workspaceManifestChatAgentCatalogIds = ["claude-cli", "codex-cli", "opencode-cli", "hermes-agent"] as const;
export const workspaceManifestChatAgentCatalogIdSchema = z.enum(workspaceManifestChatAgentCatalogIds);
export type WorkspaceManifestChatAgentCatalogId = z.infer<typeof workspaceManifestChatAgentCatalogIdSchema>;

export const workspaceManifestAgentIdFor = (catalogId: AgentCatalogId): WorkspaceManifestAgentCatalogId => (
  catalogId === "hermes-claw" ? "hermes-agent" : catalogId
);

export const agentCatalogIdForWorkspaceManifest = (catalogId: WorkspaceManifestAgentCatalogId): AgentCatalogId => (
  catalogId === "hermes-agent" ? "hermes-claw" : catalogId
);

export const workspaceManifestChatAgentIdFor = (catalogId: ChatAgentCatalogId): WorkspaceManifestChatAgentCatalogId => (
  catalogId === "hermes-claw" ? "hermes-agent" : catalogId
);

export const chatAgentCatalogIdForWorkspaceManifest = (catalogId: WorkspaceManifestChatAgentCatalogId): ChatAgentCatalogId => (
  catalogId === "hermes-agent" ? "hermes-claw" : catalogId
);

export const telegramUserIdSchema = z.string().regex(/^\d{1,20}$/);

export const workspaceManifestSandboxSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: sandboxProfileIdSchema,
  executionMode: executionModeSchema,
  egressMode: egressModeSchema,
  applicationIds: z.array(sandboxApplicationIdSchema).min(1).max(sandboxApplicationIds.length),
  agentIds: z.array(workspaceManifestAgentCatalogIdSchema).min(1).max(workspaceManifestAgentCatalogIds.length),
  modelAlias: sandboxModelAliasSchema,
  egress: runtimeEgressPolicySchema.nullable(),
}).strict();
export type WorkspaceManifestSandbox = z.infer<typeof workspaceManifestSandboxSchema>;

export const workspaceManifestChannelSchema = z.object({
  adapter: z.literal("telegram"),
  credentialRef: z.uuid(),
  credentialVersion: z.number().int().positive(),
  allowedSenderIds: z.array(telegramUserIdSchema).min(1).max(20),
  defaultAgentId: workspaceManifestChatAgentCatalogIdSchema,
  allowAgentSwitch: z.boolean(),
  inboundPolicy: z.literal("private-dm-only"),
}).strict();
export type WorkspaceManifestChannel = z.infer<typeof workspaceManifestChannelSchema>;

export const workspaceManifestSchema = z.object({
  schemaVersion: z.literal(2),
  sandbox: workspaceManifestSandboxSchema,
  channels: z.array(workspaceManifestChannelSchema).max(16).superRefine((channels, context) => {
    if (new Set(channels.map((channel) => channel.adapter)).size !== channels.length) {
      context.addIssue({ code: "custom", message: "A workspace can declare each channel adapter only once" });
    }
  }),
}).strict();
export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;

export const egressDecisionReasonSchema = z.enum([
  "EGRESS_ALLOWED",
  "EGRESS_EXPLICIT_DENY",
  "EGRESS_DEFAULT_DENY",
  "EGRESS_INVALID_HOST",
  "EGRESS_IP_LITERAL_DENIED",
  "EGRESS_DESTINATION_RESERVED",
  "EGRESS_DNS_UNAVAILABLE",
  "EGRESS_TLS_SNI_REQUIRED",
  "EGRESS_TLS_SNI_MISMATCH",
]);
export type EgressDecisionReason = z.infer<typeof egressDecisionReasonSchema>;

export const egressDecisionSchema = z.object({
  decision: z.enum(["allow", "deny"]),
  reasonCode: egressDecisionReasonSchema,
  ruleId: z.string().optional(),
}).strict();
export type EgressDecision = z.infer<typeof egressDecisionSchema>;

export const sandboxSettingsSchema = z.object({
  grantId: z.string().min(1).max(128),
  profileId: sandboxProfileIdSchema,
  applicationIds: z.array(sandboxApplicationIdSchema).min(1).max(sandboxApplicationIds.length),
  modelAlias: sandboxModelAliasSchema,
  profile: sandboxProfileSchema,
  availableProfiles: z.array(sandboxProfileSchema).min(1),
  availableApplications: z.array(sandboxApplicationSchema).min(1),
  availableModels: z.array(z.object({ alias: sandboxModelAliasSchema, displayName: z.string().min(1), provider: z.string().min(1) })).min(1),
  agentIds: z.array(agentCatalogIdSchema).min(1),
  availableAgents: z.array(agentCatalogEntrySchema).min(1),
  securityGroup: egressSecurityGroupVersionSchema.optional(),
  availableSecurityGroups: z.array(egressSecurityGroupVersionSchema).optional(),
  egress: runtimeEgressPolicySchema.optional(),
  manifest: workspaceManifestSchema,
  updatedAt: z.iso.datetime().nullable(),
});
export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;

export const saveSandboxSettingsSchema = z.object({
  grantId: z.string().min(1).max(128).default("personal"),
  profileId: sandboxProfileIdSchema,
  applicationIds: z.array(sandboxApplicationIdSchema).min(1).max(sandboxApplicationIds.length).default(["firefox"]),
  modelAlias: sandboxModelAliasSchema,
  agentIds: z.array(agentCatalogIdSchema).min(1).max(agentCatalogIds.length).refine(
    (ids) => new Set(ids).size === ids.length,
    "Agent selections must not contain duplicates",
  ),
}).strict();

export const workspaceViewSchema = z.object({
  id: z.uuid(),
  grantId: z.string().min(1),
  state: workspaceStateSchema,
  readiness: readinessSchema,
  modelRoute: modelRouteSchema.optional(),
  applications: z.array(sandboxApplicationIdSchema).min(1).optional(),
  agents: z.array(z.object({
    id: agentCatalogIdSchema,
    displayName: z.string().min(1),
    clientVersion: z.string().min(1),
    agentId: z.string().min(1),
    state: z.enum(["selected", "starting", "ready", "degraded", "unavailable"]),
  }).strict()).min(1).optional(),
  policyAssignment: z.object({
    version: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  policyIntegrity: z.lazy(() => policyIntegrityViewSchema).optional(),
  profile: z.object({
    id: z.string().min(1),
    client: z.string().min(1),
    clientVersion: z.string().min(1),
    modelAlias: z.string().min(1),
    executionMode: executionModeSchema,
    egressMode: egressModeSchema,
    persistence: z.literal("persistent-home"),
    network: z.literal("gateway-only"),
  }).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  failureCode: z.string().nullable(),
});
export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

export const createWorkspaceSchema = z.object({
  grantId: z.string().min(1).max(128).default("personal"),
});

export const identityContextSchema = z.object({
  tenantId: z.string().min(1).max(128),
  subjectId: z.string().min(1).max(128),
  audience: z.literal("onecomputer-control"),
});
export type IdentityContext = z.infer<typeof identityContextSchema>;

export const runtimeAgentPolicySchema = z.object({
  catalogId: agentCatalogIdSchema,
  agentId: z.string().min(1).max(128),
  agentProfile: agentProfileSchema,
  displayName: z.string().min(1),
  clientVersion: z.string().min(1),
  modelAlias: z.string().min(1).max(128),
  mcpServer: z.string().min(1).max(128),
  allowedTools: z.array(z.string().min(1).max(128)).min(1),
  mcpServers: z.array(z.string().min(1).max(128)).min(1).max(32).optional(),
  mcpToolPermissions: z.record(
    z.string().min(1).max(128),
    z.array(z.string().min(1).max(128)).min(1).max(512),
  ).optional(),
  connectionProjectionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  toolPolicies: z.record(
    z.string().min(1).max(128),
    z.enum(["allow", "approval_required", "deny"]),
  ),
}).strict();
export type RuntimeAgentPolicy = z.infer<typeof runtimeAgentPolicySchema>;

export const runtimePolicySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersionId: z.string().min(1),
  policyVersion: z.number().int().positive(),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceProfile: sandboxProfileIdSchema,
  executionMode: executionModeSchema.default("managed"),
  egressMode: egressModeSchema.default("restricted"),
  agentId: z.string().min(1),
  agentProfile: agentProfileSchema,
  agents: z.array(runtimeAgentPolicySchema).min(1).max(agentCatalogIds.length).optional(),
  applications: z.array(sandboxApplicationIdSchema).min(1).max(sandboxApplicationIds.length).optional(),
  networkProfile: z.literal("controlled-egress-v1"),
  egress: runtimeEgressPolicySchema.optional(),
  clipboard: clipboardPolicySchema.optional(),
  modelAlias: z.string().min(1).max(128),
  mcpServer: z.string().min(1).max(128),
  allowedTools: z.array(z.string().min(1).max(128)).min(1),
  mcpServers: z.array(z.string().min(1).max(128)).min(1).max(32).optional(),
  mcpToolPermissions: z.record(
    z.string().min(1).max(128),
    z.array(z.string().min(1).max(128)).min(1).max(512),
  ).optional(),
  connectionProjectionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  toolPolicies: z.record(
    z.string().min(1).max(128),
    z.enum(["allow", "approval_required", "deny"]),
  ),
});
export type RuntimePolicy = z.infer<typeof runtimePolicySchema>;

export const policyVerificationKeySchema = z.strictObject({
  keyId: z.string().regex(/^psk_[a-z0-9][a-z0-9_-]{2,63}$/),
  algorithm: z.literal("Ed25519"),
  publicKeySpkiBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(40).max(256),
  status: z.enum(["active", "retiring", "revoked"]),
  activatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
});
export type PolicyVerificationKey = z.infer<typeof policyVerificationKeySchema>;

export const policyVerificationKeySetSchema = z.strictObject({
  profile: z.literal("onecomputer-policy-key-set/v1"),
  keys: z.array(policyVerificationKeySchema).min(1).max(8),
});
export type PolicyVerificationKeySet = z.infer<typeof policyVerificationKeySetSchema>;

export const policyBundlePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  issuer: z.literal("onecomputer-control"),
  audience: z.literal("onecomputer-policy-enforcement"),
  tenantId: z.string().min(1).max(128),
  subjectId: z.string().min(1).max(128),
  workspaceId: z.uuid(),
  policy: runtimePolicySchema,
  routes: z.strictObject({
    modelGateway: z.url(),
    mcpControl: z.url(),
  }),
  agentResources: z.array(z.strictObject({
    catalogId: agentCatalogIdSchema,
    agentId: z.string().min(1).max(128),
    memoryMiB: z.number().int().positive().max(65_536),
  })).min(1).max(agentCatalogIds.length),
  issuedAt: z.iso.datetime(),
  notBefore: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type PolicyBundlePayload = z.infer<typeof policyBundlePayloadSchema>;

export const signedPolicyBundleSchema = z.strictObject({
  profile: z.literal("onecomputer-effective-policy/v1"),
  canonicalization: z.literal("RFC8785-JCS"),
  algorithm: z.literal("Ed25519"),
  keyId: policyVerificationKeySchema.shape.keyId,
  payload: z.string().regex(/^[A-Za-z0-9_-]+$/).min(32),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type SignedPolicyBundle = z.infer<typeof signedPolicyBundleSchema>;

export const policyIntegrityViewSchema = z.strictObject({
  state: z.enum(["match", "drift", "invalid", "expired", "unavailable"]),
  reasonCode: z.enum([
    "POLICY_INTEGRITY_MATCH",
    "POLICY_PROJECTION_DRIFT",
    "POLICY_SIGNATURE_INVALID",
    "POLICY_EXPIRED",
    "POLICY_PROJECTION_UNAVAILABLE",
  ]),
  expected: z.strictObject({
    version: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  projected: z.strictObject({
    version: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
    keyId: policyVerificationKeySchema.shape.keyId,
    expiresAt: z.iso.datetime(),
  }).nullable(),
  enforced: z.strictObject({
    version: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
    keyId: policyVerificationKeySchema.shape.keyId,
    verifiedAt: z.iso.datetime(),
  }).nullable(),
});
export type PolicyIntegrityView = z.infer<typeof policyIntegrityViewSchema>;

export const controllerCreateSchema = z.object({
  workspaceId: z.uuid(),
  correlationId: z.string().min(1).max(128),
  policy: runtimePolicySchema,
  policyBundle: signedPolicyBundleSchema,
  gateway: z.object({
    baseUrl: z.url(),
    credential: z.string().min(24),
    modelAlias: z.string().min(1).max(128),
    expiresAt: z.iso.datetime(),
  }).optional(),
  agentBridge: z.object({
    baseUrl: z.url(),
    token: z.string().min(24),
  }).optional(),
  chatRuntimes: z.array(z.object({
    catalogId: chatAgentCatalogIdSchema,
    key: z.string().min(32).max(128),
  }).strict()).min(1).max(chatAgentCatalogIds.length).optional(),
  agentGrants: z.array(z.object({
    catalogId: agentCatalogIdSchema,
    agentId: z.string().min(1).max(128),
    gateway: z.object({
      baseUrl: z.url(),
      credential: z.string().min(24),
      modelAlias: z.string().min(1).max(128),
      expiresAt: z.iso.datetime(),
    }),
    agentBridge: z.object({
      baseUrl: z.url(),
      token: z.string().min(24),
    }),
  }).strict()).min(1).max(agentCatalogIds.length).optional(),
  egressProxy: z.object({
    token: z.string().min(24),
    verificationSecret: z.string().min(32),
    expiresAt: z.iso.datetime(),
    expectedGrant: z.object({
      tenantId: z.string().min(1).max(128),
      subjectId: z.string().min(1).max(128),
      workspaceId: z.uuid(),
      agentId: z.string().min(1),
      securityGroupVersionId: z.string().regex(/^egv_[a-z0-9_]{3,96}$/),
      egressMode: egressModeSchema.default("restricted"),
      policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
  }).optional(),
});

export const controllerEgressPolicyUpdateSchema = controllerCreateSchema.pick({
  workspaceId: true,
  policy: true,
  policyBundle: true,
  egressProxy: true,
}).extend({
  egressProxy: controllerCreateSchema.shape.egressProxy.unwrap(),
}).strict();

export const chatSessionIdSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  "Invalid chat session identifier",
);
export const chatPartIdSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  "Invalid chat part identifier",
);
export const createChatSessionSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
}).strict();

export const chatTurnStateSchema = z.enum(["streaming", "needs_input", "completed", "cancelled", "failed"]);
export const chatToolStateSchema = z.enum(["running", "completed", "failed"]);
export const chatApprovalStateSchema = z.enum([
  "approval_required",
  "approved",
  "executing",
  "succeeded",
  "denied",
  "failed",
  "expired",
]);
export const chatMessageMetadataSchema = z.object({
  agentCatalogId: chatAgentCatalogIdSchema,
  turnId: chatPartIdSchema.optional(),
  state: chatTurnStateSchema,
  createdAt: z.iso.datetime(),
  source: z.enum(["web", "telegram"]).optional(),
  runtime: harnessRuntimeSchema.optional(),
}).strict();
export const chatProgressDataSchema = z.object({
  activityId: chatPartIdSchema,
  label: z.string().trim().min(1).max(240),
  state: z.enum(["running", "completed"]),
}).strict();
export const chatToolDataSchema = z.object({
  toolCallId: chatPartIdSchema,
  name: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
  state: chatToolStateSchema,
  summary: z.string().trim().min(1).max(500).optional(),
}).strict();
export const chatApprovalDataSchema = z.object({
  approvalId: chatPartIdSchema,
  toolCallId: chatPartIdSchema,
  operationId: z.uuid(),
  state: chatApprovalStateSchema,
  summary: z.string().trim().min(1).max(500),
}).strict();
export const chatTerminalDataSchema = z.object({
  turnId: chatPartIdSchema,
  state: chatTurnStateSchema.exclude(["streaming"]),
  message: z.string().trim().min(1).max(500).optional(),
}).strict();

export const chatAttachmentMediaTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/json",
  "application/xml",
  "application/yaml",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/xml",
  "text/yaml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;
export const chatAttachmentMaxFiles = 4;
export const chatAttachmentMaxBytes = 8 * 1024 * 1024;
export const chatAttachmentMaxTotalBytes = 16 * 1024 * 1024;
export const channelAttachmentMaxBytes = 20 * 1024 * 1024;
export const channelAttachmentMaxTotalBytes = channelAttachmentMaxBytes * chatAttachmentMaxFiles;
export const channelArtifactMaxBytes = 50 * 1024 * 1024;
export const channelArtifactMaxTotalBytes = 100 * 1024 * 1024;
const attachmentMaxDataUrlLength = (maxBytes: number) => Math.ceil(maxBytes / 3) * 4 + 128;
const inlineAttachmentByteLength = (part: { mediaType: string; url: string }) => {
  const prefix = `data:${part.mediaType};base64,`;
  if (!part.url.startsWith(prefix)) return Number.POSITIVE_INFINITY;
  const encoded = part.url.slice(prefix.length);
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
};
export const chatFilePartSchema = z.object({
  type: z.literal("file"),
  mediaType: z.enum(chatAttachmentMediaTypes),
  filename: z.string().trim().min(1).max(180).regex(/^[^\u0000-\u001f/\\]+$/),
  url: z.string().min(1).max(attachmentMaxDataUrlLength(channelAttachmentMaxBytes)),
}).strict().superRefine((part, context) => {
  if (!part.url.startsWith(`data:${part.mediaType};base64,`)) {
    context.addIssue({ code: "custom", path: ["url"], message: "Attachment must be an inline base64 data URL matching its media type" });
  }
});
export type ChatFilePart = z.infer<typeof chatFilePartSchema>;
export const chatFileReferenceDataSchema = z.object({
  mediaType: z.enum(chatAttachmentMediaTypes),
  filename: z.string().trim().min(1).max(180).regex(/^[^\u0000-\u001f/\\]+$/),
  storage: z.literal("workspace"),
}).strict();
export const chatArtifactSchema = z.object({
  artifactId: z.string().regex(/^artifact-[a-f0-9]{32}$/),
  mediaType: z.enum(chatAttachmentMediaTypes),
  filename: z.string().trim().min(1).max(180).regex(/^[^\u0000-\u001f/\\]+$/),
  byteLength: z.number().int().min(1).max(channelArtifactMaxBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ChatArtifact = z.infer<typeof chatArtifactSchema>;

export const chatUiMessagePartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().max(128_000),
    state: z.enum(["streaming", "done"]).optional(),
  }).strict(),
  chatFilePartSchema,
  z.object({ type: z.literal("data-file-reference"), id: chatPartIdSchema, data: chatFileReferenceDataSchema }).strict(),
  z.object({ type: z.literal("data-progress"), id: chatPartIdSchema, data: chatProgressDataSchema }).strict(),
  z.object({ type: z.literal("data-tool"), id: chatPartIdSchema, data: chatToolDataSchema }).strict(),
  z.object({ type: z.literal("data-approval"), id: chatPartIdSchema, data: chatApprovalDataSchema }).strict(),
  z.object({ type: z.literal("data-terminal"), id: chatPartIdSchema, data: chatTerminalDataSchema }).strict(),
]);
export const chatUiMessageSchema = z.object({
  id: chatPartIdSchema,
  role: z.enum(["user", "assistant"]),
  metadata: chatMessageMetadataSchema,
  parts: z.array(chatUiMessagePartSchema).min(1).max(256),
}).strict();
export type ChatUiMessage = z.infer<typeof chatUiMessageSchema>;

export const sendChatTurnSchema = z.object({
  message: chatUiMessageSchema.superRefine((message, context) => {
    const textParts = message.parts.filter((part) => part.type === "text");
    const fileParts = message.parts.filter((part) => part.type === "file");
    const invalidPart = message.parts.some((part) => part.type !== "text" && part.type !== "file");
    const attachmentBytes = fileParts.reduce((total, part) => total + inlineAttachmentByteLength(part), 0);
    const attachmentMaxBytes = message.metadata.source === "telegram"
      ? channelAttachmentMaxBytes
      : chatAttachmentMaxBytes;
    const attachmentMaxTotalBytes = message.metadata.source === "telegram"
      ? channelAttachmentMaxTotalBytes
      : chatAttachmentMaxTotalBytes;
    if (
      message.role !== "user"
      || message.metadata.state !== "completed"
      || invalidPart
      || textParts.length > 1
      || fileParts.length > chatAttachmentMaxFiles
      || fileParts.some((part) => inlineAttachmentByteLength(part) > attachmentMaxBytes)
      || (!textParts[0]?.text.trim() && fileParts.length === 0)
      || (textParts[0]?.text.length ?? 0) > 16_000
      || attachmentBytes > attachmentMaxTotalBytes
    ) {
      context.addIssue({ code: "custom", message: "A completed user message with optional bounded attachments is required" });
    }
  }),
}).strict();

export const telegramConnectionStateSchema = z.enum(["connected", "not_configured"]);
export const telegramCredentialKindSchema = z.literal("telegram_bot_token");
export const saveTelegramCredentialSchema = z.object({
  botToken: z.string().trim().min(20).max(256),
}).strict();
export const telegramCredentialStatusSchema = z.object({
  id: z.uuid(),
  kind: telegramCredentialKindSchema,
  displayName: z.string().trim().min(1).max(100),
  botUsername: z.string().regex(/^[A-Za-z0-9_]{5,32}$/).nullable(),
  version: z.number().int().positive(),
  workspaceId: z.uuid().nullable(),
  connectionId: z.uuid().nullable(),
  updatedAt: z.iso.datetime(),
}).strict();
export const telegramCredentialListSchema = z.object({
  credentials: z.array(telegramCredentialStatusSchema),
}).strict();
export type TelegramCredentialStatus = z.infer<typeof telegramCredentialStatusSchema>;
export const saveTelegramChannelConnectionSchema = z.object({
  workspaceId: z.uuid(),
  credentialId: z.uuid(),
  allowedUserIds: z.array(telegramUserIdSchema).min(1).max(20),
  defaultAgentId: chatAgentCatalogIdSchema,
  allowAgentSwitch: z.boolean().default(false),
}).strict();
export const telegramChannelConnectionStatusSchema = z.object({
  state: telegramConnectionStateSchema,
  connectionId: z.uuid().nullable(),
  workspaceId: z.uuid().nullable(),
  credentialId: z.uuid().nullable(),
  allowedUserIds: z.array(telegramUserIdSchema).max(20),
  allowedUserCount: z.number().int().nonnegative(),
  defaultAgentId: chatAgentCatalogIdSchema.nullable(),
  allowAgentSwitch: z.boolean(),
  botUsername: z.string().regex(/^[A-Za-z0-9_]{5,32}$/).nullable(),
  tokenVersion: z.number().int().positive().nullable(),
  updatedAt: z.iso.datetime().nullable(),
}).strict();
export type TelegramChannelConnectionStatus = z.infer<typeof telegramChannelConnectionStatusSchema>;

export const channelBrokerIdentitySchema = identityContextSchema.pick({
  tenantId: true,
  subjectId: true,
}).extend({
  audience: z.literal("onecomputer-control").default("onecomputer-control"),
});
export const channelBrokerSaveConnectionSchema = saveTelegramChannelConnectionSchema.extend({
  identity: channelBrokerIdentitySchema,
}).strict();
export const channelBrokerCredentialOwnerSchema = z.object({
  identity: channelBrokerIdentitySchema,
  credentialId: z.uuid(),
}).strict();
export const channelBrokerSaveCredentialSchema = saveTelegramCredentialSchema.extend({
  identity: channelBrokerIdentitySchema,
  credentialId: z.uuid().optional(),
}).strict();
export const channelBrokerOwnerSchema = z.object({
  identity: channelBrokerIdentitySchema,
  workspaceId: z.uuid().optional(),
}).strict();
export const channelRouteSchema = z.object({
  connectionId: z.uuid(),
  identity: channelBrokerIdentitySchema,
  workspaceId: z.uuid(),
  agentCatalogId: chatAgentCatalogIdSchema,
  externalSenderId: telegramUserIdSchema,
}).strict();
export const channelTurnRequestSchema = channelRouteSchema.extend({
  updateId: z.string().regex(/^\d{1,20}$/),
  sessionId: chatSessionIdSchema.optional(),
  text: z.string().trim().max(4_096).optional(),
  attachments: z.array(chatFilePartSchema).max(chatAttachmentMaxFiles).optional(),
}).strict().superRefine((value, context) => {
  const attachments = value.attachments ?? [];
  const attachmentBytes = attachments.reduce((total, attachment) => total + inlineAttachmentByteLength(attachment), 0);
  if (
    (!value.text && attachments.length === 0)
    || attachmentBytes > channelAttachmentMaxTotalBytes
  ) {
    context.addIssue({
      code: "custom",
      message: "A channel turn requires text or bounded inline attachments",
    });
  }
});
export const channelTurnResponseSchema = z.object({
  sessionId: chatSessionIdSchema,
  text: z.string().max(16_000),
  notices: z.array(z.string().trim().min(1).max(500)).max(16),
  artifacts: z.array(chatArtifactSchema).max(chatAttachmentMaxFiles).optional(),
  state: chatTurnStateSchema.exclude(["streaming"]),
}).strict().superRefine((value, context) => {
  if ((value.artifacts ?? []).reduce((total, artifact) => total + artifact.byteLength, 0) > channelArtifactMaxTotalBytes) {
    context.addIssue({ code: "custom", path: ["artifacts"], message: "Channel response artifacts exceed their total limit" });
  }
});
export const channelArtifactDownloadRequestSchema = channelRouteSchema.extend({
  artifact: chatArtifactSchema,
}).strict();
export const channelTurnStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heartbeat"),
  }).strict(),
  z.object({
    type: z.literal("text-delta"),
    delta: z.string().min(1).max(16_000),
  }).strict(),
  z.object({
    type: z.literal("notice"),
    notice: z.string().trim().min(1).max(500),
  }).strict(),
  z.object({
    type: z.literal("result"),
    response: channelTurnResponseSchema,
  }).strict(),
  z.object({
    type: z.literal("error"),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
  }).strict(),
]);
export type ChannelRoute = z.infer<typeof channelRouteSchema>;
export type ChannelTurnRequest = z.infer<typeof channelTurnRequestSchema>;
export type ChannelTurnResponse = z.infer<typeof channelTurnResponseSchema>;
export type ChannelTurnStreamEvent = z.infer<typeof channelTurnStreamEventSchema>;

const agentActivityHttpUrlSchema = z.string().max(2_048).refine((value) => {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, "Agent activity links must use HTTP(S) and must not contain URL credentials");

export const activityHttpUrlSchema = agentActivityHttpUrlSchema.refine((value) => {
  const parsed = new URL(value);
  const sensitiveQueryKey = /^(?:access_token|api[_-]?key|awsaccesskeyid|code|credential|key|password|refresh_token|sig|signature|token|x-amz-.+|x-goog-.+)$/i;
  return !parsed.hash && ![...parsed.searchParams.keys()].some((key) => sensitiveQueryKey.test(key));
}, "Persisted Activity links must not contain fragments, signatures, or credential query parameters");

const agentChatEventBaseSchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().nonnegative().max(100_000),
  sessionId: chatSessionIdSchema,
  turnId: chatPartIdSchema,
});
export const agentChatEventSchema = z.discriminatedUnion("type", [
  agentChatEventBaseSchema.extend({
    type: z.literal("turn-start"),
    messageId: chatPartIdSchema,
    createdAt: z.iso.datetime(),
    runtime: harnessRuntimeSchema.optional(),
  }).strict(),
  agentChatEventBaseSchema.extend({
    type: z.literal("progress"),
    activityId: chatPartIdSchema,
    label: z.string().trim().min(1).max(240),
    state: z.enum(["running", "completed"]),
  }).strict(),
  agentChatEventBaseSchema.extend({
    type: z.literal("plan"),
    title: z.string().trim().min(1).max(240),
    summary: z.string().trim().min(1).max(500).optional(),
    state: z.enum(["running", "completed"]).optional(),
  }).strict(),
  agentChatEventBaseSchema.extend({
    type: z.literal("provider-summary"),
    summary: z.string().trim().min(1).max(500),
    provider: z.string().trim().min(1).max(80).optional(),
  }).strict(),
  agentChatEventBaseSchema.extend({
    type: z.literal("text-delta"),
    textId: chatPartIdSchema,
    delta: z.string().min(1).max(16_000),
  }).strict(),
  agentChatEventBaseSchema.extend({
    type: z.literal("artifact"),
    artifactId: chatArtifactSchema.shape.artifactId,
    mediaType: chatArtifactSchema.shape.mediaType,
    filename: chatArtifactSchema.shape.filename,
    byteLength: chatArtifactSchema.shape.byteLength,
    sha256: chatArtifactSchema.shape.sha256,
  }).strict(),
  agentChatEventBaseSchema.extend({
    type: z.literal("tool"),
    toolCallId: chatPartIdSchema,
    name: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
    state: chatToolStateSchema,
    summary: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  agentChatEventBaseSchema.extend({
    type: z.literal("approval"),
    approvalId: chatPartIdSchema,
    toolCallId: chatPartIdSchema,
    operationId: z.uuid(),
    state: chatApprovalStateSchema,
    summary: z.string().trim().min(1).max(500),
  }).strict(),
  agentChatEventBaseSchema.extend({
    type: z.literal("web-action"),
    action: z.enum(["search", "open", "find"]),
    label: z.string().trim().min(1).max(240),
    url: agentActivityHttpUrlSchema.optional(),
  }).strict(),
  agentChatEventBaseSchema.extend({
    type: z.literal("source"),
    title: z.string().trim().min(1).max(240),
    url: agentActivityHttpUrlSchema,
    citation: z.string().trim().min(1).max(80).optional(),
  }).strict(),
  agentChatEventBaseSchema.extend({
    type: z.literal("computer-action"),
    actionId: chatPartIdSchema,
    label: z.string().trim().min(1).max(240),
    viewerRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/).optional(),
    state: z.enum(["running", "completed", "failed"]),
  }).strict(),
  agentChatEventBaseSchema.extend({
    type: z.literal("notice"),
    message: z.string().trim().min(1).max(500),
  }).strict(),
  agentChatEventBaseSchema.extend({
    type: z.literal("error"),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
  }).strict(),
  agentChatEventBaseSchema.extend({
    type: z.literal("turn-finish"),
    state: chatTurnStateSchema.exclude(["streaming"]),
    message: z.string().trim().min(1).max(500).optional(),
    completedAt: z.iso.datetime(),
  }).strict(),
]);
export type AgentChatEvent = z.infer<typeof agentChatEventSchema>;

export const replayFrameKindSchema = z.enum([
  "computer",
  "browser",
  "editor",
  "terminal",
  "artifact",
  "checkpoint",
]);
export type ReplayFrameKind = z.infer<typeof replayFrameKindSchema>;

export const replayFrameRefSchema = z.object({
  frameId: z.uuid(),
  turnId: chatPartIdSchema,
  activitySequence: z.number().int().nonnegative().max(100_000),
  timestamp: z.iso.datetime(),
  kind: replayFrameKindSchema,
  viewerRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive().max(16 * 1024 * 1024),
  mediaType: z.enum(["image/png", "image/jpeg", "application/json", "text/plain"]),
  expiresAt: z.iso.datetime().nullable(),
}).strict();
export type ReplayFrameRef = z.infer<typeof replayFrameRefSchema>;

export const replayMarkerSchema = z.object({
  sequence: z.number().int().nonnegative().max(100_000),
  kind: z.enum(["milestone", "tool", "artifact", "approval", "error", "terminal"]),
  label: z.string().trim().min(1).max(240),
  state: z.enum(["pending", "running", "requires_action", "completed", "failed", "cancelled"]),
}).strict();
export type ReplayMarker = z.infer<typeof replayMarkerSchema>;

export const turnReplayManifestSchema = z.object({
  version: z.literal(1),
  workspaceId: z.uuid(),
  agentCatalogId: chatAgentCatalogIdSchema,
  sessionId: chatSessionIdSchema,
  turnId: chatPartIdSchema,
  latestSequence: z.number().int().min(-1).max(100_000),
  terminal: z.boolean(),
  frames: z.array(replayFrameRefSchema).max(10_000),
  markers: z.array(replayMarkerSchema).max(10_000),
}).strict();
export type TurnReplayManifest = z.infer<typeof turnReplayManifestSchema>;

export const turnReplaySnapshotSchema = z.object({
  version: z.literal(1),
  requestedSequence: z.number().int().nonnegative().max(100_000),
  resolvedSequence: z.number().int().min(-1).max(100_000),
  latestSequence: z.number().int().min(-1).max(100_000),
  live: z.boolean(),
  turnState: chatTurnStateSchema,
  activeFrame: replayFrameRefSchema.nullable(),
  availableFrames: z.array(replayFrameRefSchema).max(512),
  markers: z.array(replayMarkerSchema).max(10_000),
}).strict();
export type TurnReplaySnapshot = z.infer<typeof turnReplaySnapshotSchema>;

export const activityEventStateSchema = z.enum([
  "pending",
  "running",
  "requires_action",
  "completed",
  "failed",
  "cancelled",
]);
export const activityEventProvenanceSchema = z.enum([
  "deterministic_system",
  "provider_generated",
  "tool",
]);
export const activityEventVisibilitySchema = z.literal("user");

const activityEventBaseSchema = z.object({
  version: z.literal(1),
  eventId: z.uuid(),
  turnId: chatPartIdSchema,
  sequence: z.number().int().nonnegative().max(100_000),
  timestamp: z.iso.datetime(),
  state: activityEventStateSchema,
  provenance: activityEventProvenanceSchema,
  visibility: activityEventVisibilitySchema,
});

export const activityEventSchema = z.discriminatedUnion("kind", [
  activityEventBaseSchema.extend({
    kind: z.literal("plan"),
    payload: z.object({
      title: z.string().trim().min(1).max(240),
      summary: z.string().trim().min(1).max(500).optional(),
    }).strict(),
  }).strict(),
  activityEventBaseSchema.extend({
    kind: z.literal("progress"),
    payload: z.object({
      activityId: chatPartIdSchema,
      label: z.string().trim().min(1).max(240),
    }).strict(),
  }).strict(),
  activityEventBaseSchema.extend({
    kind: z.literal("provider_summary"),
    provenance: z.literal("provider_generated"),
    payload: z.object({
      summary: z.string().trim().min(1).max(500),
      provider: z.string().trim().min(1).max(80).optional(),
    }).strict(),
  }).strict(),
  activityEventBaseSchema.extend({
    kind: z.literal("tool"),
    provenance: z.literal("tool"),
    payload: z.object({
      toolCallId: chatPartIdSchema,
      name: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
      summary: z.string().trim().min(1).max(500).optional(),
    }).strict(),
  }).strict(),
  activityEventBaseSchema.extend({
    kind: z.literal("web_action"),
    provenance: z.literal("tool"),
    payload: z.object({
      action: z.enum(["search", "open", "find"]),
      label: z.string().trim().min(1).max(240),
      url: activityHttpUrlSchema.optional(),
    }).strict(),
  }).strict(),
  activityEventBaseSchema.extend({
    kind: z.literal("source"),
    payload: z.object({
      title: z.string().trim().min(1).max(240),
      url: activityHttpUrlSchema,
      citation: z.string().trim().min(1).max(80).optional(),
    }).strict(),
  }).strict(),
  activityEventBaseSchema.extend({
    kind: z.literal("approval"),
    provenance: z.literal("tool"),
    payload: z.object({
      approvalId: chatPartIdSchema,
      toolCallId: chatPartIdSchema,
      operationId: z.uuid(),
      summary: z.string().trim().min(1).max(500),
    }).strict(),
  }).strict(),
  activityEventBaseSchema.extend({
    kind: z.literal("computer_action"),
    provenance: z.literal("tool"),
    payload: z.object({
      actionId: chatPartIdSchema,
      label: z.string().trim().min(1).max(240),
      viewerRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/).optional(),
    }).strict(),
  }).strict(),
  activityEventBaseSchema.extend({
    kind: z.literal("notice"),
    payload: z.object({
      message: z.string().trim().min(1).max(500),
    }).strict(),
  }).strict(),
  activityEventBaseSchema.extend({
    kind: z.literal("error"),
    payload: z.object({
      code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
      message: z.string().trim().min(1).max(500),
      retryable: z.boolean(),
    }).strict(),
  }).strict(),
  activityEventBaseSchema.extend({
    kind: z.literal("terminal"),
    provenance: z.literal("deterministic_system"),
    payload: z.object({
      turnState: chatTurnStateSchema.exclude(["streaming"]),
      message: z.string().trim().min(1).max(500).optional(),
    }).strict(),
  }).strict(),
]);
export type ActivityEventV1 = z.infer<typeof activityEventSchema>;
export type ActivityEventDraft = Omit<ActivityEventV1, "version" | "eventId" | "sequence" | "timestamp">;

export const activityEventReplaySchema = z.object({
  events: z.array(activityEventSchema).max(500),
  nextAfterSequence: z.number().int().nonnegative().max(100_000).nullable(),
  terminal: z.boolean(),
}).strict();
export type ActivityEventReplay = z.infer<typeof activityEventReplaySchema>;

export const sandboxSchema = z.object({
  providerId: z.string().min(1),
  workspaceId: z.uuid().optional(),
  state: z.enum(["provisioning", "ready", "stopped", "failed"]),
  failureCode: z.string().nullable().default(null),
  egressPolicyProjection: z.strictObject({
    securityGroupVersionId: z.string().regex(/^egv_[a-z0-9_]{3,96}$/),
    documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  policyIntegrity: policyIntegrityViewSchema.optional(),
  projectedPolicyBundle: signedPolicyBundleSchema.optional(),
  policyProjectionPresent: z.boolean().optional(),
});
export type Sandbox = z.infer<typeof sandboxSchema>;

export const clipboardCapabilitySchema = z.object({
  status: z.enum(["available", "policy_disabled"]),
  reasonCode: z.enum(["CLIPBOARD_READY", "CLIPBOARD_POLICY_DISABLED"]),
  mode: z.literal("native"),
  localToWorkspace: z.boolean(),
  workspaceToLocal: z.boolean(),
  mimeTypes: z.tuple([z.literal("text/plain")]),
  maxBytes: z.number().int().positive().max(1_048_576),
  requiresUserGesture: z.literal(true),
  supportedBrowsers: z.tuple([z.literal("chromium")]),
  fallback: z.literal("kasm-control-panel"),
}).strict();
export type ClipboardCapability = z.infer<typeof clipboardCapabilitySchema>;

export const launchSchema = z.object({
  launchUrl: z.url(),
  expiresAt: z.iso.datetime(),
  clipboard: clipboardCapabilitySchema,
});
export type Launch = z.infer<typeof launchSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    correlationId: z.string(),
    retryable: z.boolean(),
  }),
});

export class OneComputerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 500,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "OneComputerError";
  }
}

export type OwnedJson = null | boolean | number | string | OwnedJson[] | { [key: string]: OwnedJson };

export type GovernedOperationEnvelope = {
  version: "1";
  tenantId: string;
  subjectId: string;
  workspaceId: string;
  agentId?: string;
  audience: string;
  capabilityId: string;
  serverName: string;
  toolName: string;
  schemaId: string;
  arguments: OwnedJson;
  policyVersionId?: string;
  policyHash?: string;
  nonce: string;
  expiresAt: string;
};

const normalizeOwnedJson = (value: unknown): OwnedJson => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new OneComputerError("INVALID_CANONICAL_JSON", "Canonical JSON numbers must be finite", 400);
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeOwnedJson);
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new OneComputerError("INVALID_CANONICAL_JSON", "Canonical JSON accepts only plain JSON values", 400);
  }
  const normalized: Record<string, OwnedJson> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) throw new OneComputerError("INVALID_CANONICAL_JSON", "Canonical JSON does not accept undefined values", 400);
    normalized[key] = normalizeOwnedJson(item);
  }
  return normalized;
};

export const canonicalJson = (value: unknown) => JSON.stringify(normalizeOwnedJson(value));

export const governedOperationDigest = (envelope: GovernedOperationEnvelope) =>
  createHash("sha256").update(canonicalJson(envelope), "utf8").digest("hex");

export const governedOperationStates = [
  "approval_required",
  "approved",
  "executing",
  "succeeded",
  "denied",
  "failed",
  "expired",
] as const;
export const governedOperationStateSchema = z.enum(governedOperationStates);
export type GovernedOperationState = z.infer<typeof governedOperationStateSchema>;

export const createDeleteFileOperationSchema = z.strictObject({
  workspaceId: z.uuid(),
  path: z.string().trim().min(1).max(512).refine((value) => !value.includes("\0"), "Path contains an invalid character"),
});
export type CreateDeleteFileOperation = z.infer<typeof createDeleteFileOperationSchema>;

export const fixtureApprovalSchema = z.strictObject({
  decision: z.enum(["approve", "deny"]),
});

const ownedJsonSchema: z.ZodType<OwnedJson> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(ownedJsonSchema),
  z.record(z.string(), ownedJsonSchema),
]));

export const mcpPolicyRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tenantId: z.string().min(1).max(128),
  subjectId: z.string().min(1).max(128),
  workspaceId: z.uuid(),
  agentId: z.string().min(1).max(128),
  policyVersionId: z.string().min(1).max(128).nullable(),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  operationId: z.uuid().nullable(),
  operationDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  leaseId: z.uuid().nullable(),
  serverId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  serverName: z.string().min(1).max(128),
  toolName: z.string().min(1).max(128),
  arguments: ownedJsonSchema,
});
export type McpPolicyRequest = z.infer<typeof mcpPolicyRequestSchema>;

export const mcpPolicyDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  decision: z.enum(["allow", "deny", "approval_required"]),
  code: z.string().min(1).max(128),
  capabilityId: z.string().min(1).max(128).nullable(),
  schemaId: z.string().min(1).max(160).nullable(),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  operationId: z.uuid().nullable(),
});
export type McpPolicyDecision = z.infer<typeof mcpPolicyDecisionSchema>;

export const operationViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  agentId: z.string().min(1).nullable(),
  policyVersionId: z.string().min(1).nullable(),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  serverName: z.string().min(1),
  toolName: z.string().min(1),
  state: governedOperationStateSchema,
  action: z.string().min(1),
  resourceName: z.string(),
  resourceLocation: z.string(),
  safeSummary: z.string(),
  operationDigest: z.string().length(64),
  requestedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  requiredApprovalChannel: z.enum(["local-fixture", "openvtc-task-consent"]),
  approval: z.object({
    decision: z.enum(["approve", "deny"]),
    channel: z.enum(["local-fixture", "openvtc-task-consent"]),
    decidedAt: z.iso.datetime(),
  }).nullable(),
  receipt: z.object({
    status: z.literal("succeeded"),
    resultSummary: z.string(),
    executedAt: z.iso.datetime(),
  }).nullable(),
  failureCode: z.string().nullable(),
  failureSummary: z.string().max(240).nullable(),
});
export type OperationView = z.infer<typeof operationViewSchema>;

export const mcpToolPolicyDecisionSchema = z.enum(["allow", "approval_required", "deny"]);
export type McpToolPolicyDecision = z.infer<typeof mcpToolPolicyDecisionSchema>;

export const m365ToolCatalog = {
  "list-mail-folders": { service: "mail", risk: "read", decision: "allow" },
  "list-mail-messages": { service: "mail", risk: "read", decision: "allow" },
  "get-mail-message": { service: "mail", risk: "read", decision: "allow" },
  "create-draft-email": { service: "mail", risk: "write", decision: "approval_required" },
  "update-mail-message": { service: "mail", risk: "write", decision: "approval_required" },
  "delete-mail-message": { service: "mail", risk: "write", decision: "approval_required" },
  "move-mail-message": { service: "mail", risk: "write", decision: "approval_required" },
  "send-mail": { service: "mail", risk: "write", decision: "approval_required" },
  "send-draft-message": { service: "mail", risk: "write", decision: "approval_required" },
  "reply-mail-message": { service: "mail", risk: "write", decision: "approval_required" },
  "reply-all-mail-message": { service: "mail", risk: "write", decision: "approval_required" },
  "forward-mail-message": { service: "mail", risk: "write", decision: "approval_required" },
  "list-calendars": { service: "calendar", risk: "read", decision: "allow" },
  "list-calendar-events": { service: "calendar", risk: "read", decision: "allow" },
  "get-calendar-view": { service: "calendar", risk: "read", decision: "allow" },
  "get-calendar-event": { service: "calendar", risk: "read", decision: "allow" },
  "create-calendar-event": { service: "calendar", risk: "write", decision: "approval_required" },
  "update-calendar-event": { service: "calendar", risk: "write", decision: "approval_required" },
  "delete-calendar-event": { service: "calendar", risk: "write", decision: "approval_required" },
  "list-drives": { service: "onedrive", risk: "read", decision: "allow" },
  "get-drive-root-item": { service: "onedrive", risk: "read", decision: "allow" },
  "list-folder-files": { service: "onedrive", risk: "read", decision: "allow" },
  "search-onedrive-files": { service: "onedrive", risk: "read", decision: "allow" },
  "get-drive-item": { service: "onedrive", risk: "read", decision: "allow" },
  "create-onedrive-folder": { service: "onedrive", risk: "write", decision: "approval_required" },
  "upload-file-content": { service: "onedrive", risk: "write", decision: "approval_required" },
  "move-rename-onedrive-item": { service: "onedrive", risk: "write", decision: "approval_required" },
  "copy-drive-item": { service: "onedrive", risk: "write", decision: "approval_required" },
  "delete-onedrive-file": { service: "onedrive", risk: "write", decision: "approval_required" },
  "list-chats": { service: "teams", risk: "read", decision: "allow" },
  "list-chat-messages": { service: "teams", risk: "read", decision: "allow" },
  "list-joined-teams": { service: "teams", risk: "read", decision: "allow" },
  "list-team-channels": { service: "teams", risk: "read", decision: "allow" },
  "list-channel-messages": { service: "teams", risk: "read", decision: "allow" },
  "send-chat-message": { service: "teams", risk: "write", decision: "approval_required" },
  "reply-to-chat-message": { service: "teams", risk: "write", decision: "approval_required" },
  "send-channel-message": { service: "teams", risk: "write", decision: "approval_required" },
  "reply-to-channel-message": { service: "teams", risk: "write", decision: "approval_required" },
} as const satisfies Record<string, {
  service: "mail" | "calendar" | "onedrive" | "teams";
  risk: "read" | "write";
  decision: McpToolPolicyDecision;
}>;

export type M365ToolName = keyof typeof m365ToolCatalog;

export const mcpToolPolicySchema = z.object({
  serverName: z.literal("onecomputer_ms365"),
  version: z.number().int().positive(),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  tools: z.array(z.object({
    name: z.string().min(1).max(128),
    displayName: z.string().min(1).max(128),
    description: z.string().min(1).max(320),
    decision: mcpToolPolicyDecisionSchema,
    risk: z.enum(["read", "write"]),
  })),
});
export type McpToolPolicy = z.infer<typeof mcpToolPolicySchema>;

export const saveMcpToolPolicySchema = z.strictObject({
  tools: z.record(z.string().min(1).max(128), mcpToolPolicyDecisionSchema),
});

export const readinessFor = (state: WorkspaceState, gateway?: { models: ReadinessState; tools: ReadinessState }) => ({
  identity: "ready" as const,
  network: (["ready", "open"].includes(state)
    ? "ready"
    : state === "failed"
      ? "failed"
      : ["not_created", "stopped"].includes(state)
        ? "unavailable"
        : "checking") as ReadinessState,
  models: gateway?.models ?? "unavailable" as ReadinessState,
  tools: gateway?.tools ?? "unavailable" as ReadinessState,
});
