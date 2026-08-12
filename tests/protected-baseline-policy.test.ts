import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "@lemmacomputer/contracts";
import {
  ProductReleaseTemplateSigner,
  ProtectedPolicyResolutionError,
  ProtectedTemplateVerificationError,
  resolveProtectedBaselinePolicy,
  verifyProtectedBaselineTemplate,
  type ProductReleaseVerificationKeySet,
  type ProtectedBaselineTemplateDocument,
  type VerifiedProtectedBaselineTemplate,
} from "@lemmacomputer/policy-integrity";

const document = (): ProtectedBaselineTemplateDocument => ({
  schemaVersion: 1,
  constraints: {
    workspaceProfiles: {
      allow: ["claude-desktop-standard-v1"],
      deny: ["disposable-open-v1"],
    },
    agents: {
      allow: ["claude-desktop", "claude-cli"],
      deny: ["hermes-desktop", "hermes-claw"],
    },
    applications: {
      allow: ["firefox", "google-chrome"],
      deny: [],
    },
    modelAliases: {
      allow: ["lemmacomputer-claude", "lemmacomputer-openai"],
      deny: [],
    },
    serviceClasses: {
      allow: ["balanced", "pro"],
      deny: ["auto"],
    },
    maximumReasoningEffort: "medium",
    maximumEgressMode: "restricted",
    clipboard: {
      localToWorkspace: true,
      workspaceToLocal: false,
      maxBytes: 32_768,
    },
    connectors: {
      allow: ["microsoft-365", "linear"],
      deny: [],
      toolPolicies: {
        "microsoft-365": {
          "list-calendars": "allow",
          "send-mail": "approval_required",
          "delete-onedrive-file": "deny",
        },
        linear: {
          create_issue: "approval_required",
        },
      },
    },
    capabilities: {
      allow: ["ai-assistant", "m365-read", "m365-write-protected"],
      deny: [],
    },
  },
});

const fixture = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = new ProductReleaseTemplateSigner({
    keyId: "prk_release_0_5",
    privateKeyPkcs8Base64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  });
  const keys: ProductReleaseVerificationKeySet = {
    profile: "lemmacomputer-product-release-key-set/v1",
    keys: [{ ...signer.verificationKey(), status: "active" }],
  };
  const now = new Date("2026-08-12T06:00:00.000Z");
  const envelope = signer.issue({
    templateId: "pbt_claude_office",
    templateVersionId: "pbtv_claude_office_1",
    version: 1,
    supersedesTemplateVersionId: null,
    release: {
      releaseId: "0.5.0",
      sourceCommit: "a".repeat(40),
      publishedAt: "2026-08-12T05:30:00.000Z",
    },
    document: document(),
  });
  const verified = verifyProtectedBaselineTemplate(envelope, keys, { now });
  return { signer, privateKey, keys, now, envelope, verified };
};

const payloadFrom = (encoded: string) => JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;

test("a product-release signature verifies immutable template identity, content hash, and release provenance", () => {
  const { verified } = fixture();

  assert.equal(verified.payload.templateId, "pbt_claude_office");
  assert.equal(verified.payload.templateVersionId, "pbtv_claude_office_1");
  assert.equal(verified.payload.version, 1);
  assert.equal(verified.payload.supersedesTemplateVersionId, null);
  assert.equal(verified.payload.release.releaseId, "0.5.0");
  assert.equal(
    verified.payload.documentHash,
    createHash("sha256").update(canonicalJson(document()), "utf8").digest("hex"),
  );
  assert.match(verified.envelopeDigest, /^[a-f0-9]{64}$/);
  assert.equal(verified.keyId, "prk_release_0_5");
});

