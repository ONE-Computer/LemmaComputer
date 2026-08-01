import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import {
  canonicalJson,
  OneComputerError,
  runtimePolicySchema,
  type RuntimePolicy,
  type ChatAgentCatalogId,
  type Sandbox,
} from "@onecomputer/contracts";
import {
  agentEnvironment,
  buildKasmClipboardLaunch,
  chatRuntimeEnvironment,
  clipboardPolicyFor,
  type SandboxAdapter,
  type SandboxCreateInput,
  type SandboxEgressPolicyUpdateInput,
  type SandboxLaunch,
} from "@onecomputer/kasm-adapter";
import { Sandbox as E2bSandbox, Volume as E2bVolume, type SandboxInfo, type SandboxOpts } from "e2b";
import { ModalClient, Probe, type App, type Image, type Sandbox as ModalSandbox, type Volume as ModalVolume } from "modal";

const desktopPort = 6901;
const chatPortFor = (catalogId: string) => ({ "claude-cli": 8643, "codex-cli": 8644, "opencode-cli": 8645, "hermes-claw": 8642 } as const)[catalogId as "claude-cli" | "codex-cli" | "opencode-cli" | "hermes-claw"];
const homePath = "/home/kasm-user";
const policyBundleMetadataKey = "oc_policy_bundle";

type ManagedConfig = {
  egressProxyUrlTemplate: string;
  timeoutMs?: number;
  timeZone?: string;
  chatAttachmentRetentionDays?: number;
};

export type E2bConfig = ManagedConfig & {
  apiKey: string;
  templateId: string;
  lifecycle?: "pause" | "kill";
};

export type ModalConfig = ManagedConfig & {
  appName: string;
  imageRef: string;
  environment?: string;
  cpu?: number;
  memoryMiB?: number;
};

type E2bInstance = {
  sandboxId: string;
  trafficAccessToken?: string;
  getHost(port: number): string;
  commands: { run(command: string, options?: {
    background?: boolean;
    cwd?: string;
    envs?: Record<string, string>;
    stdin?: boolean;
    timeoutMs?: number;
    requestTimeoutMs?: number;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  }): Promise<{ stdout: string }> };
  files: { write(path: string, data: string): Promise<unknown> };
};

export type ManagedVcrSource = "browser" | "document" | "desktop";
export type ManagedVcrCapture = {
  sourceApplication: ManagedVcrSource;
  mimeType: "image/png";
  imageBase64: string;
};

const vcrWindowClasses: Record<Exclude<ManagedVcrSource, "desktop">, string[]> = {
  browser: ["google-chrome", "Google-chrome", "firefox", "Firefox"],
  document: ["libreoffice", "LibreOffice", "soffice", "Soffice"],
};

const vcrCaptureCommand = (sourceApplication: ManagedVcrSource, framePath: string) => {
  if (sourceApplication === "desktop") {
    return `set -eu; DISPLAY=:1 gnome-screenshot -f ${framePath}; base64 -w0 ${framePath}`;
  }
  const searches = vcrWindowClasses[sourceApplication]
    .map((windowClass) => `xdotool search --onlyvisible --class ${windowClass} 2>/dev/null | head -n 1`)
    .join(" || ");
  return `set -eu; command -v xdotool >/dev/null; window=$(${searches}); test -n "$window"; xdotool windowactivate --sync "$window"; DISPLAY=:1 gnome-screenshot -w -f ${framePath}; base64 -w0 ${framePath}`;
};

