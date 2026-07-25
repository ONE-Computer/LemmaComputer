import http from "node:http";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  defaultClipboardPolicy,
  OneComputerError,
  signedPolicyBundleSchema,
  type AgentCatalogId,
  type ClipboardPolicy,
  type Launch,
  type PolicyVerificationKeySet,
  type RuntimePolicy,
  type Sandbox,
  type SignedPolicyBundle,
} from "@onecomputer/contracts";

export interface SandboxAdapter {
  create(input: SandboxCreateInput): Promise<Sandbox>;
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
      policyHash: string;
    };
  };
};

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

const agentEnvironment = (
  grant: NonNullable<SandboxCreateInput["agentGrants"]>[number],
  policy: RuntimePolicy,
) => {
  const prefix = ({
    "claude-desktop": "ONECOMPUTER",
    "claude-cli": "ONECOMPUTER_CLAUDE_CLI",
    "codex-cli": "ONECOMPUTER_CODEX_CLI",
    "hermes-desktop": "ONECOMPUTER_HERMES_DESKTOP",
    "hermes-claw": "ONECOMPUTER_HERMES",
  } as const)[grant.catalogId];
  return [
    `${prefix}_GATEWAY_UPSTREAM=${grant.gateway.baseUrl}`,
    `${prefix}_GATEWAY_CREDENTIAL=${grant.gateway.credential}`,
    `${prefix}_MODEL_ALIAS=${grant.gateway.modelAlias}`,
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
    ? "ONECOMPUTER_CLAUDE_CHAT_API_KEY"
    : "ONECOMPUTER_CODEX_CHAT_API_KEY";
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
  launch.searchParams.set("onecomputer_clipboard", enabled ? "enabled" : "disabled");
  launch.searchParams.set("onecomputer_clipboard_max_bytes", String(policy.maxBytes));
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
      throw new OneComputerError("KASM_UPSTREAM_ERROR", `Kasm ${path} returned ${response.status}`, 502, response.status >= 500);
    }
    return asObject(await response.json());
  }

  async create(_input: SandboxCreateInput): Promise<Sandbox> {
    const response = await this.call("request_kasm", { user_id: this.config.userId, image_id: this.config.imageId });
    const kasm = asObject(response.kasm ?? response);
    const providerId = textValue(kasm, "kasm_id");
    if (!providerId) throw new OneComputerError("KASM_INVALID_RESPONSE", "Kasm did not return a session identifier", 502, true);
    return { providerId, state: mapKasmState(textValue(kasm, "operational_status", "status")), failureCode: null };
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
      throw new OneComputerError("WORKSPACE_NOT_READY", "The workspace is not ready to open", 409, true);
    }
    const kasmUrl = textValue(kasm, "kasm_url", "url") ?? textValue(response, "kasm_url", "url");
    const sessionToken = textValue(kasm, "session_token") ?? textValue(response, "session_token");
    if (!kasmUrl) throw new OneComputerError("KASM_INVALID_RESPONSE", "Kasm did not return a launch URL", 502, true);
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
  portStart?: number;
  portEnd?: number;
};

export class KasmLocalAdapter implements SandboxAdapter {
  private readonly socketPath: string;
  constructor(private readonly config: KasmLocalConfig) {
    this.socketPath = config.socketPath ?? "/var/run/docker.sock";
  }

