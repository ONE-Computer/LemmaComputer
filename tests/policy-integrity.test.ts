import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { IdentityContext, RuntimePolicy } from "@lemmacomputer/contracts";
import {
  PolicyBundleSigner,
  PolicyVerificationError,
  verifySignedPolicyBundle,
  type PolicyVerificationKeySet,
} from "@lemmacomputer/policy-integrity";

const identity: IdentityContext = {
  tenantId: "acme",
  subjectId: "alex",
  audience: "lemmacomputer-control",
};

const policy: RuntimePolicy = {
  schemaVersion: 1,
  policyVersionId: "policy-version-7",
  policyVersion: 7,
  policyHash: "a".repeat(64),
  workspaceProfile: "claude-desktop-standard-v1",
  agentId: "agent-alex:hermes-claw",
  agentProfile: "hermes-claw-managed-v1",
  agents: [{
    catalogId: "hermes-claw",
    agentId: "agent-alex:hermes-claw",
    agentProfile: "hermes-claw-managed-v1",
    displayName: "Hermes Agent CLI",
    clientVersion: "0.19.0",
    modelAlias: "lemmacomputer-glm",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-calendars"],
    toolPolicies: { "list-calendars": "allow" },
  }],
  networkProfile: "controlled-egress-v1",
  modelAlias: "lemmacomputer-glm",
  mcpServer: "lemmacomputer_ms365",
  allowedTools: ["list-calendars"],
  toolPolicies: { "list-calendars": "allow" },
};

const fixture = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = new PolicyBundleSigner({
    keyId: "psk_policy_2026_07",
    privateKeyPkcs8Base64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  });
  const keys: PolicyVerificationKeySet = {
    profile: "lemmacomputer-policy-key-set/v1",
    keys: [{
      ...signer.verificationKey(),
      status: "active",
    }],
  };
  const now = new Date("2026-07-23T08:00:00.000Z");
  const bundle = signer.issue({
    identity,
    workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
    accessGeneration: 1,
    policy,
    routes: {
      modelGateway: "http://litellm:4000",
      mcpControl: "http://lemmacomputer-control:4100",
    },
    now,
    ttlSeconds: 900,
  });
  return { signer, keys, now, bundle };
};

test("a canonical Ed25519 bundle verifies exact workspace, policy, agents, routes, resources, and validity", () => {
  const { keys, now, bundle } = fixture();
  const verified = verifySignedPolicyBundle(bundle, keys, {
    identity,
    workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
    accessGeneration: 1,
    policy,
    now,
  });

  assert.equal(verified.payload.policy.policyHash, policy.policyHash);
  assert.equal(verified.payload.routes.modelGateway, "http://litellm:4000");
  assert.deepEqual(verified.payload.agentResources, [{
    catalogId: "hermes-claw",
    agentId: "agent-alex:hermes-claw",
    memoryMiB: 768,
  }]);
  assert.equal(verified.keyId, "psk_policy_2026_07");
  assert.match(verified.bundleDigest, /^[a-f0-9]{64}$/);
});

test("mutation, cross-workspace copy, unknown key, revocation, expiry, future issue, and rollback fail closed", () => {
  const { keys, now, bundle } = fixture();
  const mutated = {
    ...bundle,
    signature: `${bundle.signature.startsWith("A") ? "B" : "A"}${bundle.signature.slice(1)}`,
  };
  assert.throws(
    () => verifySignedPolicyBundle(mutated, keys, {
      identity,
      workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      policy,
      now,
    }),
    (error: unknown) => error instanceof PolicyVerificationError && error.code === "POLICY_SIGNATURE_INVALID",
  );
  assert.throws(
    () => verifySignedPolicyBundle(bundle, keys, {
      identity,
      workspaceId: "dc5c601c-4bed-46cc-9556-a25dc9b688d8",
      policy,
      now,
    }),
    (error: unknown) => error instanceof PolicyVerificationError && error.code === "POLICY_BINDING_MISMATCH",
  );
  assert.throws(
    () => verifySignedPolicyBundle(bundle, {
      ...keys,
      keys: keys.keys.map((key) => ({ ...key, keyId: "psk_different_key" })),
    }, {
      identity,
      workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      policy,
      now,
    }),
    (error: unknown) => error instanceof PolicyVerificationError && error.code === "POLICY_KEY_UNKNOWN",
  );
  assert.throws(
    () => verifySignedPolicyBundle(bundle, {
      ...keys,
      keys: keys.keys.map((key) => ({ ...key, status: "revoked" as const })),
    }, {
      identity,
      workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      policy,
      now,
    }),
    (error: unknown) => error instanceof PolicyVerificationError && error.code === "POLICY_KEY_REVOKED",
  );
  assert.throws(
    () => verifySignedPolicyBundle(bundle, keys, {
      identity,
      workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      policy,
      now: new Date("2026-07-23T08:15:01.000Z"),
    }),
    (error: unknown) => error instanceof PolicyVerificationError && error.code === "POLICY_EXPIRED",
  );
  assert.throws(
    () => verifySignedPolicyBundle(bundle, keys, {
      identity,
      workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      policy,
      now: new Date("2026-07-23T07:59:00.000Z"),
    }),
    (error: unknown) => error instanceof PolicyVerificationError && error.code === "POLICY_NOT_YET_VALID",
  );
  assert.throws(
    () => verifySignedPolicyBundle(bundle, keys, {
      identity,
      workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      policy,
      minimumPolicyVersion: 8,
      now,
    }),
    (error: unknown) => error instanceof PolicyVerificationError && error.code === "POLICY_ROLLBACK_DETECTED",
  );
});