export type E2bAcpProcess = {
  pid: number;
  sendStdin(data: string): Promise<void>;
  closeStdin(): Promise<void>;
  kill(): Promise<boolean>;
  wait(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

export type E2bAcpStartInput = {
  agentCatalogId: "codex-cli" | "opencode-cli";
  cwd: string;
  environment?: Readonly<Record<string, string>>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type E2bSdk = {
  create(template: string, options: SandboxOpts): Promise<E2bInstance>;
  connect(id: string, options: { apiKey: string; timeoutMs: number }): Promise<E2bInstance>;
  getInfo(id: string, options: { apiKey: string }): Promise<SandboxInfo>;
  kill(id: string, options: { apiKey: string }): Promise<boolean>;
  listSandboxes(options: { apiKey: string; workspaceId: string }): Promise<SandboxInfo[]>;
  listVolumes(options: { apiKey: string }): Promise<Array<{ volumeId: string; name: string }>>;
  createVolume(name: string, options: { apiKey: string }): Promise<{ volumeId: string }>;
  destroyVolume(id: string, options: { apiKey: string }): Promise<boolean>;
};

const defaultE2bSdk: E2bSdk = {
  create: (template, options) => E2bSandbox.create(template, options),
  connect: (id, options) => E2bSandbox.connect(id, options),
  getInfo: (id, options) => E2bSandbox.getInfo(id, options),
  kill: (id, options) => E2bSandbox.kill(id, options),
  listSandboxes: async ({ apiKey, workspaceId }) => {
    const paginator = E2bSandbox.list({
      apiKey,
      query: { metadata: { "onecomputer.workspaceId": workspaceId } },
      limit: 100,
    });
    const sandboxes: SandboxInfo[] = [];
    while (paginator.hasNext) sandboxes.push(...await paginator.nextItems({ apiKey }));
    return sandboxes;
  },
  listVolumes: (options) => E2bVolume.list(options),
  createVolume: (name, options) => E2bVolume.create(name, options),
  destroyVolume: (id, options) => E2bVolume.destroy(id, options),
};

export type ModalSdk = {
  app(name: string, environment?: string): Promise<App>;
  image(ref: string): Image;
  sandboxFromId(id: string): Promise<ModalSandbox>;
  sandboxByName(appName: string, name: string, environment?: string): Promise<ModalSandbox | null>;
  createSandbox(app: App, image: Image, options: Parameters<ModalClient["sandboxes"]["create"]>[2]): Promise<ModalSandbox>;
  volume(name: string, environment?: string): Promise<ModalVolume>;
  deleteVolume(name: string, environment?: string): Promise<void>;
  secret(values: Record<string, string>, environment?: string): Promise<ReturnType<ModalClient["secrets"]["fromObject"]> extends Promise<infer T> ? T : never>;
};

const modalSdk = (client: ModalClient): ModalSdk => ({
  app: (name, environment) => client.apps.fromName(name, { createIfMissing: true, ...(environment ? { environment } : {}) }),
  image: (ref) => client.images.fromRegistry(ref),
  sandboxFromId: (id) => client.sandboxes.fromId(id),
  sandboxByName: async (appName, name, environment) => {
    try {
      return await client.sandboxes.fromName(appName, name, environment ? { environment } : undefined);
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) return null;
      throw error;
    }
  },
  createSandbox: (app, image, options) => client.sandboxes.create(app, image, options),
  volume: (name, environment) => client.volumes.fromName(name, { createIfMissing: true, ...(environment ? { environment } : {}) }),
  deleteVolume: (name, environment) => client.volumes.delete(name, { allowMissing: true, ...(environment ? { environment } : {}) }),
  secret: (values, environment) => client.secrets.fromObject(values, environment ? { environment } : undefined),
});

const safeName = (prefix: string, workspaceId: string) => `${prefix}-${workspaceId.replaceAll("-", "")}`;
const policyBundle = (input: SandboxCreateInput) => {
  if (!input.policyBundle || !input.policyVerificationKeys) {
    throw new OneComputerError("POLICY_SIGNATURE_REQUIRED", "A signed effective policy is required", 403);
  }
  return {
    bundle: Buffer.from(canonicalJson(input.policyBundle), "utf8").toString("base64url"),
    keys: Buffer.from(canonicalJson(input.policyVerificationKeys), "utf8").toString("base64url"),
  };
};

const publicRemoteUrl = (value: string, label: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OneComputerError("MANAGED_SANDBOX_ROUTE_INVALID", `${label} must be an absolute URL`, 503);
  }
  const host = url.hostname.toLowerCase();
  const ip = isIP(host) ? host : null;
  const privateIpv4 = ip && (
    host.startsWith("10.")
    || host.startsWith("127.")
    || host.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || host === "localhost"
    || host.endsWith(".local")
    || privateIpv4
    || host === "::1"
  ) {
    throw new OneComputerError(
      "MANAGED_SANDBOX_ROUTE_UNREACHABLE",
      `${label} must be a credential-free, provider-reachable HTTPS URL`,
      503,
      true,
    );
  }
  return url;
};

const routeHosts = (input: SandboxCreateInput, proxy: URL) => {
  const routes = [
    proxy,
    ...(input.gateway ? [publicRemoteUrl(input.gateway.baseUrl, "Model gateway route")] : []),
    ...(input.agentBridge ? [publicRemoteUrl(input.agentBridge.baseUrl, "Control route")] : []),
    ...(input.agentGrants?.flatMap((grant) => [
      publicRemoteUrl(grant.gateway.baseUrl, `${grant.catalogId} model gateway route`),
      publicRemoteUrl(grant.agentBridge.baseUrl, `${grant.catalogId} control route`),
    ]) ?? []),
  ];
  return [...new Set(routes.map((url) => url.hostname))];
};

const proxyUrlFor = (input: SandboxCreateInput, template: string) => {
  if (!input.egressProxy || !input.policy.egress) {
    throw new OneComputerError(
      "MANAGED_SANDBOX_EGRESS_REQUIRED",
      "Managed cloud sandboxes require a policy-bound external egress proxy",
      503,
      true,
    );
  }
  if (
    input.egressProxy.expectedGrant.workspaceId !== input.workspaceId
    || input.egressProxy.expectedGrant.agentId !== input.policy.agentId
    || input.egressProxy.expectedGrant.securityGroupVersionId !== input.policy.egress.id
    || input.egressProxy.expectedGrant.egressMode !== input.policy.egressMode
    || input.egressProxy.expectedGrant.policyHash !== input.policy.policyHash
  ) {
    throw new OneComputerError(
      "EGRESS_PROXY_GRANT_MISMATCH",
      "The egress proxy grant does not match the sandbox policy",
      403,
    );
  }
  const expanded = template.replaceAll("{workspaceId}", encodeURIComponent(input.workspaceId));
  const url = publicRemoteUrl(expanded, "Managed sandbox egress proxy");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new OneComputerError(
      "MANAGED_SANDBOX_EGRESS_INVALID",
      "Managed sandbox egress proxy must be an origin URL without a path, query, or fragment",
      503,
    );
  }
  url.username = "onecomputer";
  url.password = input.egressProxy.token;
  return url;
};