  async create(input: SandboxCreateInput): Promise<Sandbox> {
    const clipboard = clipboardPolicyFor(input.policy);
    if (!input.policyBundle || !input.policyVerificationKeys) {
      throw new OneComputerError("POLICY_SIGNATURE_REQUIRED", "A verified signed policy is required to provision the workspace", 503);
    }
    const policyBundleDigest = createHash("sha256").update(canonicalJson(input.policyBundle), "utf8").digest("hex");
    if (input.policy.egress && (!input.egressProxy || !this.config.egressProxyImage)) {
      throw new OneComputerError("EGRESS_PROXY_NOT_CONFIGURED", "The assigned egress firewall cannot be provisioned", 503);
    }
    const workspaceNetwork = this.workspaceNetwork(input.workspaceId);
    const workspaceVolume = await this.resolveWorkspaceVolume(input.workspaceId);
    await this.ensureNetwork(workspaceNetwork, true, input.workspaceId);
    await this.ensureVolume(workspaceVolume, input.workspaceId);
    await this.ensureNetwork(this.config.controlNetwork, false);
    if (input.policy.egress && input.egressProxy && this.config.egressProxyImage) {
      await this.ensureNetwork(this.config.egressNetwork ?? "onecomputer-egress", false);
      await this.ensureEgressProxy(input, workspaceNetwork);
    }
    if (input.gateway) await this.connectContainer(workspaceNetwork, this.config.gatewayContainer, ["litellm"]);
    if ((input.agentBridge || input.chatRuntimes?.length) && this.config.controlContainer) await this.connectContainer(workspaceNetwork, this.config.controlContainer, ["onecomputer-control"]);
    const name = `onecomputer-sandbox-${input.workspaceId}`;
    const existing = await this.inspectByName(name);
    if (existing?.running) {
      await this.ensureRelay(name, existing.id, existing.port ?? await this.allocatePort(), workspaceNetwork);
      return { providerId: existing.id, workspaceId: input.workspaceId, state: "ready", failureCode: null };
    }
    if (existing) await this.destroy(existing.id);
    const port = await this.allocatePort();
    const fallbackAgent = ({
      "claude-desktop-managed-v1": "claude-desktop",
      "claude-cli-managed-v1": "claude-cli",
      "codex-cli-managed-v1": "codex-cli",
      "hermes-desktop-managed-v1": "hermes-desktop",
      "hermes-claw-managed-v1": "hermes-claw",
    } as const)[input.policy.agentProfile as Exclude<typeof input.policy.agentProfile, "onecomputer-default-agent">] ?? "claude-desktop";
    const enabledAgents = input.agentGrants?.map((grant) => grant.catalogId) ?? [fallbackAgent];
    const enabledApplications = input.policy.applications ?? ["firefox"];
    const created = await this.request("POST", `/containers/create?name=${encodeURIComponent(name)}`, {
      Image: this.config.image,
      Labels: {
        "com.onecomputer.sandbox.provider": "kasm-local",
        "com.onecomputer.workspace-id": input.workspaceId,
        "com.onecomputer.workspace-network": workspaceNetwork,
        "com.onecomputer.workspace-volume": workspaceVolume,
        "com.onecomputer.gateway-attached": String(Boolean(input.gateway)),
        "com.onecomputer.control-attached": String(Boolean(input.agentBridge || input.chatRuntimes?.length)),
        "com.onecomputer.policy-version-id": input.policy.policyVersionId,
        "com.onecomputer.policy-hash": input.policy.policyHash,
        "com.onecomputer.policy-signing-key-id": input.policyBundle.keyId,
        "com.onecomputer.policy-bundle-digest": policyBundleDigest,
        "com.onecomputer.agent-id": input.policy.agentId,
        "com.onecomputer.sandbox-profile": input.policy.workspaceProfile,
        "com.onecomputer.model-alias": input.policy.modelAlias,
        "com.onecomputer.enabled-agents": enabledAgents.join(","),
        "com.onecomputer.enabled-applications": enabledApplications.join(","),
        "com.onecomputer.chat-runtime-agents": input.chatRuntimes?.map((runtime) => runtime.catalogId).join(",") ?? "",
        "com.onecomputer.desktop-port": String(port),
        "com.onecomputer.clipboard-enabled": String(clipboard.enabled),
        "com.onecomputer.clipboard-local-to-workspace": String(clipboard.localToWorkspace),
        "com.onecomputer.clipboard-workspace-to-local": String(clipboard.workspaceToLocal),
        "com.onecomputer.clipboard-max-bytes": String(clipboard.maxBytes),
        "com.onecomputer.egress-attached": String(Boolean(input.policy.egress)),
        ...(input.policy.egress ? {
          "com.onecomputer.egress-security-group-version-id": input.policy.egress.id,
          "com.onecomputer.egress-policy-hash": input.policy.egress.documentHash,
        } : {}),
      },
      Env: [
        "VNC_PW=onecomputer",
        "VNC_RESOLUTION=1440x900",
        "VNCOPTIONS=-DisableBasicAuth=1",
        `ONECOMPUTER_CLIPBOARD_ENABLED=${clipboard.enabled}`,
        `ONECOMPUTER_CLIPBOARD_LOCAL_TO_WORKSPACE=${clipboard.localToWorkspace}`,
        `ONECOMPUTER_CLIPBOARD_WORKSPACE_TO_LOCAL=${clipboard.workspaceToLocal}`,
        `ONECOMPUTER_CLIPBOARD_MAX_BYTES=${clipboard.maxBytes}`,
        `ONECOMPUTER_ENABLED_AGENTS=${enabledAgents.join(",")}`,
        `ONECOMPUTER_ENABLED_APPLICATIONS=${enabledApplications.join(",")}`,
        `ONECOMPUTER_SIGNED_POLICY_B64=${Buffer.from(canonicalJson(input.policyBundle), "utf8").toString("base64url")}`,
        `ONECOMPUTER_POLICY_VERIFICATION_KEYS_B64=${Buffer.from(canonicalJson(input.policyVerificationKeys), "utf8").toString("base64url")}`,
        ...(input.chatRuntimes?.flatMap(chatRuntimeEnvironment) ?? []),
        ...(!input.agentGrants && input.gateway ? [
          `ONECOMPUTER_GATEWAY_UPSTREAM=${input.gateway.baseUrl}`,
          `ONECOMPUTER_GATEWAY_CREDENTIAL=${input.gateway.credential}`,
          `ONECOMPUTER_MODEL_ALIAS=${input.gateway.modelAlias}`,
          `ONECOMPUTER_AGENT_ID=${input.policy.agentId}`,
          `ONECOMPUTER_POLICY_VERSION=${input.policy.policyVersion}`,
          `ONECOMPUTER_POLICY_HASH=${input.policy.policyHash}`,
          `ONECOMPUTER_MCP_SERVER=${input.policy.mcpServer}`,
          `ONECOMPUTER_ALLOWED_TOOLS=${input.policy.allowedTools.join(",")}`,
          `ONECOMPUTER_TOOL_POLICIES=${JSON.stringify(input.policy.toolPolicies)}`,
        ] : []),
        ...(!input.agentGrants && input.agentBridge ? [
          `ONECOMPUTER_CONTROL_UPSTREAM=${input.agentBridge.baseUrl}`,
          `ONECOMPUTER_AGENT_BRIDGE_TOKEN=${input.agentBridge.token}`,
        ] : []),
        ...(input.agentGrants?.flatMap((grant) => agentEnvironment(grant, input.policy)) ?? []),
        ...(input.agentGrants?.length ? [
          `ONECOMPUTER_POLICY_VERSION=${input.policy.policyVersion}`,
          `ONECOMPUTER_POLICY_HASH=${input.policy.policyHash}`,
        ] : []),
        ...(input.policy.egress && input.egressProxy ? [
          `HTTP_PROXY=http://onecomputer:${encodeURIComponent(input.egressProxy.token)}@onecomputer-egress-proxy:3128`,
          `HTTPS_PROXY=http://onecomputer:${encodeURIComponent(input.egressProxy.token)}@onecomputer-egress-proxy:3128`,
          `http_proxy=http://onecomputer:${encodeURIComponent(input.egressProxy.token)}@onecomputer-egress-proxy:3128`,
          `https_proxy=http://onecomputer:${encodeURIComponent(input.egressProxy.token)}@onecomputer-egress-proxy:3128`,
          "NO_PROXY=localhost,127.0.0.1,litellm,onecomputer-control",
          "no_proxy=localhost,127.0.0.1,litellm,onecomputer-control",
        ] : []),
      ],
      HostConfig: {
        NetworkMode: workspaceNetwork,
        RestartPolicy: { Name: "unless-stopped" },
        ShmSize: 536_870_912,
        PidsLimit: 1024,
        Memory: 3_221_225_472,
        NanoCpus: 2_000_000_000,
        CapDrop: ["NET_ADMIN", "NET_RAW", "SYS_ADMIN"],
        SecurityOpt: ["no-new-privileges"],
        Mounts: [{ Type: "volume", Source: workspaceVolume, Target: "/home/kasm-user" }],
      },
    });
    const providerId = textValue(created, "Id");
    if (!providerId) throw new OneComputerError("DOCKER_INVALID_RESPONSE", "Docker did not return a container identifier", 502);
    try {
      await this.request("POST", `/containers/${providerId}/start`);
      await this.ensureRelay(name, providerId, port, workspaceNetwork);
      return { providerId, workspaceId: input.workspaceId, state: "provisioning", failureCode: null };
    } catch (error) {
      await this.destroy(providerId).catch(() => undefined);
      throw error;
    }
  }

