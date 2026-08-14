import { timingSafeEqual } from "node:crypto";
import { TLSSocket } from "node:tls";
import Fastify, { type FastifyRequest } from "fastify";
import {
  LemmaComputerError,
  chatAgentCatalogIdSchema,
  controllerCreateSchema,
  controllerEgressPolicyUpdateSchema,
  policyVerificationKeySetSchema,
  type PolicyIntegrityView,
  type PolicyVerificationKeySet,
  type RuntimePolicy,
  type Sandbox,
} from "@lemmacomputer/contracts";
import { assertWorkspaceNodeTopologyAllowed } from "@lemmacomputer/deployment-profile";
import { DockerKasmVncAdapter, type SandboxAdapter } from "@lemmacomputer/kasm-adapter";
import { PolicyVerificationError, verifySignedPolicyBundle } from "@lemmacomputer/policy-integrity";
import { z } from "zod";

const timeZoneSchema = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "KASM_LOCAL_TIME_ZONE must be a valid IANA timezone");

const envSchema = z.object({
  CONTROLLER_HOST: z.string().default("127.0.0.1"),
  CONTROLLER_PORT: z.coerce.number().int().positive().default(4101),
  CONTROLLER_INTERNAL_TOKEN: z.string().min(24),
  WORKSPACE_RUNTIME: z.literal("docker-kasmvnc").default("docker-kasmvnc"),
  WORKSPACE_NODE_ID: z.string().min(1).max(128),
  WORKSPACE_NODE_TOPOLOGY: z.enum(["colocated", "remote"]).default("colocated"),
  WORKSPACE_NODE_AUTH_MODE: z.enum(["token", "mtls"]).default("token"),
  WORKSPACE_NODE_TLS_CA_B64: z.string().optional(),
  WORKSPACE_NODE_TLS_SERVER_CERT_B64: z.string().optional(),
  WORKSPACE_NODE_TLS_SERVER_KEY_B64: z.string().optional(),
  WORKSPACE_NODE_CLIENT_COMMON_NAME: z.string().min(1).max(128).default("lemmacomputer-control"),
  LEMMACOMPUTER_INSTALLATION_KIND: z.enum(["customer-managed", "hosted", "worktree"]).default("customer-managed"),
  DOCKER_SOCKET_PATH: z.string().default("/var/run/docker.sock"),
  KASM_LOCAL_IMAGE: z.string().default("kasmweb/ubuntu-jammy-desktop@sha256:58b0710b320b99ab7e352342d7ec3a25b09740c523b75d794c5f7476910da580"),
  KASM_LOCAL_NETWORK_PREFIX: z.string().default("lemmacomputer-workspace"),
  KASM_LOCAL_CONTROL_NETWORK: z.string().default("lemmacomputer-control"),
  KASM_LOCAL_GATEWAY_CONTAINER: z.string().default("lemmacomputer-litellm"),
  KASM_LOCAL_CONTROL_CONTAINER: z.string().default("lemmacomputer-control-api"),
  KASM_LOCAL_RELAY_IMAGE: z.string().default("node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2"),
  KASM_LOCAL_EGRESS_PROXY_IMAGE: z.string().optional(),
  KASM_LOCAL_EGRESS_NETWORK: z.string().default("lemmacomputer-egress"),
  KASM_PUBLIC_HOST: z.string().default("127.0.0.1"),
  WORKSPACE_RELAY_BIND_HOST: z.string().default("127.0.0.1"),
  WORKSPACE_NODE_RELAY_NETWORK: z.string().optional(),
  WORKSPACE_NODE_APPLICATION_NETWORK: z.string().optional(),
  WORKSPACE_NODE_APPLICATION_TLS_CA_B64: z.string().optional(),
  KASM_LOCAL_KVM_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  KASM_LOCAL_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  KASM_LOCAL_TIME_ZONE: z.preprocess(
    (value) => value === "" ? undefined : value,
    timeZoneSchema.optional(),
  ),
  CHAT_ATTACHMENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(90),
  POLICY_VERIFICATION_KEYS_B64: z.string().min(32),
});

