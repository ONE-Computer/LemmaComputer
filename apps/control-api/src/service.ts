import {
  LemmaComputerError,
  readinessFor,
  runtimePolicySchema,
  type IdentityContext,
  type Launch,
  type PolicyIntegrityView,
  type PolicyVerificationKeySet,
  type ChatAgentCatalogId,
  type RuntimeAgentPolicy,
  type RuntimePolicy,
  type Sandbox,
  type SignedPolicyBundle,
  type WorkspaceContentDisposition,
  type WorkspaceDeletionImpact,
  type WorkspaceView,
} from "@lemmacomputer/contracts";
import { deriveEgressProxySecret, issueEgressProxyGrant } from "@lemmacomputer/egress-policy";
import type { FetchLike, GatewayClient, GatewayGrant, GatewayReadiness } from "@lemmacomputer/litellm-adapter";
import type { WorkspacePurgeReceipt } from "@lemmacomputer/kasm-adapter";
import { PolicyBundleSigner, PolicyVerificationError, verifySignedPolicyBundle, type VerifiedPolicyBundle } from "@lemmacomputer/policy-integrity";
import {
  WorkspaceIngressAuthority,
  workspaceIngressAccessParameter,
} from "@lemmacomputer/workspace-ingress-auth";
import type { WorkspaceNode, WorkspaceRecord, WorkspaceStore } from "@lemmacomputer/workspace-store";
import { AgentChatAuthority, type AgentChatAccess } from "./agent-chat.js";

export type ControllerLaunch = Launch & {
  ingressTarget?: {
    protocol: "http" | "https";
    host: string;
    port: number;
  };
};

export interface ControllerClient {
  create(input: {
    workspaceId: string;
    accessGeneration: number;
    correlationId: string;
    policy: RuntimePolicy;
    policyBundle?: SignedPolicyBundle;
    gateway?: GatewayGrant;
    agentBridge?: { baseUrl: string; token: string };
    agentGrants?: Array<{ catalogId: RuntimeAgentPolicy["catalogId"]; agentId: string; gateway: GatewayGrant; agentBridge: { baseUrl: string; token: string } }>;
    chatRuntimes?: Array<{ catalogId: ChatAgentCatalogId; key: string }>;
    egressProxy?: EgressProxyGrant;
  }): Promise<Sandbox>;
  updateEgressPolicy(providerId: string, input: {
    workspaceId: string;
    policy: RuntimePolicy;
    policyBundle: SignedPolicyBundle;
    egressProxy: EgressProxyGrant;
  }): Promise<void>;
  status(workspaceId: string, providerId: string): Promise<Sandbox>;
  open(workspaceId: string, providerId: string): Promise<ControllerLaunch>;
  destroyWorkspace(workspaceId: string, providerId: string, expectedWorkspaceNodeId?: string): Promise<void>;
  purgeWorkspace(workspaceId: string, accessGeneration: number, expectedWorkspaceNodeId?: string): Promise<WorkspacePurgeReceipt>;
}

export type EgressProxyGrant = {
  token: string;
  verificationSecret: string;
  expiresAt: string;
  expectedGrant: {
    tenantId: string;
    subjectId: string;
    workspaceId: string;
    accessGeneration: number;
    agentId: string;
    securityGroupVersionId: string;
    egressMode: RuntimePolicy["egressMode"];
    policyHash: string;
  };
  accessAuthorization?: { url: string; token: string };
};

export class EgressProxyGrantAuthority {
  constructor(
    private readonly rootSecret: string,
    private readonly accessAuthorization?: { url: string; token: string },
  ) {}

  issue(identity: IdentityContext, workspace: Pick<WorkspaceRecord, "id" | "accessGeneration">, policy: RuntimePolicy): EgressProxyGrant | undefined {
    if (!policy.egress) return undefined;
    const workspaceId = workspace.id;
    const verificationSecret = deriveEgressProxySecret(this.rootSecret, workspaceId);
    const expectedGrant = {
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      workspaceId,
      accessGeneration: workspace.accessGeneration,
      agentId: policy.agentId,
      securityGroupVersionId: policy.egress.id,
      egressMode: policy.egressMode,
      policyHash: policy.policyHash,
    };
    const ttlSeconds = 24 * 60 * 60;
    return {
      token: issueEgressProxyGrant(verificationSecret, expectedGrant, new Date(), ttlSeconds),
      verificationSecret,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      expectedGrant,
      accessAuthorization: this.accessAuthorization,
    };
  }
}

export class PolicyBundleAuthority {
  constructor(
    private readonly signer: PolicyBundleSigner,
    readonly verificationKeys: PolicyVerificationKeySet,
    private readonly routes: { modelGateway: string; mcpControl: string },
    private readonly ttlSeconds = 15 * 60,
  ) {}

