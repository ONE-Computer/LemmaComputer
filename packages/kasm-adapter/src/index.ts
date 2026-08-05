import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  canonicalJson,
  defaultClipboardPolicy,
  LemmaComputerError,
  runtimePolicySchema,
  signedPolicyBundleSchema,
  type AgentCatalogId,
  type ClipboardPolicy,
  type Launch,
  type PolicyVerificationKeySet,
  type RuntimePolicy,
  type Sandbox,
  type SignedPolicyBundle,
} from "@lemmacomputer/contracts";

const coworkSeccompProfile = readFileSync(
  new URL("./cowork-seccomp-profile.json", import.meta.url),
  "utf8",
).trim();

export interface SandboxAdapter {
  reconcile?(): Promise<void>;
  create(input: SandboxCreateInput): Promise<Sandbox>;
  updateEgressPolicy(providerId: string, input: SandboxEgressPolicyUpdateInput): Promise<void>;
  status(providerId: string): Promise<Sandbox>;
  open(providerId: string): Promise<SandboxLaunch>;
  destroy(providerId: string): Promise<void>;
  purgeWorkspace(workspaceId: string): Promise<void>;
}

export type SandboxLaunch = Launch & {
  ingressTarget?: {
    protocol: "http" | "https";
    host: string;
    port: number;
  };
};

export type SandboxCreateInput = {
  workspaceId: string;
  policy: RuntimePolicy;
  policyBundle?: SignedPolicyBundle;
  policyVerificationKeys?: PolicyVerificationKeySet;
  gateway?: {
    baseUrl: string;
    credential: string;
    modelAlias: string;
    transportModelAlias: string;
    expiresAt: string;
  };
  agentBridge?: {
    baseUrl: string;
    token: string;
  };
  chatRuntimes?: Array<{
    catalogId: "claude-cli" | "codex-cli" | "hermes-claw";
    key: string;
  }>;
  agentGrants?: Array<{
    catalogId: AgentCatalogId;
    agentId: string;
    gateway: {
      baseUrl: string;
      credential: string;
      modelAlias: string;
      transportModelAlias: string;
      expiresAt: string;
    };
    agentBridge: {
      baseUrl: string;
      token: string;
    };
  }>;
  egressProxy?: {
    token: string;
    verificationSecret: string;
    expiresAt: string;
    expectedGrant: {
      tenantId: string;
      subjectId: string;
      workspaceId: string;
      agentId: string;
      securityGroupVersionId: string;
      egressMode: RuntimePolicy["egressMode"];
      policyHash: string;
    };
  };
};

export type SandboxEgressPolicyUpdateInput = Pick<
  SandboxCreateInput,
  "workspaceId" | "policy" | "policyBundle" | "policyVerificationKeys" | "egressProxy"
>;

type KasmConfig = {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  userId: string;
  imageId: string;
  requestTimeoutMs?: number;
};

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject => value && typeof value === "object" ? value as JsonObject : {};
const textValue = (object: JsonObject, ...keys: string[]) => {
  for (const key of keys) if (typeof object[key] === "string") return object[key] as string;
  return undefined;
};

const clipboardPolicyFor = (policy?: RuntimePolicy): ClipboardPolicy => policy?.clipboard ?? defaultClipboardPolicy;

// Docker's embedded DNS follows the 63-character DNS label limit. The full
// `lemmacomputer-sandbox-<uuid>-relay` container name is 64 characters, so it
// cannot be used as a routable hostname even though Docker accepts the name.
const relayNameForWorkspace = (workspaceId: string) => `lemma-ws-${workspaceId}-relay`;

const agentEnvironment = (
  grant: NonNullable<SandboxCreateInput["agentGrants"]>[number],
  policy: RuntimePolicy,
) => {
  const prefix = ({
    "claude-desktop": "LEMMACOMPUTER",
    "claude-cli": "LEMMACOMPUTER_CLAUDE_CLI",
    "codex-cli": "LEMMACOMPUTER_CODEX_CLI",
    "hermes-desktop": "LEMMACOMPUTER_HERMES_DESKTOP",
    "hermes-claw": "LEMMACOMPUTER_HERMES",
  } as const)[grant.catalogId];
  return [
    `${prefix}_GATEWAY_UPSTREAM=${grant.gateway.baseUrl}`,
    `${prefix}_GATEWAY_CREDENTIAL=${grant.gateway.credential}`,
    `${prefix}_MODEL_ALIAS=${grant.gateway.modelAlias}`,
    `${prefix}_TRANSPORT_MODEL_ALIAS=${grant.gateway.transportModelAlias}`,
    `${prefix}_REQUESTED_SERVICE_CLASS=${policy.requestedServiceClass}`,
    `${prefix}_AGENT_ID=${grant.agentId}`,
    `${prefix}_CONTROL_UPSTREAM=${grant.agentBridge.baseUrl}`,
    `${prefix}_AGENT_BRIDGE_TOKEN=${grant.agentBridge.token}`,
    `${prefix}_MCP_SERVER=${policy.mcpServer}`,
    `${prefix}_ALLOWED_TOOLS=${policy.allowedTools.join(",")}`,
    `${prefix}_TOOL_POLICIES=${JSON.stringify(policy.toolPolicies)}`,
  ];
};

const chatRuntimeEnvironment = (
  runtime: NonNullable<SandboxCreateInput["chatRuntimes"]>[number],
) => {
  if (runtime.catalogId === "hermes-claw") {
    return [
      "API_SERVER_ENABLED=true",
      "API_SERVER_HOST=0.0.0.0",
      "API_SERVER_PORT=8642",
      `API_SERVER_KEY=${runtime.key}`,
    ];
  }
  const variable = runtime.catalogId === "claude-cli"
    ? "LEMMACOMPUTER_CLAUDE_CHAT_API_KEY"
    : "LEMMACOMPUTER_CODEX_CHAT_API_KEY";
  return [`${variable}=${runtime.key}`];
};

export function buildKasmClipboardLaunch(launchUrl: string, policy: ClipboardPolicy, now = new Date()): Launch {
  const enabled = policy.enabled;
  const localToWorkspace = enabled && policy.localToWorkspace;
  const workspaceToLocal = enabled && policy.workspaceToLocal;
  const launch = new URL(launchUrl);
  launch.searchParams.set("clipboard_up", String(localToWorkspace));
  launch.searchParams.set("clipboard_down", String(workspaceToLocal));
  launch.searchParams.set("clipboard_seamless", String(enabled && (localToWorkspace || workspaceToLocal)));
  launch.searchParams.set("translate_shortcuts", "true");
  launch.searchParams.set("lemmacomputer_clipboard", enabled ? "enabled" : "disabled");
  launch.searchParams.set("lemmacomputer_clipboard_max_bytes", String(policy.maxBytes));
  return {
    launchUrl: launch.toString(),
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    clipboard: {
      status: enabled ? "available" : "policy_disabled",
      reasonCode: enabled ? "CLIPBOARD_READY" : "CLIPBOARD_POLICY_DISABLED",
      mode: "native",
      localToWorkspace,
      workspaceToLocal,
      mimeTypes: ["text/plain"],
      maxBytes: policy.maxBytes,
      requiresUserGesture: true,
      supportedBrowsers: ["chromium"],
      fallback: "kasm-control-panel",
    },
  };
}