function sameSecret(received: string | undefined, expected: string) {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface NodeRequestAuthenticator {
  authenticate(request: FastifyRequest): boolean;
}

export class TokenNodeRequestAuthenticator implements NodeRequestAuthenticator {
  constructor(private readonly token: string) {}
  authenticate(request: FastifyRequest) {
    return sameSecret(request.headers["x-controller-token"] as string | undefined, this.token);
  }
}

export class MutualTlsNodeRequestAuthenticator implements NodeRequestAuthenticator {
  constructor(private readonly token: string, private readonly clientCommonName: string) {}
  authenticate(request: FastifyRequest) {
    const socket = request.raw.socket;
    if (!(socket instanceof TLSSocket) || !socket.encrypted || !socket.authorized) return false;
    const certificate = socket.getPeerCertificate();
    return certificate.subject?.CN === this.clientCommonName
      && sameSecret(request.headers["x-controller-token"] as string | undefined, this.token);
  }
}

const unavailableIntegrity = (policy: RuntimePolicy, reasonCode: PolicyIntegrityView["reasonCode"]): PolicyIntegrityView => ({
  state: reasonCode === "POLICY_EXPIRED" ? "expired" : reasonCode === "POLICY_SIGNATURE_INVALID" ? "invalid" : "unavailable",
  reasonCode,
  expected: { version: policy.policyVersion, digest: policy.policyHash },
  projected: null,
  enforced: null,
});

const verifiedIntegrity = (verified: ReturnType<typeof verifySignedPolicyBundle>): PolicyIntegrityView => {
  const record = {
    version: verified.payload.policy.policyVersion,
    digest: verified.payload.policy.policyHash,
    bundleDigest: verified.bundleDigest,
    keyId: verified.keyId,
  };
  return {
    state: "match",
    reasonCode: "POLICY_INTEGRITY_MATCH",
    expected: { version: record.version, digest: record.digest },
    projected: { ...record, expiresAt: verified.payload.expiresAt },
    enforced: { ...record, verifiedAt: verified.verifiedAt },
  };
};

const publicSandbox = (
  sandbox: Sandbox,
  keys: PolicyVerificationKeySet,
  expectedPolicy?: RuntimePolicy,
): Sandbox => {
  const { projectedPolicyBundle, policyProjectionPresent: _projectionPresent, ...safe } = sandbox;
  if (!projectedPolicyBundle) {
    return expectedPolicy
      ? { ...safe, policyIntegrity: unavailableIntegrity(expectedPolicy, sandbox.policyProjectionPresent ? "POLICY_SIGNATURE_INVALID" : "POLICY_PROJECTION_UNAVAILABLE") }
      : safe;
  }
  try {
    const verified = verifySignedPolicyBundle(projectedPolicyBundle, keys, {
      ...(sandbox.workspaceId ? { workspaceId: sandbox.workspaceId } : {}),
      ...(expectedPolicy ? { policy: expectedPolicy, minimumPolicyVersion: expectedPolicy.policyVersion } : {}),
    });
    return { ...safe, policyIntegrity: verifiedIntegrity(verified) };
  } catch (error) {
    if (!expectedPolicy) return safe;
    const reasonCode = error instanceof PolicyVerificationError && error.code === "POLICY_EXPIRED"
      ? "POLICY_EXPIRED"
      : "POLICY_SIGNATURE_INVALID";
    return { ...safe, policyIntegrity: unavailableIntegrity(expectedPolicy, reasonCode) };
  }
};

const verifyGrantBindings = (
  input: z.infer<typeof controllerCreateSchema>,
  verified: ReturnType<typeof verifySignedPolicyBundle>,
) => {
  if (input.accessGeneration !== verified.payload.accessGeneration) {
    throw new PolicyVerificationError("POLICY_BINDING_MISMATCH", "The access generation does not match the signed policy");
  }
  const modelRoutes = [
    input.gateway?.baseUrl,
    ...(input.agentGrants?.map((grant) => grant.gateway.baseUrl) ?? []),
  ].filter(Boolean);
  const controlRoutes = [
    input.agentBridge?.baseUrl,
    ...(input.agentGrants?.map((grant) => grant.agentBridge.baseUrl) ?? []),
  ].filter(Boolean);
  if (
    modelRoutes.some((route) => route !== verified.payload.routes.modelGateway)
    || controlRoutes.some((route) => route !== verified.payload.routes.mcpControl)
  ) {
    throw new PolicyVerificationError("POLICY_BINDING_MISMATCH", "A derived grant route does not match the signed policy");
  }
  if (input.egressProxy && (
    input.egressProxy.expectedGrant.tenantId !== verified.payload.tenantId
    || input.egressProxy.expectedGrant.subjectId !== verified.payload.subjectId
    || input.egressProxy.expectedGrant.workspaceId !== verified.payload.workspaceId
    || input.egressProxy.expectedGrant.accessGeneration !== verified.payload.accessGeneration
    || input.egressProxy.expectedGrant.egressMode !== verified.payload.policy.egressMode
    || input.egressProxy.expectedGrant.policyHash !== verified.payload.policy.policyHash
  )) {
    throw new PolicyVerificationError("POLICY_BINDING_MISMATCH", "The egress grant does not match the signed policy");
  }
  const fallback = ({
    "claude-cli-managed-v1": "claude-cli",
    "codex-cli-managed-v1": "codex-cli",
    "hermes-claw-managed-v1": "hermes-claw",
  } as const)[verified.payload.policy.agentProfile as "claude-cli-managed-v1" | "codex-cli-managed-v1" | "hermes-claw-managed-v1"];
  const expectedChatAgents = (verified.payload.policy.agents?.map((agent) => agent.catalogId) ?? [fallback])
    .flatMap((catalogId) => {
      const parsed = chatAgentCatalogIdSchema.safeParse(catalogId);
      return parsed.success ? [parsed.data] : [];
    })
    .sort();
  const grantedChatAgents = (input.chatRuntimes ?? []).map((runtime) => runtime.catalogId).sort();
  if (
    new Set(grantedChatAgents).size !== grantedChatAgents.length
    || JSON.stringify(grantedChatAgents) !== JSON.stringify(expectedChatAgents)
  ) {
    throw new PolicyVerificationError("POLICY_BINDING_MISMATCH", "The chat runtime grants do not match the signed policy");
  }
};

const verifyEgressGrantBinding = (
  input: z.infer<typeof controllerEgressPolicyUpdateSchema>,
  verified: ReturnType<typeof verifySignedPolicyBundle>,
) => {
  if (
    !verified.payload.policy.egress
    || input.egressProxy.expectedGrant.tenantId !== verified.payload.tenantId
    || input.egressProxy.expectedGrant.subjectId !== verified.payload.subjectId
    || input.egressProxy.expectedGrant.workspaceId !== verified.payload.workspaceId
    || input.egressProxy.expectedGrant.accessGeneration !== verified.payload.accessGeneration
    || input.egressProxy.expectedGrant.agentId !== verified.payload.policy.agentId
    || input.egressProxy.expectedGrant.securityGroupVersionId !== verified.payload.policy.egress.id
    || input.egressProxy.expectedGrant.egressMode !== verified.payload.policy.egressMode
    || input.egressProxy.expectedGrant.policyHash !== verified.payload.policy.policyHash
  ) {
    throw new PolicyVerificationError("POLICY_BINDING_MISMATCH", "The egress proxy grant does not match the signed policy");
  }
};

export function createControllerServer(
  adapter: SandboxAdapter,
  authentication: string | NodeRequestAuthenticator,
  verificationKeys: PolicyVerificationKeySet,
  options: {
    nodeId?: string;
    https?: { ca: string; cert: string; key: string; requestCert: true; rejectUnauthorized: true; minVersion: "TLSv1.2" };
    audit?: (event: Record<string, unknown>) => void;
  } = {},
) {
  const keys = policyVerificationKeySetSchema.parse(verificationKeys);
  const authenticator = typeof authentication === "string" ? new TokenNodeRequestAuthenticator(authentication) : authentication;
  const audit = options.audit ?? (() => undefined);
  const app = Fastify({
    ...(options.https ? { https: options.https } : {}),
    logger: { redact: ["req.headers.authorization", "req.headers.x-controller-token", "req.body.gateway.credential", "req.body.agentBridge.token", "req.body.chatRuntimes.*.key", "req.body.policyBundle.signature", "*.launchUrl", "*.session_token"] },
    bodyLimit: 128 * 1024,
  });
  const emitAudit = (event: Record<string, unknown>) => {
    try {
      audit({ event: "workspace_node_lifecycle", nodeId: options.nodeId, ...event });
    } catch (error) {
      app.log.error({ err: error }, "workspace node audit sink failed");
    }
  };
  const requestWorkspaceId = (request: FastifyRequest) => {
    const params = request.params as { workspaceId?: unknown };
    return typeof params.workspaceId === "string" ? params.workspaceId : undefined;
  };
  const requestAction = (request: FastifyRequest) => {
    if (request.url.includes("/egress-policy")) return "egress_update";
    if (request.url.includes("/storage")) return "purge";
    if (request.url.endsWith("/open")) return "open";
    if (request.method === "POST") return "create";
    if (request.method === "DELETE") return "destroy";
    return "reconciliation";
  };
  const authorityFor = async (workspaceId: string, providerId: string) => {
    try {
      return await adapter.auditContext?.(workspaceId, providerId);
    } catch (error) {
      if (error instanceof LemmaComputerError && error.statusCode === 404) return undefined;
      throw error;
    }
  };

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz") return;
    if (!authenticator.authenticate(request)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found", correlationId: request.id, retryable: false } });
    }
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.post<{ Params: { workspaceId: string } }>("/internal/v2/workspaces/:workspaceId/sandbox", async (request, reply) => {
    if (!request.body || typeof request.body !== "object" || !Object.hasOwn(request.body, "policyBundle")) {
      throw new LemmaComputerError("POLICY_SIGNATURE_REQUIRED", "A signed effective policy is required", 403);
    }
    const input = controllerCreateSchema.parse(request.body);
    if (input.workspaceId !== request.params.workspaceId) {
      throw new LemmaComputerError("WORKSPACE_SANDBOX_BINDING_MISMATCH", "Request body is not bound to the workspace path", 409);
    }
    let verified: ReturnType<typeof verifySignedPolicyBundle>;
    try {
      verified = verifySignedPolicyBundle(input.policyBundle, keys, {
        workspaceId: input.workspaceId,
        accessGeneration: input.accessGeneration,
        policy: input.policy,
        minimumPolicyVersion: input.policy.policyVersion,
      });
      verifyGrantBindings(input, verified);
    } catch (error) {
      if (error instanceof PolicyVerificationError) {
        throw new LemmaComputerError(error.code, error.message, 403);
      }
      throw error;
    }
    const sandbox = await adapter.create({
      workspaceId: input.workspaceId,
      accessGeneration: input.accessGeneration,
      authority: {
        tenantId: verified.payload.tenantId,
        subjectId: verified.payload.subjectId,
        workspaceId: verified.payload.workspaceId,
        accessGeneration: verified.payload.accessGeneration,
        correlationId: input.correlationId,
        policyDigest: verified.payload.policy.policyHash,
        policyKeyId: verified.keyId,
      },
      policy: verified.payload.policy,
      policyBundle: input.policyBundle,
      policyVerificationKeys: keys,
      gateway: input.gateway,
      agentBridge: input.agentBridge,
      agentGrants: input.agentGrants,
      chatRuntimes: input.chatRuntimes,
      egressProxy: input.egressProxy,
    });
    emitAudit({
      tenantId: verified.payload.tenantId,
      subjectId: verified.payload.subjectId,
      workspaceId: verified.payload.workspaceId,
      accessGeneration: verified.payload.accessGeneration,
      correlationId: input.correlationId,
      policyDigest: verified.payload.policy.policyHash,
      policyKeyId: verified.keyId,
      action: "create",
      outcome: "success",
    });
    emitAudit({
      tenantId: verified.payload.tenantId,
      subjectId: verified.payload.subjectId,
      workspaceId: verified.payload.workspaceId,
      accessGeneration: verified.payload.accessGeneration,
      correlationId: input.correlationId,
      policyDigest: verified.payload.policy.policyHash,
      policyKeyId: verified.keyId,
      action: sandbox.state === "failed" ? "failure" : "ready",
      outcome: sandbox.state,
      failureCode: sandbox.failureCode,
    });
    return reply.code(201).send(publicSandbox({
      ...sandbox,
      projectedPolicyBundle: sandbox.projectedPolicyBundle ?? input.policyBundle,
      policyProjectionPresent: true,
    }, keys, input.policy));
  });
  app.put<{ Params: { workspaceId: string; providerId: string } }>("/internal/v2/workspaces/:workspaceId/sandboxes/:providerId/egress-policy", async (request, reply) => {
    const input = controllerEgressPolicyUpdateSchema.parse(request.body);
    if (input.workspaceId !== request.params.workspaceId) {
      throw new LemmaComputerError("WORKSPACE_SANDBOX_BINDING_MISMATCH", "Request body is not bound to the workspace path", 409);
    }
    let verified: ReturnType<typeof verifySignedPolicyBundle>;
    try {
      verified = verifySignedPolicyBundle(input.policyBundle, keys, {
        workspaceId: input.workspaceId,
        accessGeneration: input.egressProxy.expectedGrant.accessGeneration,
        policy: input.policy,
        minimumPolicyVersion: input.policy.policyVersion,
      });
      verifyEgressGrantBinding(input, verified);
    } catch (error) {
      if (error instanceof PolicyVerificationError) {
        throw new LemmaComputerError(error.code, error.message, 403);
      }
      throw error;
    }
    await adapter.updateEgressPolicy(request.params.workspaceId, request.params.providerId, {
      workspaceId: input.workspaceId,
      authority: {
        tenantId: verified.payload.tenantId,
        subjectId: verified.payload.subjectId,
        workspaceId: verified.payload.workspaceId,
        accessGeneration: verified.payload.accessGeneration,
        correlationId: request.id,
        policyDigest: verified.payload.policy.policyHash,
        policyKeyId: verified.keyId,
      },
      policy: verified.payload.policy,
      policyBundle: input.policyBundle,
      policyVerificationKeys: keys,
      egressProxy: input.egressProxy,
    });
    emitAudit({ tenantId: verified.payload.tenantId, subjectId: verified.payload.subjectId, workspaceId: verified.payload.workspaceId, accessGeneration: verified.payload.accessGeneration, correlationId: request.id, policyDigest: verified.payload.policy.policyHash, policyKeyId: verified.keyId, action: "egress_update", outcome: "success" });
    return reply.code(204).send();
  });
  app.get<{ Params: { workspaceId: string; providerId: string } }>("/internal/v2/workspaces/:workspaceId/sandboxes/:providerId", async (request) => {
    const sandbox = publicSandbox(await adapter.status(request.params.workspaceId, request.params.providerId), keys);
    const authority = await authorityFor(request.params.workspaceId, request.params.providerId);
    emitAudit({ ...authority, workspaceId: request.params.workspaceId, correlationId: request.id, action: "reconciliation", outcome: sandbox.state, failureCode: sandbox.failureCode });
    return sandbox;
  });
  app.post<{ Params: { workspaceId: string; providerId: string } }>("/internal/v2/workspaces/:workspaceId/sandboxes/:providerId/open", async (request) => {
    const launch = await adapter.open(request.params.workspaceId, request.params.providerId);
    const authority = await authorityFor(request.params.workspaceId, request.params.providerId);
    emitAudit({ ...authority, workspaceId: request.params.workspaceId, correlationId: request.id, action: "open", outcome: "success" });
    return launch;
  });
  app.delete<{ Params: { workspaceId: string; providerId: string } }>("/internal/v2/workspaces/:workspaceId/sandboxes/:providerId", async (request, reply) => {
    const authority = await authorityFor(request.params.workspaceId, request.params.providerId);
    await adapter.destroy(request.params.workspaceId, request.params.providerId);
    emitAudit({ ...authority, workspaceId: request.params.workspaceId, correlationId: request.id, action: "destroy", outcome: "success" });
    return reply.code(204).send();
  });
  app.delete<{ Params: { workspaceId: string }; Querystring: { accessGeneration?: string } }>("/internal/v2/workspaces/:workspaceId/storage", async (request) => {
    const accessGeneration = z.coerce.number().int().positive().parse(request.query.accessGeneration);
    const receipt = await adapter.purgeWorkspace(request.params.workspaceId, accessGeneration);
    emitAudit({ ...receipt.authority, workspaceId: request.params.workspaceId, accessGeneration, correlationId: request.id, action: "purge", outcome: receipt.verified ? "verified" : "failure" });
    return receipt;
  });

  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof LemmaComputerError
      ? error
      : error instanceof z.ZodError
        ? new LemmaComputerError("INVALID_REQUEST", "The controller request is invalid", 400)
        : new LemmaComputerError("INTERNAL_ERROR", "The workspace controller could not complete the request", 500, true);
    request.log.error({ err: { name: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : "Unknown controller error", code: known.code } }, "controller request failed");
    emitAudit({ workspaceId: requestWorkspaceId(request), correlationId: request.id, action: requestAction(request), outcome: "failure", failureCode: known.code });
    reply.code(known.statusCode).send({ error: { code: known.code, message: known.message, correlationId: request.id, retryable: known.retryable } });
  });
  return app;
}

