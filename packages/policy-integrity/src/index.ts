import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";
import {
  canonicalJson,
  ownedAgentCatalog,
  policyBundlePayloadSchema,
  policyVerificationKeySetSchema,
  signedPolicyBundleSchema,
  type IdentityContext,
  type PolicyBundlePayload,
  type PolicyVerificationKey,
  type PolicyVerificationKeySet,
  type RuntimePolicy,
  type SignedPolicyBundle,
} from "@onecomputer/contracts";

const SIGNATURE_DOMAIN = Buffer.from("onecomputer/effective-policy/signature/v1\0", "utf8");
const PAYLOAD_DIGEST_DOMAIN = Buffer.from("onecomputer/effective-policy/payload/v1\0", "utf8");
const CLOCK_SKEW_MS = 30_000;

export type { PolicyBundlePayload, PolicyVerificationKey, PolicyVerificationKeySet, SignedPolicyBundle };

export type PolicyVerificationCode =
  | "POLICY_BUNDLE_MALFORMED"
  | "POLICY_PROFILE_UNSUPPORTED"
  | "POLICY_KEY_UNKNOWN"
  | "POLICY_KEY_REVOKED"
  | "POLICY_KEY_EXPIRED"
  | "POLICY_PAYLOAD_NON_CANONICAL"
  | "POLICY_DIGEST_INVALID"
  | "POLICY_SIGNATURE_INVALID"
  | "POLICY_NOT_YET_VALID"
  | "POLICY_EXPIRED"
  | "POLICY_BINDING_MISMATCH"
  | "POLICY_ROLLBACK_DETECTED";

export class PolicyVerificationError extends Error {
  constructor(readonly code: PolicyVerificationCode, message: string) {
    super(message);
    this.name = "PolicyVerificationError";
  }
}

export type VerifiedPolicyBundle = {
  bundle: SignedPolicyBundle;
  payload: PolicyBundlePayload;
  bundleDigest: string;
  keyId: string;
  verifiedAt: string;
};

const sha256 = (input: Uint8Array | string) => createHash("sha256").update(input).digest();
const payloadDigest = (payload: Uint8Array) => sha256(Buffer.concat([PAYLOAD_DIGEST_DOMAIN, payload]));
const signingInput = (keyId: string, digest: Uint8Array) =>
  Buffer.concat([SIGNATURE_DOMAIN, Buffer.from(keyId, "utf8"), Buffer.from([0]), digest]);

const exactJsonEqual = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

const decodePayload = (bundle: SignedPolicyBundle) => {
  let bytes: Buffer;
  let parsed: unknown;
  try {
    bytes = Buffer.from(bundle.payload, "base64url");
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PolicyVerificationError("POLICY_BUNDLE_MALFORMED", "The signed policy payload is malformed");
  }
  if (canonicalJson(parsed) !== bytes.toString("utf8")) {
    throw new PolicyVerificationError("POLICY_PAYLOAD_NON_CANONICAL", "The signed policy payload is not canonical RFC8785 JSON");
  }
  try {
    return { bytes, payload: policyBundlePayloadSchema.parse(parsed) };
  } catch {
    throw new PolicyVerificationError("POLICY_BUNDLE_MALFORMED", "The signed policy payload has an unsupported schema");
  }
};

const parsePublicKey = (encoded: string) => {
  try {
    const key = createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("unexpected key type");
    return key;
  } catch {
    throw new PolicyVerificationError("POLICY_KEY_UNKNOWN", "The policy verification key is invalid");
  }
};

const timestamp = (input: string) => {
  const value = Date.parse(input);
  if (!Number.isFinite(value)) throw new PolicyVerificationError("POLICY_BUNDLE_MALFORMED", "The policy validity window is malformed");
  return value;
};

export class PolicyBundleSigner {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(private readonly config: {
    keyId: string;
    privateKeyPkcs8Base64: string;
    activatedAt?: Date;
    expiresAt?: Date | null;
  }) {
    if (!/^psk_[a-z0-9][a-z0-9_-]{2,63}$/.test(config.keyId)) {
      throw new Error("Policy signing key id is invalid");
    }
    try {
      this.privateKey = createPrivateKey({
        key: Buffer.from(config.privateKeyPkcs8Base64, "base64"),
        format: "der",
        type: "pkcs8",
      });
    } catch {
      throw new Error("Policy signing private key is invalid");
    }
    if (this.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Policy signing key must be Ed25519");
    this.publicKey = createPublicKey(this.privateKey);
  }

  verificationKey(): Omit<PolicyVerificationKey, "status"> {
    return {
      keyId: this.config.keyId,
      algorithm: "Ed25519",
      publicKeySpkiBase64: this.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      activatedAt: (this.config.activatedAt ?? new Date(0)).toISOString(),
      expiresAt: this.config.expiresAt?.toISOString() ?? null,
    };
  }

  issue(input: {
    identity: IdentityContext;
    workspaceId: string;
    policy: RuntimePolicy;
    routes: PolicyBundlePayload["routes"];
    now?: Date;
    ttlSeconds?: number;
  }): SignedPolicyBundle {
    const now = input.now ?? new Date();
    const ttlSeconds = input.ttlSeconds ?? 15 * 60;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400) {
      throw new Error("Policy bundle lifetime must be between 60 and 86400 seconds");
    }
    const fallbackCatalogId = ({
      "claude-desktop-managed-v1": "claude-desktop",
      "claude-cli-managed-v1": "claude-cli",
      "codex-cli-managed-v1": "codex-cli",
      "hermes-desktop-managed-v1": "hermes-desktop",
      "hermes-claw-managed-v1": "hermes-claw",
    } as const)[input.policy.agentProfile as Exclude<typeof input.policy.agentProfile, "onecomputer-default-agent">] ?? "claude-desktop";
    const selectedAgents = input.policy.agents ?? [{
      catalogId: fallbackCatalogId,
      agentId: input.policy.agentId,
    }];
    const payload = policyBundlePayloadSchema.parse({
      schemaVersion: 1,
      issuer: "onecomputer-control",
      audience: "onecomputer-policy-enforcement",
      tenantId: input.identity.tenantId,
      subjectId: input.identity.subjectId,
      workspaceId: input.workspaceId,
      policy: input.policy,
      routes: input.routes,
      agentResources: selectedAgents.map((agent) => {
        const catalog = ownedAgentCatalog.find((entry) => entry.id === agent.catalogId);
        if (!catalog) throw new Error(`Unknown policy agent: ${agent.catalogId}`);
        return {
          catalogId: agent.catalogId,
          agentId: agent.agentId,
          memoryMiB: catalog.resources.memoryMiB,
        };
      }),
      issuedAt: now.toISOString(),
      notBefore: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    });
    const payloadBytes = Buffer.from(canonicalJson(payload), "utf8");
    const digest = payloadDigest(payloadBytes);
    return signedPolicyBundleSchema.parse({
      profile: "onecomputer-effective-policy/v1",
      canonicalization: "RFC8785-JCS",
      algorithm: "Ed25519",
      keyId: this.config.keyId,
      payload: payloadBytes.toString("base64url"),
      payloadDigest: digest.toString("hex"),
      signature: signBytes(null, signingInput(this.config.keyId, digest), this.privateKey).toString("base64url"),
    });
  }
}

