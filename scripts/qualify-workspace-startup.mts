import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { IdentityContext, RuntimePolicy } from "@lemmacomputer/contracts";
import { LiteLLMGatewayAdapter } from "@lemmacomputer/litellm-adapter";
import { PolicyBundleSigner } from "@lemmacomputer/policy-integrity";
import { PostgresIdentityPolicyStore, PostgresWorkspaceStore, runtimePolicyFor } from "@lemmacomputer/workspace-store";

const { AgentBridgeAuthority } = await import(pathToFileURL(
  `${process.cwd()}/apps/control-api/src/agent-bridge.ts`,
).href);

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const controllerUrl = required("CONTROLLER_URL");
const controllerToken = required("CONTROLLER_INTERNAL_TOKEN");
const agentBridgeSecret = required("AGENT_BRIDGE_SECRET");
const keepFailedWorkspace = process.env.KEEP_FAILED_QUALIFICATION_WORKSPACE === "true";
const signer = new PolicyBundleSigner({
  keyId: required("POLICY_SIGNING_KEY_ID"),
  privateKeyPkcs8Base64: required("POLICY_SIGNING_PRIVATE_KEY_B64"),
});
const modelGateway = required("LITELLM_WORKSPACE_URL");
const mcpControl = "http://lemmacomputer-control:4100";
const chatRuntimeKey = "release-hermes-chat-runtime-key-at-least-32-characters";
const workspaceStore = PostgresWorkspaceStore.fromConnectionString(required("DATABASE_URL"));
const identityPolicyStore = PostgresIdentityPolicyStore.fromConnectionString(required("DATABASE_URL"));
// The release runner owns a disposable database. Normal startup deliberately
// does not create an authenticated customer or a bootstrap user's policy.
if (process.env.LEMMACOMPUTER_INSTALLATION_KIND !== "worktree"
  || process.env.RUNTIME_ENVIRONMENT !== "development") {
  throw new Error("Workspace startup qualification requires a disposable development worktree");
}
let identity: IdentityContext | undefined;
const qualificationId = randomUUID();
const grantId = `release-qualification-${qualificationId}`;
const gateway = new LiteLLMGatewayAdapter({
  adminUrl: required("LITELLM_ADMIN_URL"),
  workspaceUrl: modelGateway,
  masterKey: required("LITELLM_MASTER_KEY"),
  credentialSecret: required("LITELLM_CREDENTIAL_SECRET"),
});