  async status(providerId: string): Promise<Sandbox> {
    try {
      const inspected = await this.request("GET", `/containers/${encodeURIComponent(providerId)}/json`);
      const state = asObject(inspected.State);
      // Docker reports Running=true while an unless-stopped container is in a
      // restart loop. That state cannot serve Kasm and must not be exposed as
      // ready to Control or the browser.
      const restarting = state.Restarting === true;
      const running = state.Running === true && !restarting && state.Paused !== true;
      const containerConfig = asObject(inspected.Config);
      const labels = asObject(containerConfig.Labels);
      const workspaceNetwork = labels["com.onecomputer.workspace-network"];
      const environment = Array.isArray(containerConfig.Env) ? containerConfig.Env : [];
      const projectedPolicyEntry = environment.find((entry) => (
        typeof entry === "string" && entry.startsWith("ONECOMPUTER_SIGNED_POLICY_B64=")
      ));
      let projectedPolicyBundle: SignedPolicyBundle | undefined;
      if (typeof projectedPolicyEntry === "string") {
        try {
          projectedPolicyBundle = signedPolicyBundleSchema.parse(JSON.parse(
            Buffer.from(projectedPolicyEntry.slice(projectedPolicyEntry.indexOf("=") + 1), "base64url").toString("utf8"),
          ));
        } catch {
          projectedPolicyBundle = undefined;
        }
      }
      const controlAttached = labels["com.onecomputer.control-attached"] === "true"
        || environment.some((entry) => typeof entry === "string" && entry.startsWith("ONECOMPUTER_AGENT_BRIDGE_TOKEN="));
      if (running && typeof workspaceNetwork === "string" && this.isWorkspaceNetwork(workspaceNetwork)) {
        await this.connectContainer(workspaceNetwork, this.config.gatewayContainer, ["litellm"]);
        if (controlAttached && this.config.controlContainer) {
          await this.connectContainer(workspaceNetwork, this.config.controlContainer, ["onecomputer-control"]);
        }
      }
      const failed = restarting || (typeof state.ExitCode === "number" && state.ExitCode !== 0);
      return {
        providerId,
        ...(typeof labels["com.onecomputer.workspace-id"] === "string"
          ? { workspaceId: String(labels["com.onecomputer.workspace-id"]) }
          : {}),
        state: running ? "ready" : failed ? "failed" : "stopped",
        failureCode: failed ? "FIXTURE_EXITED" : null,
        policyProjectionPresent: Boolean(projectedPolicyEntry),
        ...(projectedPolicyBundle ? { projectedPolicyBundle } : {}),
      };
    } catch (error) {
      if (error instanceof OneComputerError && error.statusCode === 404) return { providerId, state: "stopped", failureCode: null };
      throw error;
    }
  }

