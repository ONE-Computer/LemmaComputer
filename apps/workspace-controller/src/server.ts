import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import {
  OneComputerError,
  chatAgentCatalogIdSchema,
  controllerCreateSchema,
  controllerEgressPolicyUpdateSchema,
  policyVerificationKeySetSchema,
  type PolicyIntegrityView,
  type PolicyVerificationKeySet,
  type RuntimePolicy,
  type Sandbox,
} from "@onecomputer/contracts";
import { KasmLocalAdapter, KasmDeveloperApiAdapter, type SandboxAdapter } from "@onecomputer/kasm-adapter";
import { PolicyVerificationError, verifySignedPolicyBundle } from "@onecomputer/policy-integrity";
import { z } from "zod";

const envSchema = z.object({
  CONTROLLER_HOST: z.string().default("127.0.0.1"),
  CONTROLLER_PORT: z.coerce.number().int().positive().default(4101),
  CONTROLLER_INTERNAL_TOKEN: z.string().min(24),
  SANDBOX_DRIVER: z.enum(["kasm", "kasm-local"]).default("kasm-local"),
  KASM_BASE_URL: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().url().optional(),
  ),
  KASM_API_KEY: z.string().optional(),
  KASM_API_SECRET: z.string().optional(),
  KASM_USER_ID: z.string().optional(),
  KASM_IMAGE_ID: z.string().optional(),
  DOCKER_SOCKET_PATH: z.string().default("/var/run/docker.sock"),
  KASM_LOCAL_IMAGE: z.string().default("kasmweb/ubuntu-jammy-desktop@sha256:58b0710b320b99ab7e352342d7ec3a25b09740c523b75d794c5f7476910da580"),
  KASM_LOCAL_NETWORK_PREFIX: z.string().default("onecomputer-workspace"),
  KASM_LOCAL_CONTROL_NETWORK: z.string().default("onecomputer-control"),
  KASM_LOCAL_GATEWAY_CONTAINER: z.string().default("onecomputer-litellm"),
  KASM_LOCAL_CONTROL_CONTAINER: z.string().default("onecomputer-control-api"),
  KASM_LOCAL_RELAY_IMAGE: z.string().default("node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2"),
  KASM_LOCAL_EGRESS_PROXY_IMAGE: z.string().optional(),
  KASM_LOCAL_EGRESS_NETWORK: z.string().default("onecomputer-egress"),
  KASM_PUBLIC_HOST: z.string().default("127.0.0.1"),
  POLICY_VERIFICATION_KEYS_B64: z.string().min(32),
});

function sameSecret(received: string | undefined, expected: string) {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
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
    || input.egressProxy.expectedGrant.agentId !== verified.payload.policy.agentId
    || input.egressProxy.expectedGrant.securityGroupVersionId !== verified.payload.policy.egress.id
    || input.egressProxy.expectedGrant.egressMode !== verified.payload.policy.egressMode
    || input.egressProxy.expectedGrant.policyHash !== verified.payload.policy.policyHash
  ) {
    throw new PolicyVerificationError("POLICY_BINDING_MISMATCH", "The egress proxy grant does not match the signed policy");
  }
};