test("template mutation, identity replacement, unknown keys, revocation, and malformed supersession fail closed", () => {
  const { signer, privateKey, keys, now, envelope } = fixture();
  const changedPayload = payloadFrom(envelope.payload);
  changedPayload.document = {
    ...changedPayload.document as Record<string, unknown>,
    constraints: {
      ...(changedPayload.document as { constraints: Record<string, unknown> }).constraints,
      agents: { allow: ["hermes-claw"], deny: [] },
    },
  };
  const changedBytes = Buffer.from(canonicalJson(changedPayload), "utf8");
  const changedEnvelope = {
    ...envelope,
    payload: changedBytes.toString("base64url"),
    payloadDigest: createHash("sha256").update(changedBytes).digest("hex"),
  };
  assert.throws(
    () => verifyProtectedBaselineTemplate(changedEnvelope, keys, { now }),
    (error: unknown) => error instanceof ProtectedTemplateVerificationError
      && error.code === "PROTECTED_TEMPLATE_SIGNATURE_INVALID",
  );

  const changedDigest = createHash("sha256").update(changedBytes).digest();
  const correctlySignedDishonestHash = {
    ...changedEnvelope,
    signature: signBytes(null, Buffer.concat([
      Buffer.from("lemmacomputer/product-release/protected-baseline/signature/v1\0", "utf8"),
      Buffer.from(envelope.keyId, "utf8"),
      Buffer.from([0]),
      changedDigest,
    ]), privateKey).toString("base64url"),
  };
  assert.throws(
    () => verifyProtectedBaselineTemplate(correctlySignedDishonestHash, keys, { now }),
    (error: unknown) => error instanceof ProtectedTemplateVerificationError
      && error.code === "PROTECTED_TEMPLATE_DOCUMENT_HASH_INVALID",
  );

  const replacementPayload = payloadFrom(envelope.payload);
  replacementPayload.templateId = "pbt_admin_replacement";
  const replacementBytes = Buffer.from(canonicalJson(replacementPayload), "utf8");
  assert.throws(
    () => verifyProtectedBaselineTemplate({
      ...envelope,
      payload: replacementBytes.toString("base64url"),
      payloadDigest: createHash("sha256").update(replacementBytes).digest("hex"),
    }, keys, { now }),
    (error: unknown) => error instanceof ProtectedTemplateVerificationError
      && error.code === "PROTECTED_TEMPLATE_SIGNATURE_INVALID",
  );

  assert.throws(
    () => verifyProtectedBaselineTemplate(envelope, {
      ...keys,
      keys: keys.keys.map((key) => ({ ...key, keyId: "prk_unknown" })),
    }, { now }),
    (error: unknown) => error instanceof ProtectedTemplateVerificationError
      && error.code === "PROTECTED_TEMPLATE_KEY_UNKNOWN",
  );
  assert.throws(
    () => verifyProtectedBaselineTemplate(envelope, {
      ...keys,
      keys: keys.keys.map((key) => ({ ...key, status: "revoked" as const })),
    }, { now }),
    (error: unknown) => error instanceof ProtectedTemplateVerificationError
      && error.code === "PROTECTED_TEMPLATE_KEY_REVOKED",
  );
  assert.throws(
    () => verifyProtectedBaselineTemplate(envelope, {
      ...keys,
      keys: [
        ...keys.keys,
        { ...keys.keys[0]!, status: "revoked" as const },
      ],
    }, { now }),
    (error: unknown) => error instanceof ProtectedTemplateVerificationError
      && error.code === "PROTECTED_TEMPLATE_MALFORMED",
  );
  assert.throws(
    () => verifyProtectedBaselineTemplate(envelope, keys, { templateId: "pbt_another_template", now }),
    (error: unknown) => error instanceof ProtectedTemplateVerificationError
      && error.code === "PROTECTED_TEMPLATE_BINDING_MISMATCH",
  );
  assert.throws(
    () => verifyProtectedBaselineTemplate(envelope, keys, { minimumVersion: 2, now }),
    (error: unknown) => error instanceof ProtectedTemplateVerificationError
      && error.code === "PROTECTED_TEMPLATE_ROLLBACK_DETECTED",
  );
  assert.throws(
    () => signer.issue({
      templateId: "pbt_invalid_successor",
      templateVersionId: "pbtv_invalid_successor_2",
      version: 2,
      supersedesTemplateVersionId: null,
      release: {
        releaseId: "0.5.1",
        sourceCommit: "b".repeat(40),
        publishedAt: "2026-08-12T06:30:00.000Z",
      },
      document: document(),
    }),
    /supersede/i,
  );
});

const resolve = (verified: VerifiedProtectedBaselineTemplate, selection: Record<string, unknown> = {}) => (
  resolveProtectedBaselinePolicy({
    baseline: verified,
    organizationPolicy: {
      policyVersionId: "organization-policy-7",
      version: 7,
      documentHash: "b".repeat(64),
      constraints: {
        agents: { allow: ["claude-cli", "hermes-claw"], deny: [] },
        applications: { allow: ["firefox", "google-chrome"], deny: ["google-chrome"] },
        modelAliases: { allow: ["lemmacomputer-claude", "lemmacomputer-openai"], deny: ["lemmacomputer-openai"] },
        serviceClasses: { allow: ["balanced", "pro"], deny: [] },
        maximumReasoningEffort: "high",
        maximumEgressMode: "full-web",
        clipboard: { localToWorkspace: true, workspaceToLocal: true, maxBytes: 65_536 },
        connectors: {
          allow: ["microsoft-365", "linear"],
          deny: ["linear"],
          toolPolicies: {
            "microsoft-365": {
              "list-calendars": "allow",
              "send-mail": "allow",
              "delete-onedrive-file": "allow",
            },
          },
        },
        capabilities: { allow: ["ai-assistant", "m365-read", "m365-write-protected"], deny: ["m365-write-protected"] },
      },
    },
    connectorPolicies: [{
      connectorId: "microsoft-365",
      version: 4,
      documentHash: "c".repeat(64),
      enabled: true,
      toolPolicies: {
        "list-calendars": "allow",
        "send-mail": "allow",
        "delete-onedrive-file": "allow",
      },
    }],
    selection: {
      workspaceProfile: "claude-desktop-standard-v1",
      agentIds: ["claude-cli"],
      applicationIds: ["firefox"],
      modelAlias: "lemmacomputer-claude",
      serviceClass: "balanced",
      reasoningEffort: "medium",
      egressMode: "restricted",
      connectorIds: ["microsoft-365"],
      ...selection,
    },
  })
);