const controller = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${controllerUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      "x-controller-token": controllerToken,
      ...init?.headers,
    },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Controller ${response.status}: ${JSON.stringify(body)}`);
  return body as Record<string, unknown> | null;
};

let providerId: string | undefined;
let workspaceId: string | undefined;
let agentId: string | undefined;
let gatewayGranted = false;
let qualificationError: unknown;
const startedAt = Date.now();
try {
  const accountUserId = randomUUID();
  const authenticationSessionId = randomUUID();
  const now = new Date();
  await identityPolicyStore.ensureCustomerAccount({ accountUserId });
  await identityPolicyStore.createCustomerOrganization({
    accountUserId,
    authenticationSessionId,
    email: `release-${qualificationId}@example.test`,
    userDisplayName: "Release qualification",
    organizationDisplayName: `Release qualification ${qualificationId}`,
    tenantKind: "organization",
    idempotencyKey: qualificationId,
    installationKind: "worktree",
    expiresAt: new Date(now.getTime() + 30 * 60_000),
    now,
  });
  const principal = await identityPolicyStore.getCustomerProductSession({ accountUserId, authenticationSessionId, now });
  if (!principal) throw new Error("Release qualification owner context was not created");
  identity = principal.identity;
  const effectivePolicy = await identityPolicyStore.getEffectivePolicy(principal.userId);
  if (!effectivePolicy) {
    throw new Error("Release qualification owner has no active workspace policy");
  }
  const policy: RuntimePolicy = {
    ...runtimePolicyFor(
      effectivePolicy,
      "lemmacomputer-claude",
      "claude-desktop-standard-v1",
      ["hermes-claw"],
      ["google-chrome"],
      null,
    ),
    requestedServiceClass: "balanced",
  };
  agentId = policy.agentId;
  const record = await workspaceStore.createOrGet(identity, grantId, `release-workspace-smoke-${qualificationId}`);
  workspaceId = record.id;
  await workspaceStore.saveSandboxSettings(identity, {
    grantId,
    profileId: "claude-desktop-standard-v1",
    applicationIds: ["google-chrome"],
    modelAlias: "lemmacomputer-claude",
    requestedServiceClass: "balanced",
    agentIds: ["hermes-claw"],
  });
  // Hold lifecycle ownership until teardown so background recovery cannot
  // replace this directly provisioned qualification runtime mid-smoke.
  const claimed = await workspaceStore.claim(workspaceId, ["not_created"], "provisioning");
  if (!claimed?.operationToken) throw new Error("Release qualification could not claim workspace startup");
  const policyBundle = signer.issue({
    identity,
    workspaceId,
    accessGeneration: 1,
    policy,
    routes: { modelGateway, mcpControl },
  });
  const agentBridgeToken = new AgentBridgeAuthority(agentBridgeSecret).issue(identity, workspaceId, policy, {
    workspaceGeneration: 1,
  });
  const agentBridge = { baseUrl: mcpControl, token: agentBridgeToken };
  const gatewayGrant = await gateway.ensureGrant({ workspaceId, accessGeneration: 1, identity, agentId, policy });
  gatewayGranted = true;
  const created = await controller(`/internal/v2/workspaces/${workspaceId}/sandbox`, {
    method: "POST",
    body: JSON.stringify({
      workspaceId,
      accessGeneration: 1,
      correlationId: `release-workspace-smoke-${workspaceId}`,
      policy,
      policyBundle,
      gateway: gatewayGrant,
      agentBridge,
      agentGrants: [{
        catalogId: "hermes-claw",
        agentId,
        gateway: gatewayGrant,
        agentBridge,
      }],
      chatRuntimes: [{
        catalogId: "hermes-claw",
        key: chatRuntimeKey,
      }],
    }),
  });
  providerId = typeof created?.providerId === "string" ? created.providerId : undefined;
  if (!providerId || created?.state !== "ready") {
    throw new Error(`Workspace did not become ready: ${JSON.stringify({ providerId, state: created?.state })}`);
  }
  await workspaceStore.update(workspaceId, { state: "ready", providerId });
  const status = await controller(`/internal/v2/workspaces/${workspaceId}/sandboxes/${encodeURIComponent(providerId)}`);
  if (status?.state !== "ready") throw new Error(`Workspace readiness was not durable: ${JSON.stringify(status)}`);
  const hermesResponse = await fetch(`http://lemmacomputer-sandbox-${workspaceId}:8642/health`, {
    headers: { authorization: `Bearer ${chatRuntimeKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  const hermesHealth = await hermesResponse.json().catch(() => null) as Record<string, unknown> | null;
  if (!hermesResponse.ok || hermesHealth?.status !== "ready"
    || hermesHealth?.agent !== "hermes-claw" || hermesHealth?.protocol !== "lemmacomputer-chat-events/v1") {
    throw new Error(`Hermes runtime readiness failed: ${JSON.stringify({ status: hermesResponse.status, body: hermesHealth })}`);
  }
  process.stdout.write(`${JSON.stringify({
    workspaceId,
    providerId,
    state: status.state,
    protocol: hermesHealth.protocol,
    startupMs: Date.now() - startedAt,
    agent: "hermes-claw",
  })}\n`);
} catch (error) {
  qualificationError = new Error(`Workspace startup qualification ${workspaceId ?? qualificationId} failed`, { cause: error });
} finally {
  const cleanupErrors: unknown[] = [];
  if (providerId) {
    await controller(`/internal/v2/workspaces/${workspaceId}/sandboxes/${encodeURIComponent(providerId)}`, { method: "DELETE" })
      .catch((error) => cleanupErrors.push(error));
  }
  if (gatewayGranted && workspaceId && agentId) {
    await gateway.revoke(workspaceId, agentId).catch((error) => cleanupErrors.push(error));
  }
  if (workspaceId && (!qualificationError || !keepFailedWorkspace)) {
    await controller(`/internal/v2/workspaces/${workspaceId}/storage?accessGeneration=1`, { method: "DELETE" })
      .catch((error) => cleanupErrors.push(error));
  } else if (workspaceId) {
    process.stderr.write(`Retained failed qualification storage for ${workspaceId}\n`);
  }
  if (workspaceId && identity) await workspaceStore.remove(identity, workspaceId).catch((error) => cleanupErrors.push(error));
  await Promise.all([
    workspaceStore.close(),
    identityPolicyStore.close(),
  ]).catch((error) => cleanupErrors.push(error));
  if (qualificationError) throw qualificationError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Workspace qualification cleanup failed");
}