export function createControllerServer(adapter: SandboxAdapter, internalToken: string, verificationKeys: PolicyVerificationKeySet) {
  const keys = policyVerificationKeySetSchema.parse(verificationKeys);
  const app = Fastify({
    logger: { redact: ["req.headers.authorization", "req.headers.x-controller-token", "req.body.gateway.credential", "req.body.agentBridge.token", "req.body.chatRuntimes.*.key", "req.body.policyBundle.signature", "*.launchUrl", "*.session_token"] },
    bodyLimit: 128 * 1024,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz") return;
    if (!sameSecret(request.headers["x-controller-token"] as string | undefined, internalToken)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found", correlationId: request.id, retryable: false } });
    }
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.post("/internal/v1/sandboxes", async (request, reply) => {
    if (!request.body || typeof request.body !== "object" || !Object.hasOwn(request.body, "policyBundle")) {
      throw new OneComputerError("POLICY_SIGNATURE_REQUIRED", "A signed effective policy is required", 403);
    }
    const input = controllerCreateSchema.parse(request.body);
    let verified: ReturnType<typeof verifySignedPolicyBundle>;
    try {
      verified = verifySignedPolicyBundle(input.policyBundle, keys, {
        workspaceId: input.workspaceId,
        policy: input.policy,
        minimumPolicyVersion: input.policy.policyVersion,
      });
      verifyGrantBindings(input, verified);
    } catch (error) {
      if (error instanceof PolicyVerificationError) {
        throw new OneComputerError(error.code, error.message, 403);
      }
      throw error;
    }
    const sandbox = await adapter.create({
      workspaceId: input.workspaceId,
      policy: verified.payload.policy,
      policyBundle: input.policyBundle,
      policyVerificationKeys: keys,
      gateway: input.gateway,
      agentBridge: input.agentBridge,
      agentGrants: input.agentGrants,
      chatRuntimes: input.chatRuntimes,
      egressProxy: input.egressProxy,
    });
    return reply.code(201).send(publicSandbox({
      ...sandbox,
      projectedPolicyBundle: sandbox.projectedPolicyBundle ?? input.policyBundle,
      policyProjectionPresent: true,
    }, keys, input.policy));
  });
  app.put<{ Params: { providerId: string } }>("/internal/v1/sandboxes/:providerId/egress-policy", async (request, reply) => {
    const input = controllerEgressPolicyUpdateSchema.parse(request.body);
    let verified: ReturnType<typeof verifySignedPolicyBundle>;
    try {
      verified = verifySignedPolicyBundle(input.policyBundle, keys, {
        workspaceId: input.workspaceId,
        policy: input.policy,
        minimumPolicyVersion: input.policy.policyVersion,
      });
      verifyEgressGrantBinding(input, verified);
    } catch (error) {
      if (error instanceof PolicyVerificationError) {
        throw new OneComputerError(error.code, error.message, 403);
      }
      throw error;
    }
    await adapter.updateEgressPolicy(request.params.providerId, {
      workspaceId: input.workspaceId,
      policy: verified.payload.policy,
      policyBundle: input.policyBundle,
      policyVerificationKeys: keys,
      egressProxy: input.egressProxy,
    });
    return reply.code(204).send();
  });
  app.get<{ Params: { providerId: string } }>("/internal/v1/sandboxes/:providerId", async (request) => (
    publicSandbox(await adapter.status(request.params.providerId), keys)
  ));
  app.post<{ Params: { providerId: string } }>("/internal/v1/sandboxes/:providerId/open", async (request) => adapter.open(request.params.providerId));
  app.delete<{ Params: { providerId: string } }>("/internal/v1/sandboxes/:providerId", async (request, reply) => {
    await adapter.destroy(request.params.providerId);
    return reply.code(204).send();
  });
  app.delete<{ Params: { workspaceId: string } }>("/internal/v1/workspaces/:workspaceId/storage", async (request, reply) => {
    await adapter.purgeWorkspace(request.params.workspaceId);
    return reply.code(204).send();
  });

  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof OneComputerError
      ? error
      : error instanceof z.ZodError
        ? new OneComputerError("INVALID_REQUEST", "The controller request is invalid", 400)
        : new OneComputerError("INTERNAL_ERROR", "The workspace controller could not complete the request", 500, true);
    request.log.error({ err: { name: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : "Unknown controller error", code: known.code } }, "controller request failed");
    reply.code(known.statusCode).send({ error: { code: known.code, message: known.message, correlationId: request.id, retryable: known.retryable } });
  });
  return app;
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required when SANDBOX_DRIVER=kasm`);
  return value;
}

export function adapterFromEnv(env: z.infer<typeof envSchema>): SandboxAdapter {
  if (env.SANDBOX_DRIVER === "kasm-local") {
    return new KasmLocalAdapter({
      socketPath: env.DOCKER_SOCKET_PATH,
      image: env.KASM_LOCAL_IMAGE,
      networkPrefix: env.KASM_LOCAL_NETWORK_PREFIX,
      controlNetwork: env.KASM_LOCAL_CONTROL_NETWORK,
      gatewayContainer: env.KASM_LOCAL_GATEWAY_CONTAINER,
      controlContainer: env.KASM_LOCAL_CONTROL_CONTAINER,
      relayImage: env.KASM_LOCAL_RELAY_IMAGE,
      egressProxyImage: env.KASM_LOCAL_EGRESS_PROXY_IMAGE,
      egressNetwork: env.KASM_LOCAL_EGRESS_NETWORK,
      publicHost: env.KASM_PUBLIC_HOST,
    });
  }
  return new KasmDeveloperApiAdapter({
    baseUrl: required(env.KASM_BASE_URL, "KASM_BASE_URL"),
    apiKey: required(env.KASM_API_KEY, "KASM_API_KEY"),
    apiSecret: required(env.KASM_API_SECRET, "KASM_API_SECRET"),
    userId: required(env.KASM_USER_ID, "KASM_USER_ID"),
    imageId: required(env.KASM_IMAGE_ID, "KASM_IMAGE_ID"),
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const env = envSchema.parse(process.env);
  const verificationKeys = policyVerificationKeySetSchema.parse(JSON.parse(
    Buffer.from(env.POLICY_VERIFICATION_KEYS_B64, "base64").toString("utf8"),
  ));
  const app = createControllerServer(adapterFromEnv(env), env.CONTROLLER_INTERNAL_TOKEN, verificationKeys);
  await app.listen({ host: env.CONTROLLER_HOST, port: env.CONTROLLER_PORT });
}