export function verifySignedPolicyBundle(
  input: unknown,
  keySetInput: unknown,
  expected: {
    identity?: IdentityContext;
    workspaceId?: string;
    policy?: RuntimePolicy;
    minimumPolicyVersion?: number;
    now?: Date;
  } = {},
): VerifiedPolicyBundle {
  let bundle: SignedPolicyBundle;
  let keys: PolicyVerificationKeySet;
  try {
    bundle = signedPolicyBundleSchema.parse(input);
    keys = policyVerificationKeySetSchema.parse(keySetInput);
  } catch {
    throw new PolicyVerificationError("POLICY_BUNDLE_MALFORMED", "The signed policy bundle is malformed");
  }
  if (
    bundle.profile !== "onecomputer-effective-policy/v1"
    || bundle.canonicalization !== "RFC8785-JCS"
    || bundle.algorithm !== "Ed25519"
  ) {
    throw new PolicyVerificationError("POLICY_PROFILE_UNSUPPORTED", "The policy signature profile is unsupported");
  }
  const key = keys.keys.find((candidate) => candidate.keyId === bundle.keyId);
  if (!key) throw new PolicyVerificationError("POLICY_KEY_UNKNOWN", "The policy signing key is unknown");
  if (key.status === "revoked") throw new PolicyVerificationError("POLICY_KEY_REVOKED", "The policy signing key is revoked");
  const now = expected.now ?? new Date();
  const nowMs = now.getTime();
  if (timestamp(key.activatedAt) > nowMs + CLOCK_SKEW_MS) {
    throw new PolicyVerificationError("POLICY_NOT_YET_VALID", "The policy signing key is not active yet");
  }
  if (key.expiresAt && timestamp(key.expiresAt) <= nowMs) {
    throw new PolicyVerificationError("POLICY_KEY_EXPIRED", "The policy signing key has expired");
  }

  const { bytes, payload } = decodePayload(bundle);
  const digest = payloadDigest(bytes);
  const receivedDigest = Buffer.from(bundle.payloadDigest, "hex");
  if (digest.length !== receivedDigest.length || !timingSafeEqual(digest, receivedDigest)) {
    throw new PolicyVerificationError("POLICY_DIGEST_INVALID", "The policy payload digest is invalid");
  }
  const signature = Buffer.from(bundle.signature, "base64url");
  if (!verifyBytes(null, signingInput(bundle.keyId, digest), parsePublicKey(key.publicKeySpkiBase64), signature)) {
    throw new PolicyVerificationError("POLICY_SIGNATURE_INVALID", "The policy signature is invalid");
  }
  if (timestamp(payload.notBefore) > nowMs + CLOCK_SKEW_MS || timestamp(payload.issuedAt) > nowMs + CLOCK_SKEW_MS) {
    throw new PolicyVerificationError("POLICY_NOT_YET_VALID", "The signed policy is not valid yet");
  }
  if (timestamp(payload.expiresAt) <= nowMs) {
    throw new PolicyVerificationError("POLICY_EXPIRED", "The signed policy has expired");
  }
  if (
    expected.identity && (
      payload.tenantId !== expected.identity.tenantId
      || payload.subjectId !== expected.identity.subjectId
    )
    || expected.workspaceId && payload.workspaceId !== expected.workspaceId
    || expected.policy && !exactJsonEqual(payload.policy, expected.policy)
  ) {
    throw new PolicyVerificationError("POLICY_BINDING_MISMATCH", "The signed policy does not match its enforcement boundary");
  }
  if (expected.minimumPolicyVersion && payload.policy.policyVersion < expected.minimumPolicyVersion) {
    throw new PolicyVerificationError("POLICY_ROLLBACK_DETECTED", "The signed policy is older than the enforced assignment");
  }
  return {
    bundle,
    payload,
    bundleDigest: createHash("sha256").update(canonicalJson(bundle), "utf8").digest("hex"),
    keyId: bundle.keyId,
    verifiedAt: now.toISOString(),
  };
}