const workspaceEnvironment = (
  input: SandboxCreateInput,
  config: ManagedConfig,
  proxyUrl: URL,
  vncPassword?: string,
) => {
  const signed = policyBundle(input);
  const fallbackAgent = ({
    "claude-desktop-managed-v1": "claude-desktop",
    "claude-cli-managed-v1": "claude-cli",
    "codex-cli-managed-v1": "codex-cli",
    "opencode-cli-managed-v1": "opencode-cli",
    "hermes-desktop-managed-v1": "hermes-desktop",
    "hermes-claw-managed-v1": "hermes-claw",
  } as const)[input.policy.agentProfile as Exclude<typeof input.policy.agentProfile, "onecomputer-default-agent">] ?? "claude-desktop";
  const agents = input.agentGrants?.map((grant) => grant.catalogId) ?? [fallbackAgent];
  const applications = input.policy.applications ?? ["firefox"];
  const noProxy = [
    "localhost",
    "127.0.0.1",
    ...(input.gateway ? [new URL(input.gateway.baseUrl).hostname] : []),
    ...(input.agentBridge ? [new URL(input.agentBridge.baseUrl).hostname] : []),
    ...(input.agentGrants?.flatMap((grant) => [
      new URL(grant.gateway.baseUrl).hostname,
      new URL(grant.agentBridge.baseUrl).hostname,
    ]) ?? []),
  ].join(",");
  const entries = [
    ...(vncPassword ? [`VNC_PW=${vncPassword}`] : []),
    ...(vncPassword ? [] : ["VNCOPTIONS=-DisableBasicAuth=1"]),
    "VNC_RESOLUTION=1440x900",
    ...(config.timeZone ? [`TZ=${config.timeZone}`, `ONECOMPUTER_TIME_ZONE=${config.timeZone}`] : []),
    ...(config.chatAttachmentRetentionDays ? [`ONECOMPUTER_CHAT_ATTACHMENT_RETENTION_DAYS=${config.chatAttachmentRetentionDays}`] : []),
    `ONECOMPUTER_CLIPBOARD_ENABLED=${clipboardPolicyFor(input.policy).enabled}`,
    `ONECOMPUTER_CLIPBOARD_LOCAL_TO_WORKSPACE=${clipboardPolicyFor(input.policy).localToWorkspace}`,
    `ONECOMPUTER_CLIPBOARD_WORKSPACE_TO_LOCAL=${clipboardPolicyFor(input.policy).workspaceToLocal}`,
    `ONECOMPUTER_CLIPBOARD_MAX_BYTES=${clipboardPolicyFor(input.policy).maxBytes}`,
    `ONECOMPUTER_ENABLED_AGENTS=${agents.join(",")}`,
    `ONECOMPUTER_ENABLED_APPLICATIONS=${applications.join(",")}`,
    "ONECOMPUTER_COWORK_ENABLED=false",
    `ONECOMPUTER_EXECUTION_MODE=${input.policy.executionMode}`,
    `ONECOMPUTER_EGRESS_MODE=${input.policy.egressMode}`,
    `ONECOMPUTER_SIGNED_POLICY_B64=${signed.bundle}`,
    `ONECOMPUTER_POLICY_VERIFICATION_KEYS_B64=${signed.keys}`,
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
    `HTTP_PROXY=${proxyUrl.toString()}`,
    `HTTPS_PROXY=${proxyUrl.toString()}`,
    `http_proxy=${proxyUrl.toString()}`,
    `https_proxy=${proxyUrl.toString()}`,
    `NO_PROXY=${noProxy}`,
    `no_proxy=${noProxy}`,
  ];
  return Object.fromEntries(entries.map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
};

const metadataFor = (input: SandboxCreateInput) => ({
  "onecomputer.provider": "managed",
  "onecomputer.workspaceId": input.workspaceId,
  "onecomputer.policyVersion": String(input.policy.policyVersion),
  "onecomputer.policyHash": input.policy.policyHash,
  "onecomputer.policyVersionId": input.policy.policyVersionId,
  "onecomputer.clipboardEnabled": String(clipboardPolicyFor(input.policy).enabled),
  "onecomputer.clipboardUp": String(clipboardPolicyFor(input.policy).localToWorkspace),
  "onecomputer.clipboardDown": String(clipboardPolicyFor(input.policy).workspaceToLocal),
  "onecomputer.clipboardMaxBytes": String(clipboardPolicyFor(input.policy).maxBytes),
  ...(input.policy.egress ? {
    "onecomputer.egressVersionId": input.policy.egress.id,
    "onecomputer.egressHash": input.policy.egress.documentHash,
  } : {}),
  ...(input.policyBundle ? {
    [policyBundleMetadataKey]: Buffer.from(canonicalJson(input.policyBundle), "utf8").toString("base64url"),
  } : {}),
  ...(input.chatRuntimes?.length ? {
    "onecomputer.chatAgents": input.chatRuntimes.map((runtime) => runtime.catalogId).join(","),
  } : {}),
});

const chatEndpointsFor = (sandbox: Pick<E2bInstance, "getHost">, metadata: Record<string, string>) => (
  (metadata["onecomputer.chatAgents"] ?? "").split(",").filter(Boolean).flatMap((catalogId) => {
    const port = chatPortFor(catalogId);
    return port ? [{ catalogId: catalogId as ChatAgentCatalogId, url: `https://${sandbox.getHost(port)}` }] : [];
  })
);

const clipboardFromMetadata = (metadata: Record<string, string>) => {
  const maxBytes = Number(metadata["onecomputer.clipboardMaxBytes"]);
  if (
    !["true", "false"].includes(metadata["onecomputer.clipboardEnabled"] ?? "")
    || !["true", "false"].includes(metadata["onecomputer.clipboardUp"] ?? "")
    || !["true", "false"].includes(metadata["onecomputer.clipboardDown"] ?? "")
    || !Number.isInteger(maxBytes)
    || maxBytes < 1
    || maxBytes > 1_048_576
  ) return clipboardPolicyFor();
  return {
    enabled: metadata["onecomputer.clipboardEnabled"] === "true",
    localToWorkspace: metadata["onecomputer.clipboardUp"] === "true",
    workspaceToLocal: metadata["onecomputer.clipboardDown"] === "true",
    maxBytes,
  };
};

const sandboxView = (
  providerId: string,
  state: Sandbox["state"],
  metadata: Record<string, string>,
): Sandbox => ({
  providerId,
  ...(metadata["onecomputer.workspaceId"] ? { workspaceId: metadata["onecomputer.workspaceId"] } : {}),
  state,
  failureCode: null,
  ...(metadata["onecomputer.egressVersionId"] && metadata["onecomputer.egressHash"] ? {
    egressPolicyProjection: {
      securityGroupVersionId: metadata["onecomputer.egressVersionId"],
      documentHash: metadata["onecomputer.egressHash"],
    },
  } : {}),
  ...(metadata[policyBundleMetadataKey] ? {
    projectedPolicyBundle: JSON.parse(Buffer.from(metadata[policyBundleMetadataKey], "base64url").toString("utf8")),
    policyProjectionPresent: true,
  } : {}),
});

const providerFailure = (provider: "E2B" | "Modal", error: unknown): never => {
  if (error instanceof OneComputerError) throw error;
  throw new OneComputerError(
    `${provider.toUpperCase()}_UPSTREAM_ERROR`,
    `${provider} sandbox operation failed`,
    502,
    true,
  );
};

export class E2bSandboxAdapter implements SandboxAdapter {
  private readonly timeoutMs: number;
  constructor(private readonly config: E2bConfig, private readonly sdk: E2bSdk = defaultE2bSdk) {
    this.timeoutMs = config.timeoutMs ?? 3_600_000;
  }

  async create(input: SandboxCreateInput): Promise<Sandbox> {
    let createdSandboxId: string | undefined;
    let createdVolumeId: string | undefined;
    try {
      input = { ...input, policy: runtimePolicySchema.parse(input.policy) };
      const proxy = proxyUrlFor(input, this.config.egressProxyUrlTemplate);
      const hosts = routeHosts(input, proxy);
      const existing = (await this.sdk.listSandboxes({ apiKey: this.config.apiKey, workspaceId: input.workspaceId }))[0];
      if (existing?.metadata["onecomputer.policyHash"] === input.policy.policyHash) {
        if (existing.state === "paused") {
          await this.sdk.connect(existing.sandboxId, { apiKey: this.config.apiKey, timeoutMs: this.timeoutMs });
        }
        const chatAgents = existing.metadata["onecomputer.chatAgents"];
        if (!chatAgents) return sandboxView(existing.sandboxId, "ready", existing.metadata);
        const connected = await this.sdk.connect(existing.sandboxId, { apiKey: this.config.apiKey, timeoutMs: this.timeoutMs });
        return { ...sandboxView(existing.sandboxId, "ready", existing.metadata), chatEndpoints: chatEndpointsFor(connected, existing.metadata) };
      }
      if (existing) await this.sdk.kill(existing.sandboxId, { apiKey: this.config.apiKey });
      const volumes = await this.sdk.listVolumes({ apiKey: this.config.apiKey });
      const volumeName = safeName("oc", input.workspaceId);
      const existingVolume = volumes.find((volume) => volume.name === volumeName);
      if (!existingVolume) {
        createdVolumeId = (await this.sdk.createVolume(volumeName, { apiKey: this.config.apiKey })).volumeId;
      }
      const password = randomBytes(24).toString("base64url");
      const sandbox = await this.sdk.create(this.config.templateId, {
        apiKey: this.config.apiKey,
        timeoutMs: this.timeoutMs,
        secure: true,
        allowInternetAccess: true,
        lifecycle: {
          onTimeout: this.config.lifecycle ?? "pause",
          autoResume: (this.config.lifecycle ?? "pause") === "pause",
        },
        network: {
          allowPublicTraffic: true,
          allowOut: hosts,
          denyOut: [],
        },
        metadata: metadataFor(input),
        envs: workspaceEnvironment(input, this.config, proxy, password),
        volumeMounts: { [homePath]: volumeName },
      });
      createdSandboxId = sandbox.sandboxId;
      await sandbox.commands.run(
        "/usr/local/sbin/onecomputer-workspace-entrypoint --tail-log >/run/onecomputer/workspace-bootstrap.log 2>&1",
        { background: true },
      );
      await sandbox.commands.run(
        "for attempt in $(seq 1 600); do "
        + "test -f /run/onecomputer/workspace-ready && exit 0; "
        + "sleep 0.2; done; exit 1",
        // E2B's foreground command connection defaults to 60s. Bootstrap is
        // bounded at two minutes, so make the transport timeout explicit.
        { timeoutMs: 150_000, requestTimeoutMs: 150_000 },
      );
      return { ...sandboxView(sandbox.sandboxId, "ready", metadataFor(input)), chatEndpoints: chatEndpointsFor(sandbox, metadataFor(input)) };
    } catch (error) {
      // E2B allocates resources before workspace readiness is proven. Roll back
      // only resources created by this attempt and preserve the original error.
      if (createdSandboxId) {
        await this.sdk.kill(createdSandboxId, { apiKey: this.config.apiKey }).catch(() => undefined);
      }
      if (createdVolumeId) {
        await this.sdk.destroyVolume(createdVolumeId, { apiKey: this.config.apiKey }).catch(() => undefined);
      }
      return providerFailure("E2B", error);
    }
  }

  async status(providerId: string): Promise<Sandbox> {
    try {
      const info = await this.sdk.getInfo(providerId, { apiKey: this.config.apiKey });
      // E2B pause is a resumable state, not a terminal stop. Connecting is
      // deliberately the status operation here: the SDK resumes a paused
      // sandbox and refreshes its provider session before we expose chat
      // endpoints. Only a killed/missing sandbox is terminal.
      if (info.state !== "running" && info.state !== "paused") return sandboxView(providerId, "stopped", info.metadata);
      const connected = await this.sdk.connect(providerId, { apiKey: this.config.apiKey, timeoutMs: this.timeoutMs });
      if (!info.metadata["onecomputer.chatAgents"]) return sandboxView(providerId, "ready", info.metadata);
      return { ...sandboxView(providerId, "ready", info.metadata), chatEndpoints: chatEndpointsFor(connected, info.metadata) };
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        return { providerId, state: "stopped", failureCode: null };
      }
      return providerFailure("E2B", error);
    }
  }

  async open(providerId: string): Promise<SandboxLaunch> {
    try {
      const sandbox = await this.sdk.connect(providerId, { apiKey: this.config.apiKey, timeoutMs: this.timeoutMs });
      const metadata = (await this.sdk.getInfo(providerId, { apiKey: this.config.apiKey })).metadata;
      await sandbox.commands.run("test -f /run/onecomputer/workspace-ready");
      const password = (await sandbox.commands.run("printf %s \"$VNC_PW\"")).stdout.trim();
      if (password.length < 16) throw new OneComputerError("E2B_DESKTOP_AUTH_UNAVAILABLE", "The E2B desktop credential is unavailable", 502, true);
      const url = new URL(`https://${sandbox.getHost(desktopPort)}`);
      url.username = "kasm_user";
      url.password = password;
      return buildKasmClipboardLaunch(url.toString(), clipboardFromMetadata(metadata));
    } catch (error) {
      return providerFailure("E2B", error);
    }
  }

  /** Capture inside the provider boundary; callers upload the returned bytes through the Control-owned VCR grant. */
  async captureFrame(providerId: string, sourceApplication: ManagedVcrSource): Promise<ManagedVcrCapture> {
    try {
      const sandbox = await this.sdk.connect(providerId, { apiKey: this.config.apiKey, timeoutMs: this.timeoutMs });
      const framePath = `/tmp/onecomputer-vcr-${sourceApplication}.png`;
      const result = await sandbox.commands.run(
        vcrCaptureCommand(sourceApplication, framePath),
      );
      const imageBase64 = result.stdout.trim();
      const bytes = Buffer.from(imageBase64, "base64");
      if (bytes.length < 8 || bytes.subarray(0, 8).compare(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) !== 0 || bytes.length > 3 * 1024 * 1024) {
        throw new OneComputerError("E2B_VCR_CAPTURE_INVALID", "The E2B screenshot was not a bounded PNG", 502, true);
      }
      return { sourceApplication, mimeType: "image/png", imageBase64 };
    } catch (error) {
      return providerFailure("E2B", error);
    }
  }

  /** Start the ACP harness in E2B; stdin/stdout remain inside the provider boundary and are callback-streamed to Control. */
  async startAcp(providerId: string, input: E2bAcpStartInput): Promise<E2bAcpProcess> {
    try {
      const sandbox = await this.sdk.connect(providerId, { apiKey: this.config.apiKey, timeoutMs: this.timeoutMs });
      const command = input.agentCatalogId === "opencode-cli" ? "opencode acp" : "codex-acp";
      const run = sandbox.commands.run as unknown as (command: string, options: {
        background: true;
        cwd: string;
        envs: Record<string, string>;
        stdin: true;
        timeoutMs?: number;
        requestTimeoutMs?: number;
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
      }) => Promise<{ pid: number; sendStdin(data: string): Promise<void>; closeStdin(): Promise<void>; kill(): Promise<boolean>; wait(): Promise<{ exitCode: number; stdout: string; stderr: string }> }>;
      // E2B provides structured working-directory and environment arguments.
      // Do not interpolate either into a shell command: ACP prompts and future
      // provider configuration may contain shell-significant characters.
      return await run(command, {
        background: true,
        cwd: input.cwd,
        envs: { ...(input.environment ?? {}) },
        stdin: true,
        // ACP is a long-lived stdin/stdout transport. The Control task
        // deadline, not E2B's command connection default, owns termination.
        timeoutMs: 0,
        requestTimeoutMs: 150_000,
        onStdout: input.onStdout,
        onStderr: input.onStderr,
      });
    } catch (error) {
      return providerFailure("E2B", error);
    }
  }

  async updateEgressPolicy(_providerId: string, _input: SandboxEgressPolicyUpdateInput) {
    try {
      const proxy = proxyUrlFor(_input, this.config.egressProxyUrlTemplate);
      const sandbox = await this.sdk.connect(_providerId, { apiKey: this.config.apiKey, timeoutMs: this.timeoutMs });
      await sandbox.files.write("/run/onecomputer/egress-upstream", `${proxy.toString()}\n`);
      await sandbox.commands.run(
        "bash -lc 'kill \"$(cat /run/onecomputer/egress-broker.pid)\"; "
        + "ONECOMPUTER_EGRESS_UPSTREAM_FILE=/run/onecomputer/egress-upstream "
        + "nohup /usr/local/libexec/onecomputer-egress-broker >/run/onecomputer/egress-broker.log 2>&1 & "
        + "broker_pid=$!; printf %s \"$broker_pid\" >/run/onecomputer/egress-broker.pid'",
      );
    } catch (error) {
      return providerFailure("E2B", error);
    }
  }

  async destroy(providerId: string) {
    try {
      await this.sdk.kill(providerId, { apiKey: this.config.apiKey });
    } catch (error) {
      if (!(error instanceof Error && /not found/i.test(error.message))) providerFailure("E2B", error);
    }
  }

  async purgeWorkspace(workspaceId: string) {
    try {
      // Reconcile every provider sandbox tagged to this workspace before
      // deleting its volume. This also removes allocations left behind when
      // bootstrap failed before Control persisted a providerId.
      const sandboxes = await this.sdk.listSandboxes({ apiKey: this.config.apiKey, workspaceId });
      await Promise.all(sandboxes.map(async (sandbox) => {
        await this.sdk.kill(sandbox.sandboxId, { apiKey: this.config.apiKey }).catch((error: unknown) => {
          if (!(error instanceof Error && /not found/i.test(error.message))) throw error;
        });
      }));
      const volume = (await this.sdk.listVolumes({ apiKey: this.config.apiKey }))
        .find((candidate) => candidate.name === safeName("oc", workspaceId));
      if (volume) await this.sdk.destroyVolume(volume.volumeId, { apiKey: this.config.apiKey });
    } catch (error) {
      providerFailure("E2B", error);
    }
  }
}