export function adapterFromEnv(env: z.infer<typeof envSchema>): SandboxAdapter {
  assertWorkspaceNodeTopologyAllowed(env.LEMMACOMPUTER_INSTALLATION_KIND, env.WORKSPACE_NODE_TOPOLOGY);
  return new DockerKasmVncAdapter({
    socketPath: env.DOCKER_SOCKET_PATH,
    nodeId: env.WORKSPACE_NODE_ID,
    topology: env.WORKSPACE_NODE_TOPOLOGY,
    image: env.KASM_LOCAL_IMAGE,
    networkPrefix: env.KASM_LOCAL_NETWORK_PREFIX,
    controlNetwork: env.KASM_LOCAL_CONTROL_NETWORK,
    gatewayContainer: env.KASM_LOCAL_GATEWAY_CONTAINER,
    controlContainer: env.KASM_LOCAL_CONTROL_CONTAINER,
    relayImage: env.KASM_LOCAL_RELAY_IMAGE,
    egressProxyImage: env.KASM_LOCAL_EGRESS_PROXY_IMAGE,
    egressNetwork: env.KASM_LOCAL_EGRESS_NETWORK,
    publicHost: env.KASM_PUBLIC_HOST,
    relayBindHost: env.WORKSPACE_RELAY_BIND_HOST,
    relayNetwork: env.WORKSPACE_NODE_RELAY_NETWORK,
    relayTlsCertificate: env.WORKSPACE_NODE_TLS_SERVER_CERT_B64 ? Buffer.from(env.WORKSPACE_NODE_TLS_SERVER_CERT_B64, "base64").toString("utf8") : undefined,
    relayTlsKey: env.WORKSPACE_NODE_TLS_SERVER_KEY_B64 ? Buffer.from(env.WORKSPACE_NODE_TLS_SERVER_KEY_B64, "base64").toString("utf8") : undefined,
    applicationNetwork: env.WORKSPACE_NODE_APPLICATION_NETWORK,
    applicationTlsCa: env.WORKSPACE_NODE_APPLICATION_TLS_CA_B64 ? Buffer.from(env.WORKSPACE_NODE_APPLICATION_TLS_CA_B64, "base64").toString("utf8") : undefined,
    timeZone: env.KASM_LOCAL_TIME_ZONE,
    chatAttachmentRetentionDays: env.CHAT_ATTACHMENT_RETENTION_DAYS,
    kvmEnabled: env.KASM_LOCAL_KVM_ENABLED,
    startupTimeoutMs: env.KASM_LOCAL_STARTUP_TIMEOUT_MS,
    installationKind: env.LEMMACOMPUTER_INSTALLATION_KIND,
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const env = envSchema.parse(process.env);
  const verificationKeys = policyVerificationKeySetSchema.parse(JSON.parse(
    Buffer.from(env.POLICY_VERIFICATION_KEYS_B64, "base64").toString("utf8"),
  ));
  const adapter = adapterFromEnv(env);
  if (env.WORKSPACE_NODE_TOPOLOGY === "remote" && env.WORKSPACE_NODE_AUTH_MODE !== "mtls") {
    throw new Error("Remote workspace nodes require mutual TLS authentication");
  }
  const tlsValues = [env.WORKSPACE_NODE_TLS_CA_B64, env.WORKSPACE_NODE_TLS_SERVER_CERT_B64, env.WORKSPACE_NODE_TLS_SERVER_KEY_B64];
  if (env.WORKSPACE_NODE_AUTH_MODE === "mtls" && !tlsValues.every(Boolean)) {
    throw new Error("Mutual TLS workspace nodes require CA, server certificate, and server key material");
  }
  const authentication = env.WORKSPACE_NODE_AUTH_MODE === "mtls"
    ? new MutualTlsNodeRequestAuthenticator(env.CONTROLLER_INTERNAL_TOKEN, env.WORKSPACE_NODE_CLIENT_COMMON_NAME)
    : new TokenNodeRequestAuthenticator(env.CONTROLLER_INTERNAL_TOKEN);
  const app = createControllerServer(adapter, authentication, verificationKeys, {
    nodeId: env.WORKSPACE_NODE_ID,
    ...(env.WORKSPACE_NODE_AUTH_MODE === "mtls" ? {
      https: {
        ca: Buffer.from(env.WORKSPACE_NODE_TLS_CA_B64!, "base64").toString("utf8"),
        cert: Buffer.from(env.WORKSPACE_NODE_TLS_SERVER_CERT_B64!, "base64").toString("utf8"),
        key: Buffer.from(env.WORKSPACE_NODE_TLS_SERVER_KEY_B64!, "base64").toString("utf8"),
        requestCert: true as const,
        rejectUnauthorized: true as const,
        minVersion: "TLSv1.2" as const,
      },
    } : {}),
    audit: (event) => app.log.info(event, "workspace node lifecycle"),
  });
  const reconcile = async () => {
    try {
      await adapter.reconcile?.();
      app.log.info({ event: "workspace_node_lifecycle", nodeId: env.WORKSPACE_NODE_ID, action: "reconciliation", outcome: "success" }, "workspace node lifecycle");
    } catch (error) {
      app.log.error({ event: "workspace_node_lifecycle", nodeId: env.WORKSPACE_NODE_ID, action: "reconciliation", outcome: "failure", failureCode: error instanceof LemmaComputerError ? error.code : "RECONCILIATION_FAILED" }, "workspace node reconciliation failed");
    }
  };
  const reconciliationTimer = setInterval(reconcile, 5_000);
  reconciliationTimer.unref();
  app.addHook("onClose", async () => clearInterval(reconciliationTimer));
  await app.listen({ host: env.CONTROLLER_HOST, port: env.CONTROLLER_PORT });
  void reconcile();
}