test("effective policy intersects allow lists, applies deny precedence, and keeps the strictest ceilings", () => {
  const { verified } = fixture();
  const effective = resolve(verified);

  assert.deepEqual(effective.allowed.agentIds, ["claude-cli"]);
  assert.deepEqual(effective.allowed.applicationIds, ["firefox"]);
  assert.deepEqual(effective.allowed.modelAliases, ["lemmacomputer-claude"]);
  assert.deepEqual(effective.allowed.serviceClasses, ["balanced", "pro"]);
  assert.deepEqual(effective.allowed.connectorIds, ["microsoft-365"]);
  assert.deepEqual(effective.allowed.capabilityIds, ["ai-assistant", "m365-read"]);
  assert.equal(effective.allowed.maximumReasoningEffort, "medium");
  assert.equal(effective.allowed.maximumEgressMode, "restricted");
  assert.deepEqual(effective.allowed.clipboard, {
    localToWorkspace: true,
    workspaceToLocal: false,
    maxBytes: 32_768,
  });
  assert.deepEqual(effective.allowed.connectorToolPolicies["microsoft-365"], {
    "delete-onedrive-file": "deny",
    "list-calendars": "allow",
    "send-mail": "approval_required",
  });
  assert.equal(effective.sources[0]?.kind, "protected_baseline");
  assert.equal(effective.sources[1]?.kind, "organization_policy");
  assert.equal(effective.sources[2]?.kind, "connector_policy");
  assert.match(effective.effectiveHash, /^[a-f0-9]{64}$/);
  assert.equal(resolve(verified).effectiveHash, effective.effectiveHash);
});

test("baseline-denied, organization-denied, over-ceiling, and unknown selections fail closed", () => {
  const { verified } = fixture();
  const rejected = [
    [{ agentIds: ["hermes-claw"] }, "POLICY_AGENT_DENIED"],
    [{ applicationIds: ["google-chrome"] }, "POLICY_APPLICATION_DENIED"],
    [{ modelAlias: "lemmacomputer-openai" }, "POLICY_MODEL_DENIED"],
    [{ connectorIds: ["linear"] }, "POLICY_CONNECTOR_DENIED"],
    [{ reasoningEffort: "high" }, "POLICY_REASONING_EFFORT_EXCEEDED"],
    [{ egressMode: "full-web" }, "POLICY_EGRESS_EXCEEDED"],
    [{ agentIds: ["future-agent"] }, "POLICY_INPUT_INVALID"],
    [{ connectorIds: ["unreviewed-connector"] }, "POLICY_CONNECTOR_DENIED"],
  ] as const;

  for (const [selection, code] of rejected) {
    assert.throws(
      () => resolve(verified, selection),
      (error: unknown) => error instanceof ProtectedPolicyResolutionError && error.code === code,
      `${JSON.stringify(selection)} should fail with ${code}`,
    );
  }
});

test("the resolver rejects structurally forged verification results", () => {
  const { verified } = fixture();

  assert.throws(
    () => resolve({ ...verified }),
    (error: unknown) => error instanceof ProtectedPolicyResolutionError
      && error.code === "POLICY_BASELINE_NOT_VERIFIED",
  );
});

test("unknown values in signed template documents are rejected before signing", () => {
  const { signer } = fixture();
  const invalid = document() as unknown as Record<string, unknown>;
  (invalid.constraints as { agents: { allow: string[] } }).agents.allow.push("future-agent");

  assert.throws(
    () => signer.issue({
      templateId: "pbt_unknown_agent",
      templateVersionId: "pbtv_unknown_agent_1",
      version: 1,
      supersedesTemplateVersionId: null,
      release: {
        releaseId: "0.5.0",
        sourceCommit: "d".repeat(40),
        publishedAt: "2026-08-12T05:30:00.000Z",
      },
      document: invalid as ProtectedBaselineTemplateDocument,
    }),
    /agent/i,
  );
});