export class ModalSandboxAdapter implements SandboxAdapter {
  private readonly timeoutMs: number;
  constructor(private readonly config: ModalConfig, private readonly sdk: ModalSdk = modalSdk(new ModalClient())) {
    this.timeoutMs = config.timeoutMs ?? 3_600_000;
  }

  async create(input: SandboxCreateInput): Promise<Sandbox> {
    try {
      input = { ...input, policy: runtimePolicySchema.parse(input.policy) };
      const proxy = proxyUrlFor(input, this.config.egressProxyUrlTemplate);
      const hosts = routeHosts(input, proxy);
      const name = safeName("oc", input.workspaceId);
      const existing = await this.sdk.sandboxByName(this.config.appName, name, this.config.environment);
      if (existing) {
        const tags = await existing.getTags();
        if (tags["onecomputer.policyHash"] === input.policy.policyHash) {
          return sandboxView(existing.sandboxId, "ready", tags);
        }
        await existing.terminate();
      }
      const app = await this.sdk.app(this.config.appName, this.config.environment);
      const image = this.sdk.image(this.config.imageRef);
      const volume = await this.sdk.volume(safeName("oc", input.workspaceId), this.config.environment);
      const safeMetadata = metadataFor(input);
      delete safeMetadata[policyBundleMetadataKey];
      const environment = workspaceEnvironment(input, this.config, proxy);
      const secret = await this.sdk.secret(environment, this.config.environment);
      const sandbox = await this.sdk.createSandbox(app, image, {
        name,
        command: ["/usr/local/sbin/onecomputer-workspace-entrypoint", "--tail-log"],
        timeoutMs: this.timeoutMs,
        cpu: this.config.cpu ?? 2,
        memoryMiB: this.config.memoryMiB ?? 4096,
        encryptedPorts: [desktopPort],
        outboundDomainAllowlist: hosts,
        outboundCidrAllowlist: [],
        volumes: { [homePath]: volume },
        secrets: [secret],
        tags: safeMetadata,
        readinessProbe: Probe.withExec(["test", "-f", "/run/onecomputer/workspace-ready"], { intervalMs: 1_000 }),
      });
      await sandbox.waitUntilReady(Math.min(this.timeoutMs, 120_000));
      return sandboxView(sandbox.sandboxId, "ready", metadataFor(input));
    } catch (error) {
      return providerFailure("Modal", error);
    }
  }