export class KasmDeveloperApiAdapter implements SandboxAdapter {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: KasmConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.timeoutMs = config.requestTimeoutMs ?? 20_000;
  }

  private async call(path: string, body: JsonObject): Promise<JsonObject> {
    const response = await fetch(`${this.baseUrl}/api/public/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify({ api_key: this.config.apiKey, api_key_secret: this.config.apiSecret, ...body }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new LemmaComputerError("KASM_UPSTREAM_ERROR", `Kasm ${path} returned ${response.status}`, 502, response.status >= 500);
    }
    return asObject(await response.json());
  }

  async create(_input: SandboxCreateInput): Promise<Sandbox> {
    const response = await this.call("request_kasm", { user_id: this.config.userId, image_id: this.config.imageId });
    const kasm = asObject(response.kasm ?? response);
    const providerId = textValue(kasm, "kasm_id");
    if (!providerId) throw new LemmaComputerError("KASM_INVALID_RESPONSE", "Kasm did not return a session identifier", 502, true);
    return { providerId, state: mapKasmState(textValue(kasm, "operational_status", "status")), failureCode: null };
  }

  async updateEgressPolicy(_providerId: string, _input: SandboxEgressPolicyUpdateInput) {
    throw new LemmaComputerError("EGRESS_LIVE_UPDATE_UNSUPPORTED", "This Kasm provider cannot update its egress proxy while running", 409, true);
  }

  async status(providerId: string): Promise<Sandbox> {
    const response = await this.call("get_kasm_status", { kasm_id: providerId, user_id: this.config.userId });
    const kasm = asObject(response.kasm ?? response);
    const state = mapKasmState(textValue(kasm, "operational_status", "status"));
    return { providerId, state, failureCode: state === "failed" ? "KASM_SESSION_FAILED" : null };
  }

  async open(providerId: string): Promise<SandboxLaunch> {
    const response = await this.call("get_kasm_status", { kasm_id: providerId, user_id: this.config.userId });
    const kasm = asObject(response.kasm ?? response);
    if (mapKasmState(textValue(kasm, "operational_status", "status")) !== "ready") {
      throw new LemmaComputerError("WORKSPACE_NOT_READY", "The workspace is not ready to open", 409, true);
    }
    const kasmUrl = textValue(kasm, "kasm_url", "url") ?? textValue(response, "kasm_url", "url");
    const sessionToken = textValue(kasm, "session_token") ?? textValue(response, "session_token");
    if (!kasmUrl) throw new LemmaComputerError("KASM_INVALID_RESPONSE", "Kasm did not return a launch URL", 502, true);
    const launch = new URL(kasmUrl, this.baseUrl);
    if (sessionToken && !launch.searchParams.has("token")) launch.searchParams.set("token", sessionToken);
    return buildKasmClipboardLaunch(launch.toString(), defaultClipboardPolicy);
  }

  async destroy(providerId: string) {
    await this.call("destroy_kasm", { kasm_id: providerId, user_id: this.config.userId });
  }

  async purgeWorkspace(_workspaceId: string) {
    // Kasm's Developer API owns persistent-profile retention and deletion.
    // Local Docker storage is explicitly managed by KasmLocalAdapter below.
  }
}

export function mapKasmState(value?: string): Sandbox["state"] {
  switch (value?.toLowerCase()) {
    case "running":
    case "ready":
      return "ready";
    case "stopped":
    case "deleted":
      return "stopped";
    case "error":
    case "failed":
      return "failed";
    default:
      return "provisioning";
  }
}

type KasmLocalConfig = {
  socketPath?: string;
  image: string;
  networkPrefix: string;
  controlNetwork: string;
  gatewayContainer: string;
  controlContainer?: string;
  relayImage: string;
  egressProxyImage?: string;
  egressNetwork?: string;
  publicHost?: string;
  timeZone?: string;
  chatAttachmentRetentionDays?: number;
  kvmEnabled?: boolean;
  installationKind: "customer-managed" | "hosted" | "worktree";
  portStart?: number;
  portEnd?: number;
  startupTimeoutMs?: number;
  startupPollMs?: number;
};

export const DEFAULT_LOCAL_WORKSPACE_STARTUP_TIMEOUT_MS = 60_000;

export class KasmLocalAdapter implements SandboxAdapter {
  private readonly socketPath: string;
  constructor(private readonly config: KasmLocalConfig) {
    if (config.kvmEnabled && config.installationKind === "hosted") {
      throw new LemmaComputerError(
        "COWORK_HOST_ISOLATION_REQUIRED",
        "Local Cowork virtualization is not permitted on hosted multi-tenant nodes",
        503,
      );
    }
    this.socketPath = config.socketPath ?? "/var/run/docker.sock";
  }

  async reconcile() {
    const listed = await this.request("GET", "/containers/json?all=1");
    for (const value of Object.values(asObject(listed))) {
      const container = asObject(value);
      const labels = asObject(container.Labels);
      const workspaceNetwork = labels["com.lemmacomputer.workspace-network"];
      const running = container.State === "running";
      if (!running || typeof workspaceNetwork !== "string" || !this.isWorkspaceNetwork(workspaceNetwork)) continue;
      if (labels["com.lemmacomputer.gateway-attached"] === "true") {
        await this.connectContainer(workspaceNetwork, this.config.gatewayContainer, ["litellm"]);
      }
      if (labels["com.lemmacomputer.control-attached"] === "true" && this.config.controlContainer) {
        await this.connectContainer(workspaceNetwork, this.config.controlContainer, ["lemmacomputer-control"]);
      }
    }
  }

  async create(input: SandboxCreateInput): Promise<Sandbox> {
    input = { ...input, policy: runtimePolicySchema.parse(input.policy) };
    const clipboard = clipboardPolicyFor(input.policy);
    if (!input.policyBundle || !input.policyVerificationKeys) {
      throw new LemmaComputerError("POLICY_SIGNATURE_REQUIRED", "A verified signed policy is required to provision the workspace", 503);
    }
    const policyBundleDigest = createHash("sha256").update(canonicalJson(input.policyBundle), "utf8").digest("hex");
    if (input.policy.egress && (!input.egressProxy || !this.config.egressProxyImage)) {
      throw new LemmaComputerError("EGRESS_PROXY_NOT_CONFIGURED", "The assigned egress firewall cannot be provisioned", 503);
    }
    const workspaceNetwork = this.workspaceNetwork(input.workspaceId);
    const workspaceVolume = await this.resolveWorkspaceVolume(input.workspaceId);
    const name = `lemmacomputer-sandbox-${input.workspaceId}`;
    const fallbackAgent = ({
      "claude-desktop-managed-v1": "claude-desktop",
      "claude-cli-managed-v1": "claude-cli",
      "codex-cli-managed-v1": "codex-cli",
      "hermes-desktop-managed-v1": "hermes-desktop",
      "hermes-claw-managed-v1": "hermes-claw",
    } as const)[input.policy.agentProfile as Exclude<typeof input.policy.agentProfile, "lemmacomputer-default-agent">] ?? "claude-desktop";
    const enabledAgents = input.agentGrants?.map((grant) => grant.catalogId) ?? [fallbackAgent];
    const enabledApplications = input.policy.applications ?? ["firefox"];
    const coworkEnabled = this.config.kvmEnabled === true && enabledAgents.includes("claude-desktop");
    const prepareRuntime = async () => {
      await this.ensureNetwork(workspaceNetwork, true, input.workspaceId);
      await this.ensureVolume(workspaceVolume, input.workspaceId);
      await this.ensureNetwork(this.config.controlNetwork, false);
      if (input.policy.egress && input.egressProxy && this.config.egressProxyImage) {
        await this.ensureNetwork(this.config.egressNetwork ?? "lemmacomputer-egress", false);
        await this.ensureEgressProxy(input, workspaceNetwork);
      }
      if (input.gateway) await this.connectContainer(workspaceNetwork, this.config.gatewayContainer, ["litellm"]);
      if ((input.agentBridge || input.chatRuntimes?.length) && this.config.controlContainer) {
        await this.connectContainer(workspaceNetwork, this.config.controlContainer, ["lemmacomputer-control"]);
      }
    };
    const existing = await this.inspectByName(name);
    if (existing?.running && existing.coworkEnabled === coworkEnabled) {
      await prepareRuntime();
      await this.ensureRelay(input.workspaceId, name, existing.id, existing.port ?? await this.allocatePort(), workspaceNetwork);
      return { providerId: existing.id, workspaceId: input.workspaceId, state: "ready", failureCode: null };
    }
    if (existing) await this.destroy(existing.id);
    // destroy() also removes the per-workspace network. Runtime preparation
    // must therefore happen after stale sandbox cleanup, not before it.
    await prepareRuntime();
    const port = await this.allocatePort();
    const created = await this.createContainer(`/containers/create?name=${encodeURIComponent(name)}`, {
      Image: this.config.image,
      Labels: {
        "com.lemmacomputer.sandbox.provider": "kasm-local",
        "com.lemmacomputer.workspace-id": input.workspaceId,
        "com.lemmacomputer.workspace-network": workspaceNetwork,
        "com.lemmacomputer.workspace-volume": workspaceVolume,
        "com.lemmacomputer.gateway-attached": String(Boolean(input.gateway)),
        "com.lemmacomputer.control-attached": String(Boolean(input.agentBridge || input.chatRuntimes?.length)),
        "com.lemmacomputer.policy-version-id": input.policy.policyVersionId,
        "com.lemmacomputer.policy-hash": input.policy.policyHash,
        "com.lemmacomputer.policy-signing-key-id": input.policyBundle.keyId,
        "com.lemmacomputer.policy-bundle-digest": policyBundleDigest,
        "com.lemmacomputer.agent-id": input.policy.agentId,
        "com.lemmacomputer.sandbox-profile": input.policy.workspaceProfile,
        "com.lemmacomputer.execution-mode": input.policy.executionMode,
        "com.lemmacomputer.egress-mode": input.policy.egressMode,
        "com.lemmacomputer.model-alias": input.policy.modelAlias,
        ...(this.config.timeZone ? {
          "com.lemmacomputer.time-zone": this.config.timeZone,
        } : {}),
        "com.lemmacomputer.enabled-agents": enabledAgents.join(","),
        "com.lemmacomputer.enabled-applications": enabledApplications.join(","),
        "com.lemmacomputer.cowork-enabled": String(coworkEnabled),
        "com.lemmacomputer.chat-runtime-agents": input.chatRuntimes?.map((runtime) => runtime.catalogId).join(",") ?? "",
        "com.lemmacomputer.desktop-port": String(port),
        "com.lemmacomputer.clipboard-enabled": String(clipboard.enabled),
        "com.lemmacomputer.clipboard-local-to-workspace": String(clipboard.localToWorkspace),
        "com.lemmacomputer.clipboard-workspace-to-local": String(clipboard.workspaceToLocal),
        "com.lemmacomputer.clipboard-max-bytes": String(clipboard.maxBytes),
        "com.lemmacomputer.egress-attached": String(Boolean(input.policy.egress)),
        ...(input.policy.egress ? {
          "com.lemmacomputer.egress-security-group-version-id": input.policy.egress.id,
          "com.lemmacomputer.egress-policy-hash": input.policy.egress.documentHash,
        } : {}),
      },
      Env: [
        "VNC_PW=lemmacomputer",
        "VNC_RESOLUTION=1440x900",
        "VNCOPTIONS=-DisableBasicAuth=1",
        ...(this.config.timeZone ? [
          `TZ=${this.config.timeZone}`,
          `LEMMACOMPUTER_TIME_ZONE=${this.config.timeZone}`,
        ] : []),
        ...(this.config.chatAttachmentRetentionDays ? [
          `LEMMACOMPUTER_CHAT_ATTACHMENT_RETENTION_DAYS=${this.config.chatAttachmentRetentionDays}`,
        ] : []),
        `LEMMACOMPUTER_CLIPBOARD_ENABLED=${clipboard.enabled}`,
        `LEMMACOMPUTER_CLIPBOARD_LOCAL_TO_WORKSPACE=${clipboard.localToWorkspace}`,
        `LEMMACOMPUTER_CLIPBOARD_WORKSPACE_TO_LOCAL=${clipboard.workspaceToLocal}`,
        `LEMMACOMPUTER_CLIPBOARD_MAX_BYTES=${clipboard.maxBytes}`,
        `LEMMACOMPUTER_ENABLED_AGENTS=${enabledAgents.join(",")}`,
        `LEMMACOMPUTER_ENABLED_APPLICATIONS=${enabledApplications.join(",")}`,
        `LEMMACOMPUTER_COWORK_ENABLED=${coworkEnabled}`,
        `LEMMACOMPUTER_EXECUTION_MODE=${input.policy.executionMode}`,
        `LEMMACOMPUTER_EGRESS_MODE=${input.policy.egressMode}`,
        `LEMMACOMPUTER_SIGNED_POLICY_B64=${Buffer.from(canonicalJson(input.policyBundle), "utf8").toString("base64url")}`,
        `LEMMACOMPUTER_POLICY_VERIFICATION_KEYS_B64=${Buffer.from(canonicalJson(input.policyVerificationKeys), "utf8").toString("base64url")}`,
        ...(input.chatRuntimes?.flatMap(chatRuntimeEnvironment) ?? []),
        ...(!input.agentGrants && input.gateway ? [
          `LEMMACOMPUTER_GATEWAY_UPSTREAM=${input.gateway.baseUrl}`,
          `LEMMACOMPUTER_GATEWAY_CREDENTIAL=${input.gateway.credential}`,
          `LEMMACOMPUTER_MODEL_ALIAS=${input.gateway.modelAlias}`,
          `LEMMACOMPUTER_TRANSPORT_MODEL_ALIAS=${input.gateway.transportModelAlias}`,
          `LEMMACOMPUTER_REQUESTED_SERVICE_CLASS=${input.policy.requestedServiceClass}`,
          `LEMMACOMPUTER_AGENT_ID=${input.policy.agentId}`,
          `LEMMACOMPUTER_POLICY_VERSION=${input.policy.policyVersion}`,
          `LEMMACOMPUTER_POLICY_HASH=${input.policy.policyHash}`,
          `LEMMACOMPUTER_MCP_SERVER=${input.policy.mcpServer}`,
          `LEMMACOMPUTER_ALLOWED_TOOLS=${input.policy.allowedTools.join(",")}`,
          `LEMMACOMPUTER_TOOL_POLICIES=${JSON.stringify(input.policy.toolPolicies)}`,
        ] : []),
        ...(!input.agentGrants && input.agentBridge ? [
          `LEMMACOMPUTER_CONTROL_UPSTREAM=${input.agentBridge.baseUrl}`,
          `LEMMACOMPUTER_AGENT_BRIDGE_TOKEN=${input.agentBridge.token}`,
        ] : []),
        ...(input.agentGrants?.flatMap((grant) => agentEnvironment(grant, input.policy)) ?? []),
        ...(input.agentGrants?.length ? [
          `LEMMACOMPUTER_POLICY_VERSION=${input.policy.policyVersion}`,
          `LEMMACOMPUTER_POLICY_HASH=${input.policy.policyHash}`,
        ] : []),
        ...(input.policy.egress && input.egressProxy ? [
          `HTTP_PROXY=http://lemmacomputer:${encodeURIComponent(input.egressProxy.token)}@lemmacomputer-egress-proxy:3128`,
          `HTTPS_PROXY=http://lemmacomputer:${encodeURIComponent(input.egressProxy.token)}@lemmacomputer-egress-proxy:3128`,
          `http_proxy=http://lemmacomputer:${encodeURIComponent(input.egressProxy.token)}@lemmacomputer-egress-proxy:3128`,
          `https_proxy=http://lemmacomputer:${encodeURIComponent(input.egressProxy.token)}@lemmacomputer-egress-proxy:3128`,
          "NO_PROXY=localhost,127.0.0.1,litellm,lemmacomputer-control",
          "no_proxy=localhost,127.0.0.1,litellm,lemmacomputer-control",
        ] : []),
      ],
      HostConfig: {
        NetworkMode: workspaceNetwork,
        RestartPolicy: { Name: "unless-stopped" },
        ShmSize: 536_870_912,
        PidsLimit: 1024,
        Memory: coworkEnabled ? 8_589_934_592 : 4_294_967_296,
        NanoCpus: 2_000_000_000,
        CapDrop: ["NET_ADMIN", "NET_RAW", "SYS_ADMIN"],
        SecurityOpt: [
          "no-new-privileges",
          ...(coworkEnabled ? ["seccomp=" + coworkSeccompProfile] : []),
        ],
        Mounts: [{ Type: "volume", Source: workspaceVolume, Target: "/home/kasm-user" }],
        ...(coworkEnabled ? {
          Devices: [
            {
              PathOnHost: "/dev/kvm",
              PathInContainer: "/dev/kvm",
              CgroupPermissions: "rwm",
            },
            {
              PathOnHost: "/dev/vhost-vsock",
              PathInContainer: "/dev/vhost-vsock",
              CgroupPermissions: "rwm",
            },
          ],
        } : {}),
      },
    }, workspaceNetwork, prepareRuntime);
    const providerId = textValue(created, "Id");
    if (!providerId) throw new LemmaComputerError("DOCKER_INVALID_RESPONSE", "Docker did not return a container identifier", 502);
    try {
      await this.request("POST", `/containers/${providerId}/start`);
      await this.waitForStartup(providerId);
      await this.ensureRelay(input.workspaceId, name, providerId, port, workspaceNetwork);
      return { providerId, workspaceId: input.workspaceId, state: "ready", failureCode: null };
    } catch (error) {
      await this.destroy(providerId).catch(() => undefined);
      throw error;
    }
  }

  async updateEgressPolicy(providerId: string, input: SandboxEgressPolicyUpdateInput) {
    input = { ...input, policy: runtimePolicySchema.parse(input.policy) };
    if (!input.policyBundle || !input.policyVerificationKeys || !input.policy.egress || !input.egressProxy) {
      throw new LemmaComputerError("EGRESS_PROXY_NOT_CONFIGURED", "A signed egress policy and proxy grant are required", 503);
    }
    const inspected = await this.request("GET", `/containers/${encodeURIComponent(providerId)}/json`);
    const state = asObject(inspected.State);
    const labels = asObject(asObject(inspected.Config).Labels);
    const workspaceId = labels["com.lemmacomputer.workspace-id"];
    const workspaceNetwork = labels["com.lemmacomputer.workspace-network"];
    if (
      state.Running !== true
      || workspaceId !== input.workspaceId
      || typeof workspaceNetwork !== "string"
      || !this.isWorkspaceNetwork(workspaceNetwork)
    ) {
      throw new LemmaComputerError("WORKSPACE_NOT_READY", "The running workspace could not accept the firewall update", 409, true);
    }
    await this.ensureEgressProxy(input, workspaceNetwork, true);
  }

  async status(providerId: string): Promise<Sandbox> {
    try {
      const inspected = await this.request("GET", `/containers/${encodeURIComponent(providerId)}/json`);
      const state = asObject(inspected.State);
      // Docker reports Running=true while an unless-stopped container is in a
      // restart loop. That state cannot serve Kasm and must not be exposed as
      // ready to Control or the browser.
      const restarting = state.Restarting === true;
      const health = textValue(asObject(state.Health), "Status");
      const running = state.Running === true && !restarting && state.Paused !== true && health !== "unhealthy";
      const containerConfig = asObject(inspected.Config);
      const labels = asObject(containerConfig.Labels);
      const workspaceNetwork = labels["com.lemmacomputer.workspace-network"];
      const environment = Array.isArray(containerConfig.Env) ? containerConfig.Env : [];
      const projectedPolicyEntry = environment.find((entry) => (
        typeof entry === "string" && entry.startsWith("LEMMACOMPUTER_SIGNED_POLICY_B64=")
      ));
      let projectedPolicyBundle: SignedPolicyBundle | undefined;
      let egressPolicyProjection: Sandbox["egressPolicyProjection"];
      if (typeof projectedPolicyEntry === "string") {
        try {
          projectedPolicyBundle = signedPolicyBundleSchema.parse(JSON.parse(
            Buffer.from(projectedPolicyEntry.slice(projectedPolicyEntry.indexOf("=") + 1), "base64url").toString("utf8"),
          ));
        } catch {
          projectedPolicyBundle = undefined;
        }
      }
      const sandboxName = textValue(inspected, "Name")?.replace(/^\//, "");
      if (sandboxName) {
        const proxy = await this.request("GET", `/containers/${encodeURIComponent(`${sandboxName}-egress`)}/json`).catch(() => null);
        const proxyLabels = proxy
          ? asObject(asObject(asObject(proxy).Config).Labels)
          : undefined;
        const proxyEnvironment = proxy
          ? asObject(proxy.Config).Env
          : undefined;
        const proxySecurityGroupVersionId = proxyLabels?.["com.lemmacomputer.egress-security-group-version-id"];
        const proxyDocumentHash = proxyLabels?.["com.lemmacomputer.egress-policy-hash"];
        if (
          typeof proxySecurityGroupVersionId === "string"
          && /^egv_[a-z0-9_]{3,96}$/.test(proxySecurityGroupVersionId)
          && typeof proxyDocumentHash === "string"
          && /^[a-f0-9]{64}$/.test(proxyDocumentHash)
        ) {
          egressPolicyProjection = {
            securityGroupVersionId: proxySecurityGroupVersionId,
            documentHash: proxyDocumentHash,
          };
        }
        const proxyPolicyEntry = Array.isArray(proxyEnvironment)
          ? proxyEnvironment.find((entry) => typeof entry === "string" && entry.startsWith("LEMMACOMPUTER_SIGNED_POLICY_B64="))
          : undefined;
        if (typeof proxyPolicyEntry === "string") {
          try {
            projectedPolicyBundle = signedPolicyBundleSchema.parse(JSON.parse(
              Buffer.from(proxyPolicyEntry.slice(proxyPolicyEntry.indexOf("=") + 1), "base64url").toString("utf8"),
            ));
          } catch {
            projectedPolicyBundle = undefined;
          }
        }
      }
      const controlAttached = labels["com.lemmacomputer.control-attached"] === "true"
        || environment.some((entry) => typeof entry === "string" && entry.startsWith("LEMMACOMPUTER_AGENT_BRIDGE_TOKEN="));
      if (running && typeof workspaceNetwork === "string" && this.isWorkspaceNetwork(workspaceNetwork)) {
        await this.connectContainer(workspaceNetwork, this.config.gatewayContainer, ["litellm"]);
        if (controlAttached && this.config.controlContainer) {
          await this.connectContainer(workspaceNetwork, this.config.controlContainer, ["lemmacomputer-control"]);
        }
      }
      const failed = restarting || health === "unhealthy" || (typeof state.ExitCode === "number" && state.ExitCode !== 0);
      return {
        providerId,
        ...(typeof labels["com.lemmacomputer.workspace-id"] === "string"
          ? { workspaceId: String(labels["com.lemmacomputer.workspace-id"]) }
          : {}),
        state: failed ? "failed" : running ? health === "starting" ? "provisioning" : "ready" : "stopped",
        failureCode: failed ? health === "unhealthy" ? "WORKSPACE_HEALTHCHECK_FAILED" : "WORKSPACE_STARTUP_FAILED" : null,
        ...(egressPolicyProjection ? { egressPolicyProjection } : {}),
        policyProjectionPresent: Boolean(projectedPolicyEntry),
        ...(projectedPolicyBundle ? { projectedPolicyBundle } : {}),
      };
    } catch (error) {
      if (error instanceof LemmaComputerError && error.statusCode === 404) return { providerId, state: "stopped", failureCode: null };
      throw error;
    }
  }

  async open(providerId: string): Promise<SandboxLaunch> {
    const inspected = await this.request("GET", `/containers/${encodeURIComponent(providerId)}/json`);
    const state = asObject(inspected.State);
    const health = textValue(asObject(state.Health), "Status");
    if (state.Running !== true || state.Restarting === true || state.Paused === true || (health && health !== "healthy")) {
      throw new LemmaComputerError("WORKSPACE_NOT_READY", "The Kasm desktop is not healthy yet", 409, true);
    }
    const labels = asObject(asObject(inspected.Config).Labels);
    const sandboxName = textValue(inspected, "Name")?.replace(/^\//, "");
    const workspaceId = labels["com.lemmacomputer.workspace-id"];
    const port = Number(labels["com.lemmacomputer.desktop-port"]);
    if (!Number.isInteger(port) || port <= 0) throw new LemmaComputerError("KASM_INVALID_STATE", "The Kasm desktop has no assigned session port", 502);
    if (
      typeof sandboxName !== "string"
      || !/^lemmacomputer-sandbox-[0-9a-f-]{36}$/i.test(sandboxName)
      || typeof workspaceId !== "string"
      || !/^[0-9a-f-]{36}$/i.test(workspaceId)
    ) throw new LemmaComputerError("KASM_INVALID_STATE", "The Kasm desktop has no routable workspace identity", 502);
    const defaultPolicy = defaultClipboardPolicy;
    const policy = {
      enabled: labels["com.lemmacomputer.clipboard-enabled"] === undefined
        ? defaultPolicy.enabled
        : labels["com.lemmacomputer.clipboard-enabled"] === "true",
      localToWorkspace: labels["com.lemmacomputer.clipboard-local-to-workspace"] === undefined
        ? defaultPolicy.localToWorkspace
        : labels["com.lemmacomputer.clipboard-local-to-workspace"] === "true",
      workspaceToLocal: labels["com.lemmacomputer.clipboard-workspace-to-local"] === undefined
        ? defaultPolicy.workspaceToLocal
        : labels["com.lemmacomputer.clipboard-workspace-to-local"] === "true",
      maxBytes: Number(labels["com.lemmacomputer.clipboard-max-bytes"] ?? defaultPolicy.maxBytes),
    };
    return {
      ...buildKasmClipboardLaunch(`https://${this.config.publicHost ?? "127.0.0.1"}:${port}/`, policy),
      ingressTarget: {
        protocol: "https",
        host: relayNameForWorkspace(workspaceId),
        port,
      },
    };
  }

  async destroy(providerId: string) {
    let name: string | undefined;
    let workspaceId: string | undefined;
    let workspaceNetwork: string | undefined;
    let gatewayAttached = false;
    let controlAttached = false;
    try {
      const inspected = await this.request("GET", `/containers/${encodeURIComponent(providerId)}/json`);
      name = textValue(inspected, "Name")?.replace(/^\//, "");
      const containerConfig = asObject(inspected.Config);
      const labels = asObject(containerConfig.Labels);
      workspaceId = typeof labels["com.lemmacomputer.workspace-id"] === "string"
        ? String(labels["com.lemmacomputer.workspace-id"])
        : undefined;
      const environment = Array.isArray(containerConfig.Env) ? containerConfig.Env : [];
      workspaceNetwork = typeof labels["com.lemmacomputer.workspace-network"] === "string" ? String(labels["com.lemmacomputer.workspace-network"]) : undefined;
      gatewayAttached = labels["com.lemmacomputer.gateway-attached"] === "true";
      controlAttached = labels["com.lemmacomputer.control-attached"] === "true"
        || environment.some((entry) => typeof entry === "string" && entry.startsWith("LEMMACOMPUTER_AGENT_BRIDGE_TOKEN="));
    } catch (error) {
      if (!(error instanceof LemmaComputerError && error.statusCode === 404)) throw error;
    }
    if (workspaceId) await this.removeContainer(relayNameForWorkspace(workspaceId));
    // Remove the pre-fix relay name during rolling upgrades. Docker accepts
    // this 64-character container name but cannot publish it through DNS.
    if (name) await this.removeContainer(`${name}-relay`);
    if (name) await this.removeContainer(`${name}-egress`);
    await this.removeContainer(providerId);
    if (workspaceNetwork && this.isWorkspaceNetwork(workspaceNetwork)) {
      if (gatewayAttached) await this.disconnectContainer(workspaceNetwork, this.config.gatewayContainer);
      if (controlAttached && this.config.controlContainer) await this.disconnectContainer(workspaceNetwork, this.config.controlContainer);
      await this.removeNetwork(workspaceNetwork);
    }
  }

  async purgeWorkspace(workspaceId: string) {
    await this.removeVolume(this.workspaceVolume(workspaceId));
    await this.removeVolume(this.legacyWorkspaceVolume(workspaceId));
  }

  private async removeContainer(id: string) {
    try {
      await this.request("DELETE", `/containers/${encodeURIComponent(id)}?force=true&v=true`);
    } catch (error) {
      if (!(error instanceof LemmaComputerError && error.statusCode === 404)) throw error;
    }
  }

  private workspaceNetwork(workspaceId: string) {
    return `${this.config.networkPrefix}-${workspaceId.toLowerCase()}`;
  }

  private workspaceVolume(workspaceId: string) {
    return `${this.config.networkPrefix}-home-${workspaceId.toLowerCase()}`;
  }

  private legacyWorkspaceVolume(workspaceId: string) {
    return `lemmacomputer-v4-ws-home-${workspaceId.toLowerCase()}`;
  }

  private isWorkspaceNetwork(name: string) {
    return name.startsWith(`${this.config.networkPrefix}-`) || name.startsWith("lemmacomputer-v4-ws-");
  }

  private async resolveWorkspaceVolume(workspaceId: string) {
    const current = this.workspaceVolume(workspaceId);
    if (await this.volumeExists(current)) return current;
    const legacy = this.legacyWorkspaceVolume(workspaceId);
    return await this.volumeExists(legacy) ? legacy : current;
  }

  private async ensureNetwork(name: string, internal: boolean, workspaceId?: string) {
    const networks = await this.request("GET", `/networks/${encodeURIComponent(name)}`).catch(() => null);
    if (networks) return;
    try {
      await this.request("POST", "/networks/create", {
        Name: name,
        Driver: "bridge",
        Internal: internal,
        Attachable: true,
        Labels: {
          "com.lemmacomputer.runtime": "workspace-network",
          ...(workspaceId ? { "com.lemmacomputer.workspace-id": workspaceId } : {}),
        },
      });
    } catch (error) {
      // Another reconciler may create the same network after our initial GET.
      // Confirm that race before treating Docker's conflict as a failure.
      if (await this.request("GET", `/networks/${encodeURIComponent(name)}`).catch(() => null)) return;
      throw error;
    }
  }

  private async ensureVolume(name: string, workspaceId: string) {
    if (await this.volumeExists(name)) return;
    await this.request("POST", "/volumes/create", {
      Name: name,
      Driver: "local",
      Labels: {
        "com.lemmacomputer.runtime": "workspace-home",
        "com.lemmacomputer.workspace-id": workspaceId,
      },
    });
  }

  private async volumeExists(name: string) {
    return Boolean(await this.request("GET", `/volumes/${encodeURIComponent(name)}`).catch(() => null));
  }

  private async removeVolume(name: string) {
    try {
      await this.request("DELETE", `/volumes/${encodeURIComponent(name)}?force=true`);
    } catch (error) {
      if (!(error instanceof LemmaComputerError && error.statusCode === 404)) throw error;
    }
  }

  private async connectContainer(network: string, container: string, aliases: string[] = []) {
    if (await this.networkContainsContainer(network, container)) return;
    try {
      await this.request("POST", `/networks/${encodeURIComponent(network)}/connect`, {
        Container: container,
        EndpointConfig: aliases.length ? { Aliases: aliases } : {},
      });
    } catch (error) {
      if (await this.networkContainsContainer(network, container)) return;
      throw error;
    }
  }

  private async networkContainsContainer(network: string, container: string) {
    try {
      const inspected = await this.request("GET", `/networks/${encodeURIComponent(network)}`);
      return Object.entries(asObject(inspected.Containers)).some(([id, value]) => {
        const name = textValue(asObject(value), "Name");
        return id === container || id.startsWith(container) || name === container;
      });
    } catch (error) {
      if (error instanceof LemmaComputerError && error.statusCode === 404) return false;
      throw error;
    }
  }

  private async disconnectContainer(network: string, container: string) {
    if (!(await this.networkContainsContainer(network, container))) return;
    try {
      await this.request("POST", `/networks/${encodeURIComponent(network)}/disconnect`, { Container: container, Force: true });
    } catch (error) {
      if (error instanceof LemmaComputerError && [404, 409].includes(error.statusCode)) return;
      // Docker can return 500 when Compose replaces a governed service after
      // the membership check but before disconnect. Treat that race as an
      // idempotent success only when a fresh inspection confirms the endpoint
      // is already absent; preserve every genuine Docker failure.
      if (!(await this.networkContainsContainer(network, container))) return;
      throw error;
    }
  }

  private async removeNetwork(network: string) {
    try {
      await this.request("DELETE", `/networks/${encodeURIComponent(network)}`);
    } catch (error) {
      if (!(error instanceof LemmaComputerError && error.statusCode === 404)) throw error;
    }
  }

  private async inspectByName(name: string) {
    try {
      const inspected = await this.request("GET", `/containers/${encodeURIComponent(name)}/json`);
      const labels = asObject(asObject(inspected.Config).Labels);
      const rawPort = labels["com.lemmacomputer.desktop-port"];
      const state = asObject(inspected.State);
      const health = textValue(asObject(state.Health), "Status");
      return {
        id: String(inspected.Id),
        running: state.Running === true
          && state.Restarting !== true
          && state.Paused !== true
          && (!health || health === "healthy"),
        port: typeof rawPort === "string" ? Number(rawPort) : undefined,
        coworkEnabled: labels["com.lemmacomputer.cowork-enabled"] === "true",
      };
    } catch (error) {
      if (error instanceof LemmaComputerError && error.statusCode === 404) return null;
      throw error;
    }
  }

  private async allocatePort() {
    const start = this.config.portStart ?? 16920;
    const end = this.config.portEnd ?? 16999;
    const listed = await this.request("GET", "/containers/json?all=1");
    const used = new Set(Object.values(asObject(listed)).flatMap((value) => {
      const labels = asObject(asObject(value).Labels);
      const raw = labels["com.lemmacomputer.desktop-port"];
      return typeof raw === "string" ? [Number(raw)] : [];
    }));
    for (let port = start; port <= end; port += 1) if (!used.has(port)) return port;
    throw new LemmaComputerError("KASM_PORTS_EXHAUSTED", "No local Kasm desktop ports are available", 503, true);
  }

  private async ensureRelay(workspaceId: string, sandboxName: string, sandboxId: string, port: number, workspaceNetwork: string) {
    const relayName = relayNameForWorkspace(workspaceId);
    const existing = await this.inspectByName(relayName);
    if (existing?.running) return;
    if (existing) await this.removeContainer(existing.id);
    const script = `const net=require("node:net");net.createServer(c=>{const u=net.connect({host:${JSON.stringify(sandboxName)},port:6901});const x=()=>{c.destroy();u.destroy()};c.on("error",x);u.on("error",x);c.pipe(u).pipe(c)}).listen(${port},"0.0.0.0")`;
    const created = await this.request("POST", `/containers/create?name=${encodeURIComponent(relayName)}`, {
      Image: this.config.relayImage,
      Entrypoint: ["node"],
      Cmd: ["-e", script],
      ExposedPorts: { [`${port}/tcp`]: {} },
      Labels: {
        "com.lemmacomputer.sandbox.relay": "kasm-local",
        "com.lemmacomputer.sandbox-id": sandboxId,
        "com.lemmacomputer.desktop-port": String(port),
      },
      HostConfig: {
        NetworkMode: this.config.controlNetwork,
        RestartPolicy: { Name: "unless-stopped" },
        PortBindings: { [`${port}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(port) }] },
        SecurityOpt: ["no-new-privileges"],
      },
    });
    const relayId = textValue(created, "Id");
    if (!relayId) throw new LemmaComputerError("DOCKER_INVALID_RESPONSE", "Docker did not return a relay identifier", 502);
    await this.request("POST", `/containers/${relayId}/start`);
    await this.connectContainer(workspaceNetwork, relayId);
  }

  private async ensureEgressProxy(input: SandboxEgressPolicyUpdateInput, workspaceNetwork: string, replace = false) {
    if (!input.policy.egress || !input.egressProxy || !this.config.egressProxyImage) return;
    if (
      input.egressProxy.expectedGrant.workspaceId !== input.workspaceId
      || input.egressProxy.expectedGrant.agentId !== input.policy.agentId
      || input.egressProxy.expectedGrant.securityGroupVersionId !== input.policy.egress.id
      || (input.egressProxy.expectedGrant.egressMode ?? input.policy.egressMode) !== input.policy.egressMode
      || input.egressProxy.expectedGrant.policyHash !== input.policy.policyHash
    ) {
      throw new LemmaComputerError("EGRESS_PROXY_GRANT_MISMATCH", "The egress proxy grant does not match the sandbox policy", 403);
    }
    const sandboxName = `lemmacomputer-sandbox-${input.workspaceId}`;
    const proxyName = `${sandboxName}-egress`;
    const existing = await this.inspectByName(proxyName);
    if (existing?.running && !replace) return;
    if (existing) await this.removeContainer(existing.id);
    const policy = input.policy.egress;
    const created = await this.request("POST", `/containers/create?name=${encodeURIComponent(proxyName)}`, {
      Image: this.config.egressProxyImage,
      Cmd: ["npm", "run", "start", "-w", "@lemmacomputer/egress-proxy"],
      Labels: {
        "com.lemmacomputer.egress-proxy": "v2",
        "com.lemmacomputer.workspace-id": input.workspaceId,
        "com.lemmacomputer.egress-security-group-version-id": input.policy.egress.id,
        "com.lemmacomputer.egress-policy-hash": input.policy.egress.documentHash,
        "com.lemmacomputer.egress-mode": input.policy.egress.mode,
      },
      Env: [
        "EGRESS_PROXY_PORT=3128",
        `EGRESS_POLICY_JSON=${JSON.stringify(policy)}`,
        `EGRESS_EXPECTED_GRANT_JSON=${JSON.stringify(input.egressProxy.expectedGrant)}`,
        `EGRESS_GRANT_SECRET=${input.egressProxy.verificationSecret}`,
        `LEMMACOMPUTER_SIGNED_POLICY_B64=${Buffer.from(canonicalJson(input.policyBundle), "utf8").toString("base64url")}`,
      ],
      NetworkingConfig: {
        EndpointsConfig: {
          [workspaceNetwork]: { Aliases: ["lemmacomputer-egress-proxy"] },
        },
      },
      HostConfig: {
        NetworkMode: workspaceNetwork,
        RestartPolicy: { Name: "unless-stopped" },
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        PidsLimit: 128,
        Memory: 268_435_456,
        NanoCpus: 500_000_000,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=16m" },
      },
    });
    const proxyId = textValue(created, "Id");
    if (!proxyId) throw new LemmaComputerError("DOCKER_INVALID_RESPONSE", "Docker did not return an egress proxy identifier", 502);
    try {
      await this.connectContainer(this.config.egressNetwork ?? "lemmacomputer-egress", proxyId);
      await this.request("POST", `/containers/${proxyId}/start`);
    } catch (error) {
      await this.removeContainer(proxyId).catch(() => undefined);
      throw error;
    }
  }

  private async createContainer(
    path: string,
    body: JsonObject,
    workspaceNetwork: string,
    prepareRuntime: () => Promise<void>,
  ) {
    try {
      return await this.request("POST", path, body);
    } catch (error) {
      const missingWorkspaceNetwork = error instanceof LemmaComputerError
        && error.statusCode === 404
        && error.message.includes(`network ${workspaceNetwork} not found`);
      if (!missingWorkspaceNetwork) throw error;
      // Docker can lose a Compose-managed bridge between reconciliation and
      // container creation. Reconcile once and replay only the idempotent
      // create request so a transient network race never becomes terminal UI.
      await prepareRuntime();
      return this.request("POST", path, body);
    }
  }

  private async waitForStartup(providerId: string) {
    const timeoutMs = this.config.startupTimeoutMs ?? DEFAULT_LOCAL_WORKSPACE_STARTUP_TIMEOUT_MS;
    const pollMs = this.config.startupPollMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (await this.isStartupReady(providerId)) return;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)));
    }

    // Always perform one final observation after the deadline. The old
    // do/while checked the deadline after sleeping and could miss a container
    // that became healthy on Docker's next scheduled health check.
    if (await this.isStartupReady(providerId)) return;

    throw await this.startupTimeoutFailure(providerId);
  }

  private async isStartupReady(providerId: string) {
    const inspected = await this.request("GET", `/containers/${encodeURIComponent(providerId)}/json`);
    const state = asObject(inspected.State);
    const health = textValue(asObject(state.Health), "Status");
    const running = state.Running === true && state.Restarting !== true && state.Paused !== true;
    if (running && (!health || health === "healthy")) return true;

    const terminal = state.OOMKilled === true
      || state.Restarting === true
      || ["dead", "exited"].includes(String(state.Status ?? ""));
    if (terminal) throw await this.startupFailure(providerId, state, health);
    return false;
  }

  private async startupFailure(providerId: string, state: JsonObject, health?: string) {
    const logs = await this.containerLogs(providerId).catch(() => "");
    const diagnostic = this.safeStartupDiagnostic(logs);
    const detail = diagnostic ? ` ${diagnostic}` : "";
    if (state.OOMKilled === true) {
      return new LemmaComputerError(
        "WORKSPACE_RESOURCE_LIMIT",
        `The workspace exceeded its memory limit during startup.${detail}`,
        503,
        true,
      );
    }
    if (state.ExitCode === 78) {
      return new LemmaComputerError(
        "WORKSPACE_STARTUP_REJECTED",
        `The workspace configuration was rejected during startup.${detail}`,
        422,
        false,
      );
    }
    return new LemmaComputerError(
      health === "unhealthy" ? "WORKSPACE_HEALTHCHECK_FAILED" : "WORKSPACE_STARTUP_FAILED",
      `The workspace stopped before it became ready.${detail}`,
      503,
      true,
    );
  }

  private async startupTimeoutFailure(providerId: string) {
    const inspected = await this.request("GET", `/containers/${encodeURIComponent(providerId)}/json`);
    const state = asObject(inspected.State);
    const health = textValue(asObject(state.Health), "Status");
    const running = state.Running === true && state.Restarting !== true && state.Paused !== true;
    if (!running || state.OOMKilled === true || state.Restarting === true) {
      return this.startupFailure(providerId, state, health);
    }
    const logs = await this.containerLogs(providerId).catch(() => "");
    const diagnostic = this.safeStartupDiagnostic(logs);
    const detail = diagnostic ? ` ${diagnostic}` : "";
    return new LemmaComputerError(
      health === "unhealthy" ? "WORKSPACE_HEALTHCHECK_FAILED" : "WORKSPACE_STARTUP_TIMEOUT",
      `The workspace did not become ready before the startup deadline.${detail}`,
      504,
      true,
    );
  }

  private safeStartupDiagnostic(logs: string) {
    const patterns = [
      /Cowork cannot access \/dev\/(?:kvm|vhost-vsock) as kasm-user/,
      /Cowork cannot create an AF_VSOCK socket/,
      /Cowork requires the Claude Desktop agent/,
      /invalid Cowork capability setting/,
      /(?:Claude Desktop|Claude CLI|Codex CLI|Hermes Agent CLI|Hermes Agent Desktop) (?:GATEWAY_UPSTREAM|GATEWAY_CREDENTIAL|MODEL_ALIAS|CONTROL_UPSTREAM|AGENT_BRIDGE_TOKEN|ALLOWED_TOOLS) is required/,
      /(?:Hermes sandbox API|Claude Chat API|Codex Chat API) configuration is required/,
      /invalid clipboard (?:policy boolean|size policy)/,
      /Kasm profile initialization failed/,
    ];
    for (const pattern of patterns) {
      const match = logs.match(pattern);
      if (match) return match[0];
    }
    return undefined;
  }

  private containerLogs(providerId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const path = `/v1.47/containers/${encodeURIComponent(providerId)}/logs?stdout=1&stderr=1&tail=40`;
      const request = http.request({ socketPath: this.socketPath, path, method: "GET" }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if ((response.statusCode ?? 500) >= 400) {
            reject(new LemmaComputerError("DOCKER_API_ERROR", `Docker API returned ${response.statusCode}`, response.statusCode ?? 500));
            return;
          }
          const decoded: Buffer[] = [];
          let offset = 0;
          while (offset + 8 <= buffer.length && [0, 1, 2].includes(buffer[offset]!)) {
            const length = buffer.readUInt32BE(offset + 4);
            if (offset + 8 + length > buffer.length) break;
            decoded.push(buffer.subarray(offset + 8, offset + 8 + length));
            offset += 8 + length;
          }
          resolve((decoded.length ? Buffer.concat(decoded) : buffer).toString("utf8"));
        });
      });
      request.on("error", (error) => reject(new LemmaComputerError("DOCKER_UNAVAILABLE", error.message, 503, true)));
      request.end();
    });
  }

  private request(method: string, path: string, body?: JsonObject): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const request = http.request({ socketPath: this.socketPath, path: `/v1.47${path}`, method, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : undefined }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) >= 400) {
            let daemonMessage = "";
            try {
              const parsed = JSON.parse(text) as { message?: unknown };
              if (typeof parsed.message === "string") daemonMessage = parsed.message.replace(/[\r\n]+/g, " ").slice(0, 240);
            } catch {
              // Keep invalid daemon responses out of the surfaced error.
            }
            reject(new LemmaComputerError("DOCKER_API_ERROR", `Docker API returned ${response.statusCode}${daemonMessage ? `: ${daemonMessage}` : ""}`, response.statusCode ?? 500));
            return;
          }
          if (!text) { resolve({}); return; }
          try { resolve(asObject(JSON.parse(text))); } catch { reject(new LemmaComputerError("DOCKER_INVALID_RESPONSE", "Docker returned invalid JSON", 502)); }
        });
      });
      request.on("error", (error) => reject(new LemmaComputerError("DOCKER_UNAVAILABLE", error.message, 503, true)));
      if (payload) request.write(payload);
      request.end();
    });
  }
}