  authorize(identity: IdentityContext, workspaceId: string, accessGeneration: number, policy: RuntimePolicy, now = new Date()) {
    try {
      const normalizedPolicy = runtimePolicySchema.parse(policy);
      const bundle = this.signer.issue({
        identity,
        workspaceId,
        accessGeneration,
        policy: normalizedPolicy,
        routes: this.routes,
        ttlSeconds: this.ttlSeconds,
        now,
      });
      return verifySignedPolicyBundle(bundle, this.verificationKeys, {
        identity,
        workspaceId,
        accessGeneration,
        policy: normalizedPolicy,
        minimumPolicyVersion: normalizedPolicy.policyVersion,
        now,
      });
    } catch (error) {
      if (error instanceof PolicyVerificationError) {
        throw new LemmaComputerError(error.code, error.message, 503);
      }
      throw error;
    }
  }
}

// The controller owns the workspace startup deadline. Control needs additional
// transport grace so it can receive and preserve the controller's typed result.
export const DEFAULT_CONTROLLER_REQUEST_TIMEOUT_MS = 90_000;

export class HttpControllerClient implements ControllerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly transport: FetchLike = fetch,
    private readonly requestTimeoutMs = DEFAULT_CONTROLLER_REQUEST_TIMEOUT_MS,
  ) {}
  private async call(path: string, init?: RequestInit) {
    const hasBody = init?.body !== undefined;
    const response = await this.transport(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...(hasBody ? { "content-type": "application/json" } : {}), "x-controller-token": this.token, ...init?.headers },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string; retryable?: boolean } };
      throw new LemmaComputerError(payload.error?.code ?? "CONTROLLER_ERROR", payload.error?.message ?? "Workspace controller request failed", response.status, payload.error?.retryable ?? response.status >= 500);
    }
    return response.status === 204 ? {} : response.json();
  }
  async create(input: Parameters<ControllerClient["create"]>[0]) {
    return await this.call(`/internal/v2/workspaces/${encodeURIComponent(input.workspaceId)}/sandbox`, { method: "POST", body: JSON.stringify(input) }) as Sandbox;
  }
  async updateEgressPolicy(providerId: string, input: Parameters<ControllerClient["updateEgressPolicy"]>[1]) {
    await this.call(`/internal/v2/workspaces/${encodeURIComponent(input.workspaceId)}/sandboxes/${encodeURIComponent(providerId)}/egress-policy`, { method: "PUT", body: JSON.stringify(input) });
  }
  async status(workspaceId: string, providerId: string) { return await this.call(`/internal/v2/workspaces/${encodeURIComponent(workspaceId)}/sandboxes/${encodeURIComponent(providerId)}`) as Sandbox; }
  async open(workspaceId: string, providerId: string) { return await this.call(`/internal/v2/workspaces/${encodeURIComponent(workspaceId)}/sandboxes/${encodeURIComponent(providerId)}/open`, { method: "POST" }) as Launch; }
  async destroyWorkspace(workspaceId: string, providerId: string) {
    await this.call(`/internal/v2/workspaces/${encodeURIComponent(workspaceId)}/sandboxes/${encodeURIComponent(providerId)}`, { method: "DELETE" });
  }
  async purgeWorkspace(workspaceId: string, accessGeneration: number) {
    return await this.call(`/internal/v2/workspaces/${encodeURIComponent(workspaceId)}/storage?accessGeneration=${encodeURIComponent(String(accessGeneration))}`, { method: "DELETE" }) as WorkspacePurgeReceipt;
  }
}

export interface WorkspaceNodeDirectory {
  resolveWorkspaceNode(workspaceId: string, expectedWorkspaceNodeId?: string): Promise<WorkspaceNode>;
}

export class RoutedControllerClient implements ControllerClient {
  private readonly clients = new Map<string, ControllerClient>();

  constructor(
    private readonly directory: WorkspaceNodeDirectory,
    private readonly clientForNode: (node: WorkspaceNode) => ControllerClient,
  ) {}

  private async route(workspaceId: string, expectedWorkspaceNodeId?: string) {
    const node = await this.directory.resolveWorkspaceNode(workspaceId, expectedWorkspaceNodeId);
    const cacheKey = `${node.id}\0${node.endpointUrl}\0${node.tlsServerName}`;
    let client = this.clients.get(cacheKey);
    if (!client) {
      client = this.clientForNode(node);
      this.clients.set(cacheKey, client);
    }
    return { node, client };
  }

  async create(input: Parameters<ControllerClient["create"]>[0]) {
    const { client } = await this.route(input.workspaceId);
    return client.create(input);
  }

  async updateEgressPolicy(providerId: string, input: Parameters<ControllerClient["updateEgressPolicy"]>[1]) {
    const { client } = await this.route(input.workspaceId);
    return client.updateEgressPolicy(providerId, input);
  }

  async status(workspaceId: string, providerId: string) {
    const { client } = await this.route(workspaceId);
    return client.status(workspaceId, providerId);
  }

  async open(workspaceId: string, providerId: string) {
    const { client } = await this.route(workspaceId);
    return client.open(workspaceId, providerId);
  }