  async status(providerId: string): Promise<Sandbox> {
    try {
      const sandbox = await this.sdk.sandboxFromId(providerId);
      const metadata = await sandbox.getTags();
      return sandboxView(providerId, "ready", metadata);
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        return { providerId, state: "stopped", failureCode: null };
      }
      return providerFailure("Modal", error);
    }
  }

  async open(providerId: string): Promise<SandboxLaunch> {
    try {
      const sandbox = await this.sdk.sandboxFromId(providerId);
      const metadata = await sandbox.getTags();
      const credentials = await sandbox.createConnectToken({
        port: desktopPort,
        userMetadata: JSON.stringify({ providerId: createHash("sha256").update(providerId).digest("hex").slice(0, 16) }),
      });
      const url = new URL(credentials.url);
      url.searchParams.set("_modal_connect_token", credentials.token);
      return buildKasmClipboardLaunch(url.toString(), clipboardFromMetadata(metadata));
    } catch (error) {
      return providerFailure("Modal", error);
    }
  }

  async updateEgressPolicy(_providerId: string, _input: SandboxEgressPolicyUpdateInput) {
    try {
      const proxy = proxyUrlFor(_input, this.config.egressProxyUrlTemplate);
      const sandbox = await this.sdk.sandboxFromId(_providerId);
      await sandbox.filesystem.writeText(`${proxy.toString()}\n`, "/run/onecomputer/egress-upstream");
      const process = await sandbox.exec([
        "bash",
        "-lc",
        "kill \"$(cat /run/onecomputer/egress-broker.pid)\"; "
        + "ONECOMPUTER_EGRESS_UPSTREAM_FILE=/run/onecomputer/egress-upstream "
        + "nohup /usr/local/libexec/onecomputer-egress-broker >/run/onecomputer/egress-broker.log 2>&1 & "
        + "broker_pid=$!; printf %s \"$broker_pid\" >/run/onecomputer/egress-broker.pid",
      ]);
      const exitCode = await process.wait();
      if (exitCode !== 0) throw new Error(`egress broker restart returned ${exitCode}`);
    } catch (error) {
      return providerFailure("Modal", error);
    }
  }

  async destroy(providerId: string) {
    try {
      await (await this.sdk.sandboxFromId(providerId)).terminate();
    } catch (error) {
      if (!(error instanceof Error && /not found/i.test(error.message))) providerFailure("Modal", error);
    }
  }

  async purgeWorkspace(workspaceId: string) {
    try {
      await this.sdk.deleteVolume(safeName("oc", workspaceId), this.config.environment);
    } catch (error) {
      providerFailure("Modal", error);
    }
  }
}
