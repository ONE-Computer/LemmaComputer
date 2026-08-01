import {
  OneComputerError,
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
  type WorkspaceView,
} from "@onecomputer/contracts";
import { deriveEgressProxySecret, issueEgressProxyGrant } from "@onecomputer/egress-policy";
import type { GatewayClient, GatewayGrant, GatewayReadiness } from "@onecomputer/litellm-adapter";
import { PolicyBundleSigner, PolicyVerificationError, verifySignedPolicyBundle, type VerifiedPolicyBundle } from "@onecomputer/policy-integrity";
import {
  WorkspaceIngressAuthority,
  workspaceIngressAccessParameter,
} from "@onecomputer/workspace-ingress-auth";
import type { WorkspaceRecord, WorkspaceStore } from "@onecomputer/workspace-store";
import { AgentChatAuthority, type AgentChatAccess } from "./agent-chat.js";

export type ControllerLaunch = Launch & {
  ingressTarget?: {
    protocol: "http" | "https";
    host: string;
    port: number;
  };
};

export type ControllerVcrSource = "browser" | "document" | "desktop";
export type ControllerVcrCapture = {
  sourceApplication: ControllerVcrSource;
  mimeType: "image/png";
  imageBase64: string;
};

export interface ControllerClient {
  create(input: {
    workspaceId: string;
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
  status(providerId: string): Promise<Sandbox>;
  open(providerId: string): Promise<ControllerLaunch>;
  captureFrame?(providerId: string, sourceApplication: ControllerVcrSource): Promise<ControllerVcrCapture>;
  destroy(providerId: string): Promise<void>;
  purgeWorkspace(workspaceId: string): Promise<void>;
}

export type EgressProxyGrant = {
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

export class EgressProxyGrantAuthority {
  constructor(private readonly rootSecret: string) {}

  issue(identity: IdentityContext, workspaceId: string, policy: RuntimePolicy): EgressProxyGrant | undefined {
    if (!policy.egress) return undefined;
    const verificationSecret = deriveEgressProxySecret(this.rootSecret, workspaceId);
    const expectedGrant = {
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      workspaceId,
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

  authorize(identity: IdentityContext, workspaceId: string, policy: RuntimePolicy, now = new Date()) {
    try {
      const normalizedPolicy = runtimePolicySchema.parse(policy);
      const bundle = this.signer.issue({
        identity,
        workspaceId,
        policy: normalizedPolicy,
        routes: this.routes,
        ttlSeconds: this.ttlSeconds,
        now,
      });
      return verifySignedPolicyBundle(bundle, this.verificationKeys, {
        identity,
        workspaceId,
        policy: normalizedPolicy,
        minimumPolicyVersion: normalizedPolicy.policyVersion,
        now,
      });
    } catch (error) {
      if (error instanceof PolicyVerificationError) {
        throw new OneComputerError(error.code, error.message, 503);
      }
      throw error;
    }
  }
}

export class HttpControllerClient implements ControllerClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}
  private async call(path: string, init?: RequestInit) {
    const hasBody = init?.body !== undefined;
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...(hasBody ? { "content-type": "application/json" } : {}), "x-controller-token": this.token, ...init?.headers },
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string; retryable?: boolean } };
      throw new OneComputerError(payload.error?.code ?? "CONTROLLER_ERROR", payload.error?.message ?? "Workspace controller request failed", response.status, payload.error?.retryable ?? response.status >= 500);
    }
    return response.status === 204 ? {} : response.json();
  }
  async create(input: Parameters<ControllerClient["create"]>[0]) {
    return await this.call("/internal/v1/sandboxes", { method: "POST", body: JSON.stringify(input) }) as Sandbox;
  }
  async updateEgressPolicy(providerId: string, input: Parameters<ControllerClient["updateEgressPolicy"]>[1]) {
    await this.call(`/internal/v1/sandboxes/${encodeURIComponent(providerId)}/egress-policy`, { method: "PUT", body: JSON.stringify(input) });
  }
  async status(providerId: string) { return await this.call(`/internal/v1/sandboxes/${encodeURIComponent(providerId)}`) as Sandbox; }
  async open(providerId: string) { return await this.call(`/internal/v1/sandboxes/${encodeURIComponent(providerId)}/open`, { method: "POST" }) as Launch; }
  async captureFrame(providerId: string, sourceApplication: ControllerVcrSource) {
    return (await this.call(`/internal/v1/sandboxes/${encodeURIComponent(providerId)}/vcr/frames`, { method: "POST", body: JSON.stringify({ sourceApplication }) })) as ControllerVcrCapture;
  }
  async destroy(providerId: string) { await this.call(`/internal/v1/sandboxes/${encodeURIComponent(providerId)}`, { method: "DELETE" }); }
  async purgeWorkspace(workspaceId: string) { await this.call(`/internal/v1/workspaces/${encodeURIComponent(workspaceId)}/storage`, { method: "DELETE" }); }
}