  async destroyWorkspace(workspaceId: string, providerId: string, expectedWorkspaceNodeId?: string) {
    const { client } = await this.route(workspaceId, expectedWorkspaceNodeId);
    return client.destroyWorkspace(workspaceId, providerId);
  }

  async purgeWorkspace(workspaceId: string, accessGeneration: number, expectedWorkspaceNodeId?: string) {
    const { node, client } = await this.route(workspaceId, expectedWorkspaceNodeId);
    const receipt = await client.purgeWorkspace(workspaceId, accessGeneration);
    if (receipt.nodeId !== node.id) {
      throw new LemmaComputerError(
        "WORKSPACE_NODE_RECEIPT_MISMATCH",
        "Workspace purge receipt was issued by a different node",
        502,
      );
    }
    return receipt;
  }
}

const profileClient = (profileId: RuntimePolicy["workspaceProfile"]) => profileId === "claude-desktop-standard-v1"
  ? { client: "LemmaComputer managed workspace", clientVersion: "managed-v1" }
  : profileId === "disposable-open-v1"
    ? { client: "LemmaComputer open workspace", clientVersion: "disposable-open-v1" }
    : { client: "LemmaComputer qualification CLI", clientVersion: "issue-006" };

const hasAiAgents = (policy: RuntimePolicy) => policy.agents === undefined || policy.agents.length > 0;

export const toView = (
  record: WorkspaceRecord,
  gateway?: GatewayReadiness,
  policy?: RuntimePolicy,
  policyIntegrity?: PolicyIntegrityView,
  policyCompatibility?: WorkspaceView["policyCompatibility"],
): WorkspaceView => ({
  id: record.id,
  grantId: record.grantId,
  state: record.state,
  readiness: readinessFor(record.state, gateway),
  ...(gateway ? { modelRoute: gateway.modelRoute } : {}),
  ...(policy ? { applications: policy.applications } : {}),
  ...(policyIntegrity ? { policyIntegrity } : {}),
  ...(policy?.agents ? {
    agents: policy.agents.map((agent) => ({
      id: agent.catalogId,
      displayName: agent.displayName,
      clientVersion: agent.clientVersion,
      agentId: agent.agentId,
      state: record.state === "failed"
        ? "unavailable" as const
        : ["provisioning", "restarting"].includes(record.state)
          ? "starting" as const
          : ["ready", "open"].includes(record.state)
            // Connector health is reported independently by readiness.tools.
            // It cannot downgrade the selected agent's core lifecycle state.
            ? gateway?.models === "failed" ? "degraded" as const : "ready" as const
            : "selected" as const,
    })),
  } : {}),
  ...(policy ? { policyAssignment: {
    version: policy.policyVersion,
    hash: policy.policyHash,
  } } : {}),
  ...(policyCompatibility ? { policyCompatibility } : {}),
  ...(policy ? { profile: {
    id: policy.workspaceProfile,
    ...profileClient(policy.workspaceProfile),
    modelAlias: hasAiAgents(policy) ? policy.modelAlias : null,
    executionMode: policy.executionMode,
    egressMode: policy.egressMode,
    persistence: "persistent-home" as const,
    network: "gateway-only" as const,
  } } : {}),
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
  failureCode: record.failureCode,
});

