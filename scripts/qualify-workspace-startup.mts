import { randomUUID } from "node:crypto";
import type { RuntimePolicy } from "@onecomputer/contracts";
import { PolicyBundleSigner } from "@onecomputer/policy-integrity";
import { AgentBridgeAuthority } from "../apps/control-api/src/agent-bridge.js";

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
const workspaceId = randomUUID();
const agentId = `release-hermes-${workspaceId.slice(0, 8)}`;
const modelGateway = "http://litellm:4000";
const mcpControl = "http://onecomputer-control:4100";
const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
const policy: RuntimePolicy = {
  schemaVersion: 1,
  policyVersionId: `release-policy-${workspaceId}`,
  policyVersion: 1,
  policyHash: "d".repeat(64),
  workspaceProfile: "kasm-persistent-standard",
  executionMode: "managed",
  egressMode: "restricted",
  agentId,
  agentProfile: "hermes-claw-managed-v1",
  applications: ["google-chrome"],
  networkProfile: "controlled-egress-v1",
  clipboard: {
    enabled: true,
    localToWorkspace: true,
    workspaceToLocal: true,
    maxBytes: 65_536,
  },
  modelAlias: "onecomputer-auto",
  mcpServer: "onecomputer_connectors",
  requestedServiceClass: "auto",
  allowedTools: ["list-mail-folders"],
  toolPolicies: { "list-mail-folders": "allow" },
};
const identity = { tenantId: "release-qualification", subjectId: "workspace-smoke", audience: "onecomputer-control" } as const;
const policyBundle = signer.issue({
  identity,
  workspaceId,
  policy,
  routes: { modelGateway, mcpControl },
});
const agentBridgeToken = new AgentBridgeAuthority(agentBridgeSecret).issue(identity, workspaceId, policy, {
  workspaceGeneration: 1,
});
const gatewayGrant = {
  baseUrl: modelGateway,
  credential: "release-workspace-gateway-key-at-least-32-characters",
  modelAlias: policy.modelAlias,
  transportModelAlias: "openai/gpt-5.6-terra",
  expiresAt,
};
const agentBridge = { baseUrl: mcpControl, token: agentBridgeToken };

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
let qualificationError: unknown;
const startedAt = Date.now();
try {
  const created = await controller("/internal/v1/sandboxes", {
    method: "POST",
    body: JSON.stringify({
      workspaceId,
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
        key: "release-hermes-chat-runtime-key-at-least-32-characters",
      }],
    }),
  });
  providerId = typeof created?.providerId === "string" ? created.providerId : undefined;
  if (!providerId || created?.state !== "ready") {
    throw new Error(`Workspace did not become ready: ${JSON.stringify({ providerId, state: created?.state })}`);
  }
  const status = await controller(`/internal/v1/sandboxes/${encodeURIComponent(providerId)}`);
  if (status?.state !== "ready") throw new Error(`Workspace readiness was not durable: ${JSON.stringify(status)}`);
  process.stdout.write(`${JSON.stringify({
    workspaceId,
    providerId,
    state: status.state,
    startupMs: Date.now() - startedAt,
    agent: "hermes-claw",
  })}\n`);
} catch (error) {
  qualificationError = new Error(`Workspace startup qualification ${workspaceId} failed`, { cause: error });
} finally {
  const cleanupErrors: unknown[] = [];
  if (providerId) {
    await controller(`/internal/v1/sandboxes/${encodeURIComponent(providerId)}`, { method: "DELETE" })
      .catch((error) => cleanupErrors.push(error));
  }
  if (!qualificationError || !keepFailedWorkspace) {
    await controller(`/internal/v1/workspaces/${workspaceId}/storage`, { method: "DELETE" })
      .catch((error) => cleanupErrors.push(error));
  } else {
    process.stderr.write(`Retained failed qualification storage for ${workspaceId}\n`);
  }
  if (qualificationError) throw qualificationError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Workspace qualification cleanup failed");
}