const profileClient = (profileId: RuntimePolicy["workspaceProfile"]) => profileId === "claude-desktop-standard-v1"
  ? { client: "ONEComputer managed workspace", clientVersion: "managed-v1" }
  : profileId === "disposable-open-v1"
    ? { client: "ONEComputer open workspace", clientVersion: "disposable-open-v1" }
    : { client: "ONEComputer qualification CLI", clientVersion: "issue-006" };

export const toView = (
  record: WorkspaceRecord,
  gateway?: GatewayReadiness,
  policy?: RuntimePolicy,
  policyIntegrity?: PolicyIntegrityView,
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
            ? gateway?.models === "failed" || gateway?.tools === "failed" ? "degraded" as const : "ready" as const
            : "selected" as const,
    })),
  } : {}),
  ...(policy ? { policyAssignment: {
    version: policy.policyVersion,
    hash: policy.policyHash,
  } } : {}),
  ...(policy ? { profile: {
    id: policy.workspaceProfile,
    ...profileClient(policy.workspaceProfile),
    modelAlias: policy.modelAlias,
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
    private readonly agentBridge?: { baseUrl: string; issue: (identity: IdentityContext, workspaceId: string, policy: RuntimePolicy) => string },
    private readonly egressProxyAuthority?: EgressProxyGrantAuthority,
    private readonly policyBundleAuthority?: PolicyBundleAuthority,
    private readonly agentChatAuthority?: AgentChatAuthority,
    private readonly workspaceIngress?: {
      publicUrl: string;
      authority: WorkspaceIngressAuthority;
    },
  ) {}

  private authorizePolicy(identity: IdentityContext, workspaceId: string, policy: RuntimePolicy) {
    return this.policyBundleAuthority?.authorize(identity, workspaceId, policy);
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

  private bridgeGrant(identity: IdentityContext, workspaceId: string, policy: RuntimePolicy) {
    return this.agentBridge ? { baseUrl: this.agentBridge.baseUrl, token: this.agentBridge.issue(identity, workspaceId, policy) } : undefined;
  }

  private agentPolicies(policy: RuntimePolicy): RuntimePolicy[] {
    if (!policy.agents?.length) return [policy];
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

  private async ensureAgentGrants(identity: IdentityContext, workspaceId: string, policy: RuntimePolicy) {
    const policies = this.agentPolicies(policy);
    const resolved = await Promise.all(policies.map(async (agentPolicy) => ({
      policy: agentPolicy,
      gateway: await this.gateway?.ensureGrant({
        workspaceId,
        identity,
        agentId: agentPolicy.agentId,
        policy: agentPolicy,
      }),
      agentBridge: this.bridgeGrant(identity, workspaceId, agentPolicy),
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
        const retryable = error instanceof OneComputerError && error.retryable;
        if (!retryable || attempt >= delays.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  private async view(record: WorkspaceRecord, policy: RuntimePolicy, enforced?: VerifiedPolicyBundle, projected?: PolicyIntegrityView) {
    const integrity = this.integrityFor(policy, enforced, projected);
    if (!this.gateway || !["ready", "open"].includes(record.state)) return toView(record, undefined, policy, integrity);
    const gateway = await this.gateway.readiness(record.id, policy.agentId, policy).catch(() => undefined);
    return toView(record, gateway, policy, integrity);
  }

  async current(identity: IdentityContext, policy: RuntimePolicy, grantId = "personal") {
    let record = await this.store.getCurrent(identity, grantId);
    if (!record) return null;
    let projectedIntegrity: PolicyIntegrityView | undefined;
    let projectedEgressPolicy: Sandbox["egressPolicyProjection"];
    if (record.providerId && ["provisioning", "ready", "open", "restarting", "stopping"].includes(record.state)) {
      const sandbox = await this.controller.status(record.providerId);
      projectedIntegrity = sandbox.policyIntegrity;
      projectedEgressPolicy = sandbox.egressPolicyProjection;
      record = await this.store.update(record.id, {
        state: sandbox.state === "ready" && record.state === "open" ? "open" : sandbox.state === "ready" ? "ready" : sandbox.state,
        ...(sandbox.state === "stopped" ? { providerId: null } : {}),
        failureCode: sandbox.failureCode,
      });
    }
    const projectedPolicy = projectedIntegrity?.projected;
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
        projectedIntegrity = (await this.controller.status(record.providerId)).policyIntegrity;
      }
    }
    const authorized = this.authorizePolicy(identity, record.id, policy);
    if (this.gateway && ["ready", "open"].includes(record.state)) {
      if (!this.policyBundleAuthority || authorized) {
        await this.ensureAgentGrants(identity, record.id, authorized?.payload.policy ?? policy).catch(() => undefined);
      }
    }
    return this.view(record, policy, authorized, projectedIntegrity);
  }

  async list(identity: IdentityContext, policyForGrant: (grantId: string) => Promise<RuntimePolicy>) {
    const records = await this.store.listCurrent(identity);
    const views = await Promise.all(records.map(async (record) => this.current(identity, await policyForGrant(record.grantId), record.grantId)));
    return views.filter((view): view is NonNullable<typeof view> => Boolean(view));
  }

  async refreshPolicyGrant(identity: IdentityContext, policy: RuntimePolicy, grantId = "personal") {
    const record = await this.store.getCurrent(identity, grantId);
    if (!record || !this.gateway || !["ready", "open"].includes(record.state)) return false;
    const authorized = this.authorizePolicy(identity, record.id, policy);
    await this.ensureAgentGrants(identity, record.id, authorized?.payload.policy ?? policy);
    return true;
  }

  async refreshEgressPolicy(identity: IdentityContext, policy: RuntimePolicy, grantId = "personal") {
    const record = await this.store.getCurrent(identity, grantId);
    if (!record?.providerId || !["ready", "open"].includes(record.state)) return false;
    const authorized = this.authorizePolicy(identity, record.id, policy);
    if (!authorized || !this.egressProxyAuthority || !policy.egress) return false;
    const verifiedPolicy = authorized.payload.policy;
    const egressProxy = this.egressProxyAuthority.issue(identity, record.id, verifiedPolicy);
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
    await this.revokeAgentGrants(workspaceId, policy);
  }

  async create(identity: IdentityContext, policy: RuntimePolicy, grantId: string, idempotencyKey: string, correlationId: string) {
    let record = await this.store.createOrGet(identity, grantId, idempotencyKey);
    if (["ready", "open", "provisioning", "restarting"].includes(record.state)) return this.view(record, policy);
    const claimed = await this.store.claim(record.id, ["not_created", "stopped", "failed"], "provisioning");
    if (!claimed) return this.view((await this.store.getOwned(identity, record.id))!, policy);
    try {
      const authorized = this.authorizePolicy(identity, claimed.id, policy);
      const verifiedPolicy = authorized?.payload.policy ?? policy;
      const grants = await this.ensureAgentGrants(identity, claimed.id, verifiedPolicy);
      const egressProxy = this.egressProxyAuthority?.issue(identity, claimed.id, verifiedPolicy);
      const chatRuntimes = this.agentChatAuthority?.list(identity, claimed.id, verifiedPolicy)
        .map(({ catalogId, key }) => ({ catalogId, key }));
      if (verifiedPolicy.egress && !egressProxy) throw new OneComputerError("EGRESS_PROXY_NOT_CONFIGURED", "The assigned egress firewall cannot be provisioned", 503);
      const sandbox = await this.controller.create({
        workspaceId: claimed.id,
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
      await this.revokeAgentGrants(claimed.id, policy).catch(() => undefined);
      await this.store.finish(claimed.id, claimed.operationToken!, { state: "failed", failureCode: error instanceof OneComputerError ? error.code : "PROVISION_FAILED" });
      throw error;
    }
  }

  async open(identity: IdentityContext, policy: RuntimePolicy, workspaceId: string) {
    const record = await this.owned(identity, workspaceId);
    if (!record.providerId || !["ready", "open"].includes(record.state)) throw new OneComputerError("WORKSPACE_NOT_READY", "The workspace is not ready to open", 409, true);
    const authorized = this.authorizePolicy(identity, record.id, policy);
    await this.ensureAgentGrants(identity, record.id, authorized?.payload.policy ?? policy);
    const controllerLaunch = await this.controller.open(record.providerId);
    const launch = this.publicLaunch(identity, record.id, controllerLaunch);
    const updated = await this.store.update(record.id, { state: "open", failureCode: null });
    return { workspace: await this.view(updated, policy, authorized), launch };
  }

  private publicLaunch(identity: IdentityContext, workspaceId: string, launch: ControllerLaunch): Launch {
    const { ingressTarget, ...publicLaunch } = launch;
    if (!ingressTarget || !this.workspaceIngress) return publicLaunch;
    const issued = this.workspaceIngress.authority.issueLaunch({
      identity,
      workspaceId,
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
    if (!claimed) throw new OneComputerError("WORKSPACE_BUSY", "A workspace operation is already running", 409, true);
    try {
      if (claimed.providerId) await this.controller.destroy(claimed.providerId);
      const authorized = this.authorizePolicy(identity, claimed.id, policy);
      const verifiedPolicy = authorized?.payload.policy ?? policy;
      const grants = await this.ensureAgentGrants(identity, claimed.id, verifiedPolicy);
      const egressProxy = this.egressProxyAuthority?.issue(identity, claimed.id, verifiedPolicy);
      const chatRuntimes = this.agentChatAuthority?.list(identity, claimed.id, verifiedPolicy)
        .map(({ catalogId, key }) => ({ catalogId, key }));
      if (verifiedPolicy.egress && !egressProxy) throw new OneComputerError("EGRESS_PROXY_NOT_CONFIGURED", "The assigned egress firewall cannot be provisioned", 503);
      const sandbox = await this.controller.create({
        workspaceId: claimed.id,
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
      await this.revokeAgentGrants(claimed.id, policy).catch(() => undefined);
      await this.store.finish(claimed.id, claimed.operationToken!, { state: "failed", providerId: null, failureCode: error instanceof OneComputerError ? error.code : "RESTART_FAILED" });
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
    if (!claimed) throw new OneComputerError("WORKSPACE_BUSY", "A workspace operation is already running", 409, true);
    try {
      if (claimed.providerId) await this.controller.destroy(claimed.providerId);
    } catch (error) {
      await this.store.finish(claimed.id, claimed.operationToken!, {
        state: "failed",
        providerId: claimed.providerId,
        failureCode: error instanceof OneComputerError ? error.code : "WORKSPACE_STOP_FAILED",
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
      const retryable = error instanceof OneComputerError ? error.retryable : true;
      throw new OneComputerError(
        "WORKSPACE_ACCESS_CLEANUP_FAILED",
        retryable
          ? "The workspace stopped, but access cleanup could not be confirmed. ONEComputer will retry safely."
          : "The workspace stopped, but its access cleanup was rejected and needs administrator attention.",
        503,
        retryable,
      );
    }
    return toView(await this.store.finish(claimed.id, claimed.operationToken!, { state: "stopped", providerId: null, failureCode: null }), undefined, policy);
  }

  async delete(identity: IdentityContext, policy: RuntimePolicy, workspaceId: string) {
    const record = await this.owned(identity, workspaceId);
    if (record.providerId) await this.controller.destroy(record.providerId);
    await this.controller.purgeWorkspace(record.id);
    await this.revokeAgentGrants(record.id, policy);
    await this.store.remove(identity, record.id);
  }

  async testGateway(identity: IdentityContext, policy: RuntimePolicy, workspaceId: string) {
    const record = await this.owned(identity, workspaceId);
    if (!["ready", "open"].includes(record.state)) throw new OneComputerError("WORKSPACE_NOT_READY", "The workspace is not ready", 409, true);
    if (!this.gateway) throw new OneComputerError("GATEWAY_NOT_CONFIGURED", "The model gateway is not configured", 503, true);
    const authorized = this.authorizePolicy(identity, record.id, policy);
    const verifiedPolicy = authorized?.payload.policy ?? policy;
    await this.ensureAgentGrants(identity, record.id, verifiedPolicy);
    return this.gateway.test(record.id, verifiedPolicy.agentId, verifiedPolicy);
  }

  async agentChatAgents(identity: IdentityContext, policy: RuntimePolicy, workspaceId: string) {
    const record = await this.owned(identity, workspaceId);
    if (!this.agentChatAuthority) {
      throw new OneComputerError("CHAT_NOT_CONFIGURED", "Sandbox Chat is not configured", 503, true);
    }
    const endpoints = record.providerId
      ? new Map((await this.controller.status(record.providerId)).chatEndpoints?.map((endpoint) => [endpoint.catalogId, endpoint.url]) ?? [])
      : new Map();
    return {
      state: record.state,
      accesses: this.agentChatAuthority.list(identity, record.id, policy).map((access) => ({
        ...access,
        ...(endpoints.get(access.catalogId) ? { baseUrl: endpoints.get(access.catalogId)! } : {}),
      })),
    };
  }

  async agentChatAccess(
    identity: IdentityContext,
    policy: RuntimePolicy,
    workspaceId: string,
    catalogId: ChatAgentCatalogId,
  ): Promise<AgentChatAccess> {
    const { state, accesses } = await this.agentChatAgents(identity, policy, workspaceId);
    const access = accesses.find((candidate) => candidate.catalogId === catalogId);
    if (!access) throw new OneComputerError("CHAT_AGENT_NOT_SELECTED", "That chat agent is not selected for this workspace", 409);
    if (!["ready", "open"].includes(state)) {
      throw new OneComputerError("WORKSPACE_NOT_READY", "Start this sandbox to use Chat", 409, true);
    }
    return access;
  }

  private async owned(identity: IdentityContext, workspaceId: string) {
    const record = await this.store.getOwned(identity, workspaceId);
    if (!record) throw new OneComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    return record;
  }
}