export class WorkspaceService {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly controller: ControllerClient,
    private readonly gateway?: GatewayClient,
    private readonly agentBridge?: { baseUrl: string; issue: (identity: IdentityContext, workspace: WorkspaceRecord, policy: RuntimePolicy) => string },
    private readonly egressProxyAuthority?: EgressProxyGrantAuthority,
    private readonly policyBundleAuthority?: PolicyBundleAuthority,
    private readonly agentChatAuthority?: AgentChatAuthority,
    private readonly workspaceIngress?: {
      publicUrl: string;
      authority: WorkspaceIngressAuthority;
    },
  ) {}

  private authorizePolicy(identity: IdentityContext, workspace: Pick<WorkspaceRecord, "id" | "accessGeneration">, policy: RuntimePolicy) {
    return this.policyBundleAuthority?.authorize(identity, workspace.id, workspace.accessGeneration, policy);
  }

  private integrityFor(policy: RuntimePolicy, enforced?: VerifiedPolicyBundle, projected?: PolicyIntegrityView): PolicyIntegrityView | undefined {
    if (!this.policyBundleAuthority || !enforced) return projected;
    const enforcedView = {
      version: enforced.payload.policy.policyVersion,
      digest: enforced.payload.policy.policyHash,
      bundleDigest: enforced.bundleDigest,
      keyId: enforced.keyId,
      verifiedAt: enforced.verifiedAt,
    };
    const expected = { version: policy.policyVersion, digest: policy.policyHash };
    if (!projected?.projected) {
      return {
        state: projected?.state === "invalid" || projected?.state === "expired" ? projected.state : "unavailable",
        reasonCode: projected?.reasonCode ?? "POLICY_PROJECTION_UNAVAILABLE",
        expected,
        projected: null,
        enforced: enforcedView,
      };
    }
    const drift = projected.projected.version !== policy.policyVersion
      || projected.projected.digest !== policy.policyHash;
    return {
      state: drift ? "drift" : projected.state,
      reasonCode: drift ? "POLICY_PROJECTION_DRIFT" : projected.reasonCode,
      expected,
      projected: projected.projected,
      enforced: enforcedView,
    };
  }

  private bridgeGrant(identity: IdentityContext, workspace: WorkspaceRecord, policy: RuntimePolicy) {
    return this.agentBridge ? { baseUrl: this.agentBridge.baseUrl, token: this.agentBridge.issue(identity, workspace, policy) } : undefined;
  }

  private agentPolicies(policy: RuntimePolicy): RuntimePolicy[] {
    if (policy.agents === undefined) return [policy];
    return policy.agents.map((agent) => ({
      ...policy,
      agentId: agent.agentId,
      agentProfile: agent.agentProfile,
      modelAlias: agent.modelAlias,
      mcpServer: agent.mcpServer,
      allowedTools: agent.allowedTools,
      toolPolicies: agent.toolPolicies,
      agents: [agent],
    }));
  }

  private async ensureAgentGrants(identity: IdentityContext, workspace: WorkspaceRecord, policy: RuntimePolicy) {
    const workspaceId = workspace.id;
    const policies = this.agentPolicies(policy);
    if (policies.length === 0) return {};
    const resolved = await Promise.all(policies.map(async (agentPolicy) => ({
      policy: agentPolicy,
      gateway: await this.gateway?.ensureGrant({
        workspaceId,
        accessGeneration: workspace.accessGeneration,
        identity,
        agentId: agentPolicy.agentId,
        policy: agentPolicy,
      }),
      agentBridge: this.bridgeGrant(identity, workspace, agentPolicy),
    })));
    const primary = resolved[0]!;
    const agentGrants = policy.agents?.length && this.gateway && this.agentBridge
      ? resolved.map((item) => ({
        catalogId: item.policy.agents![0]!.catalogId,
        agentId: item.policy.agentId,
        gateway: item.gateway!,
        agentBridge: item.agentBridge!,
      }))
      : undefined;
    return { gateway: primary.gateway, agentBridge: primary.agentBridge, agentGrants };
  }

  private async revokeAgentGrants(workspaceId: string, policy: RuntimePolicy) {
    await Promise.all(this.agentPolicies(policy).map((agentPolicy) => (
      this.gateway?.revoke(workspaceId, agentPolicy.agentId)
    )));
  }

  private async revokeAgentGrantsReliably(workspaceId: string, policy: RuntimePolicy) {
    const delays = [75, 225];
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.revokeAgentGrants(workspaceId, policy);
        return;
      } catch (error) {
        const retryable = error instanceof LemmaComputerError && error.retryable;
        if (!retryable || attempt >= delays.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  private async view(record: WorkspaceRecord, policy: RuntimePolicy, enforced?: VerifiedPolicyBundle, projected?: PolicyIntegrityView) {
    const integrity = this.integrityFor(policy, enforced, projected);
    const compatibility = integrity?.state === "drift"
      ? { state: "restart_required" as const, reasonCode: integrity.reasonCode }
      : ["not_created", "stopped"].includes(record.state)
        ? { state: "applies_on_next_start" as const, reasonCode: null }
        : { state: "current" as const, reasonCode: null };
    if (!hasAiAgents(policy) || !this.gateway || !["ready", "open"].includes(record.state)) return toView(record, undefined, policy, integrity, compatibility);
    // Workspace and agent lifecycle views must not wait for optional connector
    // discovery. Connector health is queried on its own product surface.
    const gateway = await this.gateway.readiness(
      record.id,
      policy.agentId,
      policy,
      record.accessGeneration,
      { includeTools: false },
    ).catch(() => undefined);
    return toView(record, gateway, policy, integrity, compatibility);
  }

  async suspendForPolicyChange(
    identity: IdentityContext,
    workspaceId: string,
    options: { restartPending?: boolean } = {},
  ) {
    const record = await this.owned(identity, workspaceId);
    if (["not_created", "stopped"].includes(record.state)) {
      await this.gateway?.revokeWorkspace(record.id, record.accessGeneration);
      return { stopped: false, workspace: record };
    }
    const claimed = await this.store.claim(
      record.id,
      ["ready", "open", "provisioning", "restarting", "failed"],
      "stopping",
    );
    if (!claimed) throw new LemmaComputerError("WORKSPACE_BUSY", "The workspace must finish its current operation before guardrails can change", 409, true);
    const previousGeneration = claimed.accessGeneration;
    let providerDestroyed = !claimed.providerId;
    try {
      await this.store.revokeAccessGrants(claimed.id);
      if (claimed.providerId) {
        await this.controller.destroyWorkspace(claimed.id, claimed.providerId);
        providerDestroyed = true;
      }
      await this.gateway?.revokeWorkspace(claimed.id, previousGeneration);
      const stopped = await this.store.finish(claimed.id, claimed.operationToken!, {
        state: "stopped",
        providerId: null,
        failureCode: options.restartPending ? "WORKSPACE_POLICY_RESTART_PENDING" : null,
      });
      return { stopped: true, workspace: stopped };
    } catch (error) {
      await this.store.finish(claimed.id, claimed.operationToken!, {
        state: "failed",
        providerId: providerDestroyed ? null : claimed.providerId,
        failureCode: "POLICY_TRANSITION_CLEANUP_FAILED",
      });
      throw error;
    }
  }

  async current(identity: IdentityContext, policy: RuntimePolicy, grantId = "personal") {
    let record = await this.store.getCurrent(identity, grantId);
    if (!record) return null;
    let projectedIntegrity: PolicyIntegrityView | undefined;
    let projectedEgressPolicy: Sandbox["egressPolicyProjection"];
    if (record.providerId && ["provisioning", "ready", "open", "restarting", "stopping"].includes(record.state)) {
      const sandbox = await this.controller.status(record.id, record.providerId);
      projectedIntegrity = sandbox.policyIntegrity;
      projectedEgressPolicy = sandbox.egressPolicyProjection;
      const state = sandbox.state === "ready" && record.state === "open" ? "open" : sandbox.state === "ready" ? "ready" : sandbox.state;
      const failureCode = sandbox.failureCode ?? null;
      const providerStopped = sandbox.state === "stopped" && record.providerId !== null;
      if (record.state !== state || record.failureCode !== failureCode || providerStopped) {
        record = await this.store.update(record.id, {
          state,
          ...(providerStopped ? { providerId: null } : {}),
          failureCode,
        });
      }
    }
    const projectedPolicy = projectedIntegrity?.projected;
    if (
      record.providerId
      && ["ready", "open"].includes(record.state)
      && projectedPolicy
      && (
        projectedPolicy.version !== policy.policyVersion
        || projectedPolicy.digest !== policy.policyHash
      )
    ) {
      let transition: Awaited<ReturnType<WorkspaceService["suspendForPolicyChange"]>>;
      try {
        transition = await this.suspendForPolicyChange(identity, record.id);
      } catch {
        const failed = await this.store.getOwned(identity, record.id) ?? record;
        return toView(
          failed,
          undefined,
          policy,
          this.integrityFor(policy, undefined, projectedIntegrity),
          { state: "action_required", reasonCode: "POLICY_TRANSITION_CLEANUP_FAILED" },
        );
      }
      return toView(
        transition.workspace,
        undefined,
        policy,
        this.integrityFor(policy, undefined, projectedIntegrity),
        { state: "restart_required", reasonCode: "WORKSPACE_POLICY_VERSION_CHANGED" },
      );
    }
    if (
      record.providerId
      && ["ready", "open"].includes(record.state)
      && policy.egress
      && projectedPolicy
      && (
        projectedPolicy.version !== policy.policyVersion
        || projectedPolicy.digest !== policy.policyHash
        || projectedEgressPolicy?.securityGroupVersionId !== policy.egress.id
        || projectedEgressPolicy?.documentHash !== policy.egress.documentHash
      )
    ) {
      const refreshed = await this.refreshEgressPolicy(identity, policy, grantId).catch(() => false);
      if (refreshed) {
        projectedIntegrity = (await this.controller.status(record.id, record.providerId)).policyIntegrity;
      }
    }
    const authorized = this.authorizePolicy(identity, record, policy);
    if (hasAiAgents(policy) && this.gateway && ["ready", "open"].includes(record.state)) {
      if (!this.policyBundleAuthority || authorized) {
        await this.ensureAgentGrants(identity, record, authorized?.payload.policy ?? policy).catch(() => undefined);
      }
    }
    return this.view(record, policy, authorized, projectedIntegrity);
  }

  async list(identity: IdentityContext, policyForGrant: (grantId: string) => Promise<RuntimePolicy>) {
    const records = await this.store.listCurrent(identity);
    const views = await Promise.all(records.map(async (record) => {
      try {
        return await this.current(identity, await policyForGrant(record.grantId), record.grantId);
      } catch (error) {
        if (!(error instanceof LemmaComputerError) || ![
          "AGENT_NOT_ASSIGNED",
          "APPLICATION_NOT_ASSIGNED",
          "MODEL_NOT_ASSIGNED",
          "PROFILE_NOT_ASSIGNED",
          "SERVICE_CLASS_NOT_ASSIGNED",
          "WORKSPACE_POLICY_SELECTION_REQUIRED",
        ].includes(error.code)) throw error;
        await this.suspendForPolicyChange(identity, record.id).catch(() => undefined);
        const latest = await this.store.getOwned(identity, record.id) ?? record;
        return toView(latest, undefined, undefined, undefined, {
          state: "action_required",
          reasonCode: error.code,
        });
      }
    }));
    return views.filter((view): view is NonNullable<typeof view> => Boolean(view));
  }

  async refreshPolicyGrant(identity: IdentityContext, policy: RuntimePolicy, grantId = "personal") {
    const record = await this.store.getCurrent(identity, grantId);
    if (!hasAiAgents(policy) || !record || !this.gateway || !["ready", "open"].includes(record.state)) return false;
    const authorized = this.authorizePolicy(identity, record, policy);
    const verifiedPolicy = authorized?.payload.policy ?? policy;
    await Promise.all(this.agentPolicies(verifiedPolicy).map((agentPolicy) => this.gateway!.ensureGrant({
      workspaceId: record.id,
      accessGeneration: record.accessGeneration,
      identity,
      agentId: agentPolicy.agentId,
      policy: agentPolicy,
    })));
    return true;
  }

  async revokeGatewayGrants(workspaceId: string, policy: RuntimePolicy) {
    await this.revokeAgentGrants(workspaceId, policy);
  }

  async refreshEgressPolicy(identity: IdentityContext, policy: RuntimePolicy, grantId = "personal") {
    const record = await this.store.getCurrent(identity, grantId);
    if (!record?.providerId || !["ready", "open"].includes(record.state)) return false;
    const authorized = this.authorizePolicy(identity, record, policy);
    if (!authorized || !this.egressProxyAuthority || !policy.egress) return false;
    const verifiedPolicy = authorized.payload.policy;
    const egressProxy = this.egressProxyAuthority.issue(identity, record, verifiedPolicy);
    if (!egressProxy) return false;
    await this.controller.updateEgressPolicy(record.providerId, {
      workspaceId: record.id,
      policy: verifiedPolicy,
      policyBundle: authorized.bundle,
      egressProxy,
    });
    return true;
  }

  async revokePolicyGrant(workspaceId: string, policy: RuntimePolicy) {
    await this.store.revokeAccessGrants(workspaceId);
    await this.revokeGatewayGrants(workspaceId, policy);
  }

  async create(identity: IdentityContext, policy: RuntimePolicy, grantId: string, idempotencyKey: string, correlationId: string) {
    let record = await this.store.createOrGet(identity, grantId, idempotencyKey);
    if (["ready", "open", "provisioning", "restarting"].includes(record.state)) return this.view(record, policy);
    const claimed = await this.store.claim(record.id, ["not_created", "stopped", "failed"], "provisioning");
    if (!claimed) return this.view((await this.store.getOwned(identity, record.id))!, policy);
    try {
      const authorized = this.authorizePolicy(identity, claimed, policy);
      const verifiedPolicy = authorized?.payload.policy ?? policy;
      const grants = await this.ensureAgentGrants(identity, claimed, verifiedPolicy);
      const egressProxy = this.egressProxyAuthority?.issue(identity, claimed, verifiedPolicy);
      const chatRuntimes = this.agentChatAuthority?.list(identity, claimed, verifiedPolicy)
        .map(({ catalogId, key }) => ({ catalogId, key }));
      if (verifiedPolicy.egress && !egressProxy) throw new LemmaComputerError("EGRESS_PROXY_NOT_CONFIGURED", "The assigned egress firewall cannot be provisioned", 503);
      const sandbox = await this.controller.create({
        workspaceId: claimed.id,
        accessGeneration: claimed.accessGeneration,
        correlationId,
        policy: verifiedPolicy,
        ...(authorized ? { policyBundle: authorized.bundle } : {}),
        ...grants,
        ...(chatRuntimes?.length ? { chatRuntimes } : {}),
        egressProxy,
      });
      record = await this.store.finish(claimed.id, claimed.operationToken!, { state: sandbox.state === "ready" ? "ready" : "provisioning", providerId: sandbox.providerId, failureCode: sandbox.failureCode });
      return this.view(record, policy, authorized, sandbox.policyIntegrity);
    } catch (error) {
      await this.revokePolicyGrant(claimed.id, policy).catch(() => undefined);
      await this.store.finish(claimed.id, claimed.operationToken!, { state: "failed", failureCode: error instanceof LemmaComputerError ? error.code : "PROVISION_FAILED" });
      throw error;
    }
  }

  async open(identity: IdentityContext, policy: RuntimePolicy, workspaceId: string) {
    const record = await this.owned(identity, workspaceId);
    if (!record.providerId || !["ready", "open"].includes(record.state)) throw new LemmaComputerError("WORKSPACE_NOT_READY", "The workspace is not ready to open", 409, true);
    const authorized = this.authorizePolicy(identity, record, policy);
    await this.ensureAgentGrants(identity, record, authorized?.payload.policy ?? policy);
    const controllerLaunch = await this.controller.open(record.id, record.providerId);
    const launch = this.publicLaunch(identity, record, controllerLaunch);
    const updated = await this.store.update(record.id, { state: "open", failureCode: null });
    return { workspace: await this.view(updated, policy, authorized), launch };
  }

  private publicLaunch(identity: IdentityContext, record: WorkspaceRecord, launch: ControllerLaunch): Launch {
    const workspaceId = record.id;
    const { ingressTarget, ...publicLaunch } = launch;
    if (!ingressTarget || !this.workspaceIngress) return publicLaunch;
    const issued = this.workspaceIngress.authority.issueLaunch({
      identity,
      workspaceId,
      accessGeneration: record.accessGeneration,
      target: ingressTarget,
    });
    const controllerUrl = new URL(launch.launchUrl);
    const ingressUrl = new URL(`/workspaces/${workspaceId}/`, this.workspaceIngress.publicUrl);
    for (const [name, value] of controllerUrl.searchParams) ingressUrl.searchParams.append(name, value);
    // KasmVNC otherwise opens its WebSocket at the origin-level /websockify
    // path, which would bypass the workspace-scoped ingress route.
    ingressUrl.searchParams.set("path", `workspaces/${workspaceId}/websockify`);
    ingressUrl.searchParams.set(workspaceIngressAccessParameter, issued.token);
    return {
      ...publicLaunch,
      launchUrl: ingressUrl.toString(),
      expiresAt: issued.expiresAt,
    };
  }

  async restart(identity: IdentityContext, policy: RuntimePolicy, workspaceId: string, correlationId: string) {
    const record = await this.owned(identity, workspaceId);
    const claimed = await this.store.claim(record.id, ["ready", "open", "stopped", "failed"], "restarting");
    if (!claimed) throw new LemmaComputerError("WORKSPACE_BUSY", "A workspace operation is already running", 409, true);
    try {
      const accessRecord = await this.store.revokeAccessGrants(claimed.id);
      if (claimed.providerId) await this.controller.destroyWorkspace(claimed.id, claimed.providerId);
      const authorized = this.authorizePolicy(identity, accessRecord, policy);
      const verifiedPolicy = authorized?.payload.policy ?? policy;
      const grants = await this.ensureAgentGrants(identity, accessRecord, verifiedPolicy);
      const egressProxy = this.egressProxyAuthority?.issue(identity, accessRecord, verifiedPolicy);
      const chatRuntimes = this.agentChatAuthority?.list(identity, accessRecord, verifiedPolicy)
        .map(({ catalogId, key }) => ({ catalogId, key }));
      if (verifiedPolicy.egress && !egressProxy) throw new LemmaComputerError("EGRESS_PROXY_NOT_CONFIGURED", "The assigned egress firewall cannot be provisioned", 503);
      const sandbox = await this.controller.create({
        workspaceId: claimed.id,
        accessGeneration: accessRecord.accessGeneration,
        correlationId,
        policy: verifiedPolicy,
        ...(authorized ? { policyBundle: authorized.bundle } : {}),
        ...grants,
        ...(chatRuntimes?.length ? { chatRuntimes } : {}),
        egressProxy,
      });
      return this.view(
        await this.store.finish(claimed.id, claimed.operationToken!, { state: sandbox.state === "ready" ? "ready" : "restarting", providerId: sandbox.providerId, failureCode: sandbox.failureCode }),
        policy,
        authorized,
        sandbox.policyIntegrity,
      );
    } catch (error) {
      await this.revokePolicyGrant(claimed.id, policy).catch(() => undefined);
      await this.store.finish(claimed.id, claimed.operationToken!, { state: "failed", providerId: null, failureCode: error instanceof LemmaComputerError ? error.code : "RESTART_FAILED" });
      throw error;
    }
  }

  async stop(identity: IdentityContext, policy: RuntimePolicy, workspaceId: string) {
    const record = await this.owned(identity, workspaceId);
    const cleanupPending = record.state === "stopped" && record.failureCode === "WORKSPACE_ACCESS_CLEANUP_FAILED";
    if (record.state === "stopped" && !cleanupPending) return toView(record, undefined, policy);
    const allowed = cleanupPending
      ? ["stopped" as const]
      : ["ready" as const, "open" as const, "provisioning" as const, "restarting" as const, "failed" as const];
    const claimed = await this.store.claim(record.id, allowed, "stopping");
    if (!claimed) throw new LemmaComputerError("WORKSPACE_BUSY", "A workspace operation is already running", 409, true);
    await this.store.revokeAccessGrants(claimed.id);
    try {
      if (claimed.providerId) await this.controller.destroyWorkspace(claimed.id, claimed.providerId);
    } catch (error) {
      await this.store.finish(claimed.id, claimed.operationToken!, {
        state: "failed",
        providerId: claimed.providerId,
        failureCode: error instanceof LemmaComputerError ? error.code : "WORKSPACE_STOP_FAILED",
      });
      throw error;
    }
    try {
      await this.revokeAgentGrantsReliably(claimed.id, policy);
    } catch (error) {
      await this.store.finish(claimed.id, claimed.operationToken!, {
        state: "stopped",
        providerId: null,
        failureCode: "WORKSPACE_ACCESS_CLEANUP_FAILED",
      });
      const retryable = error instanceof LemmaComputerError ? error.retryable : true;
      throw new LemmaComputerError(
        "WORKSPACE_ACCESS_CLEANUP_FAILED",
        retryable
          ? "The workspace stopped, but access cleanup could not be confirmed. LemmaComputer will retry safely."
          : "The workspace stopped, but its access cleanup was rejected and needs administrator attention.",
        503,
        retryable,
      );
    }
    return toView(await this.store.finish(claimed.id, claimed.operationToken!, { state: "stopped", providerId: null, failureCode: null }), undefined, policy);
  }

  async terminateRuntime(identity: IdentityContext, policy: RuntimePolicy, workspaceId: string) {
    await this.stop(identity, policy, workspaceId);
    const record = await this.store.revokeAccessGrants(workspaceId);
    try {
      await this.revokeAgentGrantsReliably(workspaceId, policy);
    } catch (error) {
      await this.store.update(workspaceId, { state: "stopped", providerId: null, failureCode: "WORKSPACE_ACCESS_CLEANUP_FAILED" });
      throw error;
    }
    return toView(record, undefined, policy);
  }

  async deletionImpact(identity: IdentityContext, workspaceId: string): Promise<WorkspaceDeletionImpact> {
    await this.owned(identity, workspaceId);
    const impact = await this.store.getDeletionImpact(identity, workspaceId);
    if (!impact) throw new LemmaComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    return impact;
  }

  async delete(identity: IdentityContext, policy: RuntimePolicy, workspaceId: string, contentDisposition: WorkspaceContentDisposition = "preserve") {
    const record = await this.owned(identity, workspaceId);
    await this.store.revokeAccessGrants(record.id);
    if (record.providerId) await this.controller.destroyWorkspace(record.id, record.providerId);
    await this.controller.purgeWorkspace(record.id, record.accessGeneration);
    await this.revokeAgentGrantsReliably(record.id, policy);
    if (!await this.store.tombstone(identity, record.id, contentDisposition)) {
      throw new LemmaComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    }
  }

  async testGateway(identity: IdentityContext, policy: RuntimePolicy, workspaceId: string) {
    const record = await this.owned(identity, workspaceId);
    if (!["ready", "open"].includes(record.state)) throw new LemmaComputerError("WORKSPACE_NOT_READY", "The workspace is not ready", 409, true);
    if (!hasAiAgents(policy)) throw new LemmaComputerError("WORKSPACE_AI_NOT_SELECTED", "This workspace has no AI agents selected", 409);
    if (!this.gateway) throw new LemmaComputerError("GATEWAY_NOT_CONFIGURED", "The model gateway is not configured", 503, true);
    const authorized = this.authorizePolicy(identity, record, policy);
    const verifiedPolicy = authorized?.payload.policy ?? policy;
    await this.ensureAgentGrants(identity, record, verifiedPolicy);
    return this.gateway.test(record.id, verifiedPolicy.agentId, verifiedPolicy, record.accessGeneration);
  }

  async agentChatAgents(identity: IdentityContext, policy: RuntimePolicy, workspaceId: string) {
    const record = await this.owned(identity, workspaceId);
    if (!this.agentChatAuthority) {
      throw new LemmaComputerError("CHAT_NOT_CONFIGURED", "Sandbox Chat is not configured", 503, true);
    }
    return {
      state: record.state,
      failureCode: record.failureCode,
      accesses: this.agentChatAuthority.list(identity, record, policy),
    };
  }

  async agentChatAccess(
    identity: IdentityContext,
    policy: RuntimePolicy,
    workspaceId: string,
    catalogId: ChatAgentCatalogId,
  ): Promise<AgentChatAccess> {
    const { state, failureCode, accesses } = await this.agentChatAgents(identity, policy, workspaceId);
    const access = accesses.find((candidate) => candidate.catalogId === catalogId);
    if (!access) throw new LemmaComputerError("CHAT_AGENT_NOT_SELECTED", "That chat agent is not selected for this workspace", 409);
    if (!["ready", "open"].includes(state)) {
      if (
        ["provisioning", "restarting", "stopping"].includes(state)
        || failureCode === "WORKSPACE_POLICY_RESTART_PENDING"
      ) {
        throw new LemmaComputerError(
          "WORKSPACE_POLICY_TRANSITION_IN_PROGRESS",
          "The workspace is applying updated guardrails. Try again shortly.",
          409,
          true,
        );
      }
      throw new LemmaComputerError("WORKSPACE_NOT_READY", "Start this sandbox to use Chat", 409, true);
    }
    return access;
  }

  private async owned(identity: IdentityContext, workspaceId: string) {
    const record = await this.store.getOwned(identity, workspaceId);
    if (!record) throw new LemmaComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    return record;
  }
}