  async open(providerId: string): Promise<SandboxLaunch> {
    const inspected = await this.request("GET", `/containers/${encodeURIComponent(providerId)}/json`);
    if (asObject(inspected.State).Running !== true) throw new OneComputerError("WORKSPACE_NOT_READY", "The Kasm desktop is not running", 409, true);
    const labels = asObject(asObject(inspected.Config).Labels);
    const sandboxName = textValue(inspected, "Name")?.replace(/^\//, "");
    const workspaceId = labels["com.onecomputer.workspace-id"];
    const port = Number(labels["com.onecomputer.desktop-port"]);
    if (!Number.isInteger(port) || port <= 0) throw new OneComputerError("KASM_INVALID_STATE", "The Kasm desktop has no assigned session port", 502);
    if (
      typeof sandboxName !== "string"
      || !/^onecomputer-sandbox-[0-9a-f-]{36}$/i.test(sandboxName)
      || typeof workspaceId !== "string"
      || !/^[0-9a-f-]{36}$/i.test(workspaceId)
    ) throw new OneComputerError("KASM_INVALID_STATE", "The Kasm desktop has no routable workspace identity", 502);
    const defaultPolicy = defaultClipboardPolicy;
    const policy = {
      enabled: labels["com.onecomputer.clipboard-enabled"] === undefined
        ? defaultPolicy.enabled
        : labels["com.onecomputer.clipboard-enabled"] === "true",
      localToWorkspace: labels["com.onecomputer.clipboard-local-to-workspace"] === undefined
        ? defaultPolicy.localToWorkspace
        : labels["com.onecomputer.clipboard-local-to-workspace"] === "true",
      workspaceToLocal: labels["com.onecomputer.clipboard-workspace-to-local"] === undefined
        ? defaultPolicy.workspaceToLocal
        : labels["com.onecomputer.clipboard-workspace-to-local"] === "true",
      maxBytes: Number(labels["com.onecomputer.clipboard-max-bytes"] ?? defaultPolicy.maxBytes),
    };
    return {
      ...buildKasmClipboardLaunch(`https://${this.config.publicHost ?? "127.0.0.1"}:${port}/`, policy),
      ingressTarget: {
        protocol: "https",
        host: `${sandboxName}-relay`,
        port,
      },
    };
  }

  async destroy(providerId: string) {
    let name: string | undefined;
    let workspaceNetwork: string | undefined;
    let gatewayAttached = false;
    let controlAttached = false;
    try {
      const inspected = await this.request("GET", `/containers/${encodeURIComponent(providerId)}/json`);
      name = textValue(inspected, "Name")?.replace(/^\//, "");
      const containerConfig = asObject(inspected.Config);
      const labels = asObject(containerConfig.Labels);
      const environment = Array.isArray(containerConfig.Env) ? containerConfig.Env : [];
      workspaceNetwork = typeof labels["com.onecomputer.workspace-network"] === "string" ? String(labels["com.onecomputer.workspace-network"]) : undefined;
      gatewayAttached = labels["com.onecomputer.gateway-attached"] === "true";
      controlAttached = labels["com.onecomputer.control-attached"] === "true"
        || environment.some((entry) => typeof entry === "string" && entry.startsWith("ONECOMPUTER_AGENT_BRIDGE_TOKEN="));
    } catch (error) {
      if (!(error instanceof OneComputerError && error.statusCode === 404)) throw error;
    }
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
      if (!(error instanceof OneComputerError && error.statusCode === 404)) throw error;
    }
  }

  private workspaceNetwork(workspaceId: string) {
    return `${this.config.networkPrefix}-${workspaceId.toLowerCase()}`;
  }

  private workspaceVolume(workspaceId: string) {
    return `${this.config.networkPrefix}-home-${workspaceId.toLowerCase()}`;
  }

  private legacyWorkspaceVolume(workspaceId: string) {
    return `onecomputer-v4-ws-home-${workspaceId.toLowerCase()}`;
  }

  private isWorkspaceNetwork(name: string) {
    return name.startsWith(`${this.config.networkPrefix}-`) || name.startsWith("onecomputer-v4-ws-");
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
    await this.request("POST", "/networks/create", {
      Name: name,
      Driver: "bridge",
      Internal: internal,
      Attachable: true,
      Labels: {
        "com.onecomputer.runtime": "workspace-network",
        ...(workspaceId ? { "com.onecomputer.workspace-id": workspaceId } : {}),
      },
    });
  }

  private async ensureVolume(name: string, workspaceId: string) {
    if (await this.volumeExists(name)) return;
    await this.request("POST", "/volumes/create", {
      Name: name,
      Driver: "local",
      Labels: {
        "com.onecomputer.runtime": "workspace-home",
        "com.onecomputer.workspace-id": workspaceId,
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
      if (!(error instanceof OneComputerError && error.statusCode === 404)) throw error;
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
      if (error instanceof OneComputerError && error.statusCode === 404) return false;
      throw error;
    }
  }

  private async disconnectContainer(network: string, container: string) {
    try {
      await this.request("POST", `/networks/${encodeURIComponent(network)}/disconnect`, { Container: container, Force: true });
    } catch (error) {
      if (!(error instanceof OneComputerError && [404, 409].includes(error.statusCode))) throw error;
    }
  }

  private async removeNetwork(network: string) {
    try {
      await this.request("DELETE", `/networks/${encodeURIComponent(network)}`);
    } catch (error) {
      if (!(error instanceof OneComputerError && error.statusCode === 404)) throw error;
    }
  }

  private async inspectByName(name: string) {
    try {
      const inspected = await this.request("GET", `/containers/${encodeURIComponent(name)}/json`);
      const labels = asObject(asObject(inspected.Config).Labels);
      const rawPort = labels["com.onecomputer.desktop-port"];
      const state = asObject(inspected.State);
      return {
        id: String(inspected.Id),
        running: state.Running === true && state.Restarting !== true && state.Paused !== true,
        port: typeof rawPort === "string" ? Number(rawPort) : undefined,
      };
    } catch (error) {
      if (error instanceof OneComputerError && error.statusCode === 404) return null;
      throw error;
    }
  }

  private async allocatePort() {
    const start = this.config.portStart ?? 16920;
    const end = this.config.portEnd ?? 16999;
    const listed = await this.request("GET", "/containers/json?all=1");
    const used = new Set(Object.values(asObject(listed)).flatMap((value) => {
      const labels = asObject(asObject(value).Labels);
      const raw = labels["com.onecomputer.desktop-port"];
      return typeof raw === "string" ? [Number(raw)] : [];
    }));
    for (let port = start; port <= end; port += 1) if (!used.has(port)) return port;
    throw new OneComputerError("KASM_PORTS_EXHAUSTED", "No local Kasm desktop ports are available", 503, true);
  }

  private async ensureRelay(sandboxName: string, sandboxId: string, port: number, workspaceNetwork: string) {
    const relayName = `${sandboxName}-relay`;
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
        "com.onecomputer.sandbox.relay": "kasm-local",
        "com.onecomputer.sandbox-id": sandboxId,
        "com.onecomputer.desktop-port": String(port),
      },
      HostConfig: {
        NetworkMode: this.config.controlNetwork,
        RestartPolicy: { Name: "unless-stopped" },
        PortBindings: { [`${port}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(port) }] },
        SecurityOpt: ["no-new-privileges"],
      },
    });
    const relayId = textValue(created, "Id");
    if (!relayId) throw new OneComputerError("DOCKER_INVALID_RESPONSE", "Docker did not return a relay identifier", 502);
    await this.request("POST", `/containers/${relayId}/start`);
    await this.connectContainer(workspaceNetwork, relayId);
  }

  private async ensureEgressProxy(input: SandboxCreateInput, workspaceNetwork: string) {
    if (!input.policy.egress || !input.egressProxy || !this.config.egressProxyImage) return;
    if (
      input.egressProxy.expectedGrant.workspaceId !== input.workspaceId
      || input.egressProxy.expectedGrant.agentId !== input.policy.agentId
      || input.egressProxy.expectedGrant.securityGroupVersionId !== input.policy.egress.id
      || input.egressProxy.expectedGrant.policyHash !== input.policy.policyHash
    ) {
      throw new OneComputerError("EGRESS_PROXY_GRANT_MISMATCH", "The egress proxy grant does not match the sandbox policy", 403);
    }
    const sandboxName = `onecomputer-sandbox-${input.workspaceId}`;
    const proxyName = `${sandboxName}-egress`;
    const existing = await this.inspectByName(proxyName);
    if (existing?.running) return;
    if (existing) await this.removeContainer(existing.id);
    const policy = {
      schemaVersion: 1,
      id: input.policy.egress.id,
      securityGroupId: input.policy.egress.securityGroupId,
      tenantId: input.egressProxy.expectedGrant.tenantId,
      version: input.policy.egress.version,
      name: input.policy.egress.name,
      description: input.policy.egress.description,
      defaultAction: input.policy.egress.defaultAction,
      rules: input.policy.egress.rules,
      documentHash: input.policy.egress.documentHash,
      createdBy: input.egressProxy.expectedGrant.subjectId,
      createdAt: new Date().toISOString(),
    };
    const created = await this.request("POST", `/containers/create?name=${encodeURIComponent(proxyName)}`, {
      Image: this.config.egressProxyImage,
      Cmd: ["npm", "run", "start", "-w", "@onecomputer/egress-proxy"],
      Labels: {
        "com.onecomputer.egress-proxy": "v2",
        "com.onecomputer.workspace-id": input.workspaceId,
        "com.onecomputer.egress-security-group-version-id": input.policy.egress.id,
        "com.onecomputer.egress-policy-hash": input.policy.egress.documentHash,
      },
      Env: [
        "EGRESS_PROXY_PORT=3128",
        `EGRESS_POLICY_JSON=${JSON.stringify(policy)}`,
        `EGRESS_EXPECTED_GRANT_JSON=${JSON.stringify(input.egressProxy.expectedGrant)}`,
        `EGRESS_GRANT_SECRET=${input.egressProxy.verificationSecret}`,
      ],
      NetworkingConfig: {
        EndpointsConfig: {
          [workspaceNetwork]: { Aliases: ["onecomputer-egress-proxy"] },
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
    if (!proxyId) throw new OneComputerError("DOCKER_INVALID_RESPONSE", "Docker did not return an egress proxy identifier", 502);
    try {
      await this.connectContainer(this.config.egressNetwork ?? "onecomputer-egress", proxyId);
      await this.request("POST", `/containers/${proxyId}/start`);
    } catch (error) {
      await this.removeContainer(proxyId).catch(() => undefined);
      throw error;
    }
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
            reject(new OneComputerError("DOCKER_API_ERROR", `Docker API returned ${response.statusCode}${daemonMessage ? `: ${daemonMessage}` : ""}`, response.statusCode ?? 500));
            return;
          }
          if (!text) { resolve({}); return; }
          try { resolve(asObject(JSON.parse(text))); } catch { reject(new OneComputerError("DOCKER_INVALID_RESPONSE", "Docker returned invalid JSON", 502)); }
        });
      });
      request.on("error", (error) => reject(new OneComputerError("DOCKER_UNAVAILABLE", error.message, 503, true)));
      if (payload) request.write(payload);
      request.end();
    });
  }
}
