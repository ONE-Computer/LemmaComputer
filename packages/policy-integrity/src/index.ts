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
  connectorPolicyProjectionSchema,
  effectiveProtectedWorkspacePolicySchema,
  organizationWorkspacePolicySchema,
  ownedAgentCatalog,
  policyBundlePayloadSchema,
  policyVerificationKeySetSchema,
  productReleaseVerificationKeySetSchema,
  protectedBaselineTemplateDocumentSchema,
  protectedBaselineTemplatePayloadSchema,
  protectedPolicySelectionSchema,
  runtimePolicySchema,
  signedProtectedBaselineTemplateSchema,
  signedPolicyBundleSchema,
  workspaceReasoningEffortLevels,
  type ConnectorPolicyProjection,
  type EffectiveProtectedWorkspacePolicy,
  type IdentityContext,
  type McpToolPolicyDecision,
  type OrganizationWorkspacePolicy,
  type PolicyBundlePayload,
  type PolicyVerificationKey,
  type PolicyVerificationKeySet,
  type ProductReleaseVerificationKey,
  type ProductReleaseVerificationKeySet,
  type ProtectedBaselineTemplateDocument,
  type ProtectedBaselineTemplatePayload,
  type ProtectedPolicySelection,
  type RuntimePolicy,
  type SignedProtectedBaselineTemplate,
  type SignedPolicyBundle,
  type WorkspaceReasoningEffort,
} from "@lemmacomputer/contracts";

const SIGNATURE_DOMAIN = Buffer.from("lemmacomputer/effective-policy/signature/v1\0", "utf8");
const PAYLOAD_DIGEST_DOMAIN = Buffer.from("lemmacomputer/effective-policy/payload/v1\0", "utf8");
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
    } as const)[input.policy.agentProfile as Exclude<typeof input.policy.agentProfile, "lemmacomputer-default-agent">] ?? "claude-desktop";
    const selectedAgents = input.policy.agents ?? [{
      catalogId: fallbackCatalogId,
      agentId: input.policy.agentId,
    }];
    const payload = policyBundlePayloadSchema.parse({
      schemaVersion: 1,
      issuer: "lemmacomputer-control",
      audience: "lemmacomputer-policy-enforcement",
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
      profile: "lemmacomputer-effective-policy/v1",
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
    bundle.profile !== "lemmacomputer-effective-policy/v1"
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
    || expected.policy && !exactJsonEqual(payload.policy, runtimePolicySchema.parse(expected.policy))
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

const PRODUCT_TEMPLATE_SIGNATURE_DOMAIN = Buffer.from("lemmacomputer/product-release/protected-baseline/signature/v1\0", "utf8");
const PRODUCT_TEMPLATE_CLOCK_SKEW_MS = 30_000;
const verifiedProtectedTemplateBrand: unique symbol = Symbol("verifiedProtectedTemplate");

export type {
  ConnectorPolicyProjection,
  EffectiveProtectedWorkspacePolicy,
  OrganizationWorkspacePolicy,
  ProductReleaseVerificationKey,
  ProductReleaseVerificationKeySet,
  ProtectedBaselineTemplateDocument,
  ProtectedBaselineTemplatePayload,
  ProtectedPolicySelection,
  SignedProtectedBaselineTemplate,
  WorkspaceReasoningEffort,
};

export type ProtectedTemplateVerificationCode =
  | "PROTECTED_TEMPLATE_MALFORMED"
  | "PROTECTED_TEMPLATE_PROFILE_UNSUPPORTED"
  | "PROTECTED_TEMPLATE_KEY_UNKNOWN"
  | "PROTECTED_TEMPLATE_KEY_REVOKED"
  | "PROTECTED_TEMPLATE_KEY_EXPIRED"
  | "PROTECTED_TEMPLATE_KEY_NOT_ACTIVE"
  | "PROTECTED_TEMPLATE_PAYLOAD_NON_CANONICAL"
  | "PROTECTED_TEMPLATE_DIGEST_INVALID"
  | "PROTECTED_TEMPLATE_DOCUMENT_HASH_INVALID"
  | "PROTECTED_TEMPLATE_SIGNATURE_INVALID"
  | "PROTECTED_TEMPLATE_RELEASE_NOT_ACTIVE"
  | "PROTECTED_TEMPLATE_BINDING_MISMATCH"
  | "PROTECTED_TEMPLATE_ROLLBACK_DETECTED";

export class ProtectedTemplateVerificationError extends Error {
  constructor(readonly code: ProtectedTemplateVerificationCode, message: string) {
    super(message);
    this.name = "ProtectedTemplateVerificationError";
  }
}

export type VerifiedProtectedBaselineTemplate = {
  envelope: SignedProtectedBaselineTemplate;
  payload: ProtectedBaselineTemplatePayload;
  envelopeDigest: string;
  keyId: string;
  verifiedAt: string;
  readonly [verifiedProtectedTemplateBrand]: true;
};

const productTemplatePayloadDigest = (payload: Uint8Array) => sha256(payload);
const productTemplateDocumentHash = (document: ProtectedBaselineTemplateDocument) => (
  createHash("sha256").update(canonicalJson(document), "utf8").digest("hex")
);
const productTemplateSigningInput = (keyId: string, digest: Uint8Array) => Buffer.concat([
  PRODUCT_TEMPLATE_SIGNATURE_DOMAIN,
  Buffer.from(keyId, "utf8"),
  Buffer.from([0]),
  digest,
]);

const parseProductReleasePublicKey = (encoded: string) => {
  try {
    const key = createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("unexpected key type");
    return key;
  } catch {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_KEY_UNKNOWN", "The product release verification key is invalid");
  }
};

const productTemplateTimestamp = (input: string) => {
  const value = Date.parse(input);
  if (!Number.isFinite(value)) {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_MALFORMED", "The product release timestamp is malformed");
  }
  return value;
};

export class ProductReleaseTemplateSigner {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(private readonly config: {
    keyId: string;
    privateKeyPkcs8Base64: string;
    activatedAt?: Date;
    expiresAt?: Date | null;
  }) {
    if (!/^prk_[a-z0-9][a-z0-9_]{2,63}$/.test(config.keyId)) {
      throw new Error("Product release signing key id is invalid");
    }
    try {
      this.privateKey = createPrivateKey({
        key: Buffer.from(config.privateKeyPkcs8Base64, "base64"),
        format: "der",
        type: "pkcs8",
      });
    } catch {
      throw new Error("Product release signing private key is invalid");
    }
    if (this.privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Product release signing key must be Ed25519");
    }
    this.publicKey = createPublicKey(this.privateKey);
  }

  verificationKey(): Omit<ProductReleaseVerificationKey, "status"> {
    return {
      keyId: this.config.keyId,
      algorithm: "Ed25519",
      publicKeySpkiBase64: this.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      activatedAt: (this.config.activatedAt ?? new Date(0)).toISOString(),
      expiresAt: this.config.expiresAt?.toISOString() ?? null,
    };
  }

  issue(input: {
    templateId: string;
    templateVersionId: string;
    version: number;
    supersedesTemplateVersionId: string | null;
    release: ProtectedBaselineTemplatePayload["release"];
    document: ProtectedBaselineTemplateDocument;
  }): SignedProtectedBaselineTemplate {
    const document = protectedBaselineTemplateDocumentSchema.parse(input.document);
    const payload = protectedBaselineTemplatePayloadSchema.parse({
      schemaVersion: 1,
      issuer: "lemmacomputer-product-release",
      audience: "lemmacomputer-protected-baseline",
      templateId: input.templateId,
      templateVersionId: input.templateVersionId,
      version: input.version,
      supersedesTemplateVersionId: input.supersedesTemplateVersionId,
      release: input.release,
      documentHash: productTemplateDocumentHash(document),
      document,
    });
    const payloadBytes = Buffer.from(canonicalJson(payload), "utf8");
    const digest = productTemplatePayloadDigest(payloadBytes);
    return signedProtectedBaselineTemplateSchema.parse({
      profile: "lemmacomputer-protected-baseline-signature/v1",
      canonicalization: "RFC8785-JCS",
      algorithm: "Ed25519",
      keyId: this.config.keyId,
      payload: payloadBytes.toString("base64url"),
      payloadDigest: digest.toString("hex"),
      signature: signBytes(null, productTemplateSigningInput(this.config.keyId, digest), this.privateKey).toString("base64url"),
    });
  }
}

const decodeProductTemplatePayload = (envelope: SignedProtectedBaselineTemplate) => {
  let bytes: Buffer;
  let parsed: unknown;
  try {
    bytes = Buffer.from(envelope.payload, "base64url");
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_MALFORMED", "The protected template payload is malformed");
  }
  if (canonicalJson(parsed) !== bytes.toString("utf8")) {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_PAYLOAD_NON_CANONICAL", "The protected template payload is not canonical RFC8785 JSON");
  }
  try {
    return { bytes, payload: protectedBaselineTemplatePayloadSchema.parse(parsed) };
  } catch {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_MALFORMED", "The protected template payload has an unsupported schema");
  }
};

export function verifyProtectedBaselineTemplate(
  input: unknown,
  keySetInput: unknown,
  expected: {
    templateId?: string;
    templateVersionId?: string;
    minimumVersion?: number;
    now?: Date;
  } = {},
): VerifiedProtectedBaselineTemplate {
  let envelope: SignedProtectedBaselineTemplate;
  let keys: ProductReleaseVerificationKeySet;
  try {
    envelope = signedProtectedBaselineTemplateSchema.parse(input);
    keys = productReleaseVerificationKeySetSchema.parse(keySetInput);
  } catch {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_MALFORMED", "The signed protected template is malformed");
  }
  if (
    envelope.profile !== "lemmacomputer-protected-baseline-signature/v1"
    || envelope.canonicalization !== "RFC8785-JCS"
    || envelope.algorithm !== "Ed25519"
  ) {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_PROFILE_UNSUPPORTED", "The protected template signature profile is unsupported");
  }
  const key = keys.keys.find((candidate) => candidate.keyId === envelope.keyId);
  if (!key) throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_KEY_UNKNOWN", "The product release signing key is unknown");
  if (key.status === "revoked") throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_KEY_REVOKED", "The product release signing key is revoked");
  const now = expected.now ?? new Date();
  const nowMs = now.getTime();
  if (productTemplateTimestamp(key.activatedAt) > nowMs + PRODUCT_TEMPLATE_CLOCK_SKEW_MS) {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_KEY_NOT_ACTIVE", "The product release signing key is not active yet");
  }
  if (key.expiresAt && productTemplateTimestamp(key.expiresAt) <= nowMs) {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_KEY_EXPIRED", "The product release signing key has expired");
  }
  const { bytes, payload } = decodeProductTemplatePayload(envelope);
  const digest = productTemplatePayloadDigest(bytes);
  const receivedDigest = Buffer.from(envelope.payloadDigest, "hex");
  if (digest.length !== receivedDigest.length || !timingSafeEqual(digest, receivedDigest)) {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_DIGEST_INVALID", "The protected template payload digest is invalid");
  }
  if (!verifyBytes(
    null,
    productTemplateSigningInput(envelope.keyId, digest),
    parseProductReleasePublicKey(key.publicKeySpkiBase64),
    Buffer.from(envelope.signature, "base64url"),
  )) {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_SIGNATURE_INVALID", "The protected template signature is invalid");
  }
  const expectedDocumentHash = Buffer.from(productTemplateDocumentHash(payload.document), "hex");
  const receivedDocumentHash = Buffer.from(payload.documentHash, "hex");
  if (expectedDocumentHash.length !== receivedDocumentHash.length || !timingSafeEqual(expectedDocumentHash, receivedDocumentHash)) {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_DOCUMENT_HASH_INVALID", "The protected template document hash is invalid");
  }
  if (productTemplateTimestamp(payload.release.publishedAt) > nowMs + PRODUCT_TEMPLATE_CLOCK_SKEW_MS) {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_RELEASE_NOT_ACTIVE", "The protected template release is not active yet");
  }
  if (
    expected.templateId && payload.templateId !== expected.templateId
    || expected.templateVersionId && payload.templateVersionId !== expected.templateVersionId
  ) {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_BINDING_MISMATCH", "The protected template does not match its assigned identity");
  }
  if (expected.minimumVersion && payload.version < expected.minimumVersion) {
    throw new ProtectedTemplateVerificationError("PROTECTED_TEMPLATE_ROLLBACK_DETECTED", "The protected template is older than the enforced assignment");
  }
  const verified = {
    envelope,
    payload,
    envelopeDigest: createHash("sha256").update(canonicalJson(envelope), "utf8").digest("hex"),
    keyId: envelope.keyId,
    verifiedAt: now.toISOString(),
  } as VerifiedProtectedBaselineTemplate;
  Object.defineProperty(verified, verifiedProtectedTemplateBrand, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return verified;
}

export type ProtectedPolicyResolutionCode =
  | "POLICY_INPUT_INVALID"
  | "POLICY_BASELINE_NOT_VERIFIED"
  | "POLICY_WORKSPACE_PROFILE_DENIED"
  | "POLICY_AGENT_DENIED"
  | "POLICY_APPLICATION_DENIED"
  | "POLICY_MODEL_DENIED"
  | "POLICY_SERVICE_CLASS_DENIED"
  | "POLICY_CONNECTOR_DENIED"
  | "POLICY_REASONING_EFFORT_EXCEEDED"
  | "POLICY_EGRESS_EXCEEDED";

export class ProtectedPolicyResolutionError extends Error {
  constructor(readonly code: ProtectedPolicyResolutionCode, message: string) {
    super(message);
    this.name = "ProtectedPolicyResolutionError";
  }
}

export type ProtectedBaselineResolutionInput = {
  baseline: VerifiedProtectedBaselineTemplate;
  organizationPolicy?: OrganizationWorkspacePolicy | null;
  connectorPolicies: ConnectorPolicyProjection[];
  selection: ProtectedPolicySelection;
};

const constraintIntersection = <T extends string>(
  baseline: { allow: T[]; deny: T[] },
  overlay?: { allow?: T[]; deny: T[] },
) => baseline.allow.filter((value) => (
  !baseline.deny.includes(value)
  && !overlay?.deny.includes(value)
  && (!overlay?.allow || overlay.allow.includes(value))
));

const effortRank = (value: WorkspaceReasoningEffort) => workspaceReasoningEffortLevels.indexOf(value);
const stricterEffort = (left: WorkspaceReasoningEffort, right?: WorkspaceReasoningEffort) => (
  right && effortRank(right) < effortRank(left) ? right : left
);
const egressRank = (value: "restricted" | "full-web") => value === "restricted" ? 0 : 1;
const stricterEgress = (left: "restricted" | "full-web", right?: "restricted" | "full-web") => (
  right && egressRank(right) < egressRank(left) ? right : left
);
const toolDecisionRank = (decision: McpToolPolicyDecision) => ({ allow: 0, approval_required: 1, deny: 2 })[decision];
const strictestToolDecision = (decisions: McpToolPolicyDecision[]) => (
  decisions.reduce((strictest, decision) => toolDecisionRank(decision) > toolDecisionRank(strictest) ? decision : strictest)
);

const requireSelected = <T extends string>(selected: T[], allowed: T[], code: ProtectedPolicyResolutionCode, label: string) => {
  if (selected.some((value) => !allowed.includes(value))) {
    throw new ProtectedPolicyResolutionError(code, `The selected ${label} is denied by the effective protected policy`);
  }
};

export function resolveProtectedBaselinePolicy(input: ProtectedBaselineResolutionInput): EffectiveProtectedWorkspacePolicy {
  if (!input.baseline || input.baseline[verifiedProtectedTemplateBrand] !== true) {
    throw new ProtectedPolicyResolutionError("POLICY_BASELINE_NOT_VERIFIED", "A verified product-owned protected baseline is required");
  }
  let organizationPolicy: OrganizationWorkspacePolicy | undefined;
  let connectorPolicies: ConnectorPolicyProjection[];
  let selection: ProtectedPolicySelection;
  try {
    organizationPolicy = input.organizationPolicy
      ? organizationWorkspacePolicySchema.parse(input.organizationPolicy)
      : undefined;
    connectorPolicies = input.connectorPolicies.map((policy) => connectorPolicyProjectionSchema.parse(policy));
    selection = protectedPolicySelectionSchema.parse(input.selection);
    if (new Set(connectorPolicies.map((policy) => policy.connectorId)).size !== connectorPolicies.length) {
      throw new Error("duplicate connector policy");
    }
  } catch {
    throw new ProtectedPolicyResolutionError("POLICY_INPUT_INVALID", "The protected policy inputs contain an unknown, duplicate, or malformed value");
  }

  const baseline = input.baseline.payload.document.constraints;
  const overlay = organizationPolicy?.constraints;
  const workspaceProfileIds = constraintIntersection(baseline.workspaceProfiles, overlay?.workspaceProfiles);
  const agentIds = constraintIntersection(baseline.agents, overlay?.agents);
  const applicationIds = constraintIntersection(baseline.applications, overlay?.applications);
  const modelAliases = constraintIntersection(baseline.modelAliases, overlay?.modelAliases);
  const serviceClasses = constraintIntersection(baseline.serviceClasses, overlay?.serviceClasses);
  const capabilityIds = constraintIntersection(baseline.capabilities, overlay?.capabilities);
  const enabledConnectorIds = new Set(connectorPolicies.filter((policy) => policy.enabled).map((policy) => policy.connectorId));
  const connectorIds = constraintIntersection(baseline.connectors, overlay?.connectors)
    .filter((connectorId) => enabledConnectorIds.has(connectorId));
  const maximumReasoningEffort = stricterEffort(baseline.maximumReasoningEffort, overlay?.maximumReasoningEffort);
  const maximumEgressMode = stricterEgress(baseline.maximumEgressMode, overlay?.maximumEgressMode);
  const clipboard = {
    localToWorkspace: baseline.clipboard.localToWorkspace && (overlay?.clipboard?.localToWorkspace ?? true),
    workspaceToLocal: baseline.clipboard.workspaceToLocal && (overlay?.clipboard?.workspaceToLocal ?? true),
    maxBytes: Math.min(baseline.clipboard.maxBytes, overlay?.clipboard?.maxBytes ?? baseline.clipboard.maxBytes),
  };
  const connectorToolPolicies = Object.fromEntries(connectorIds.map((connectorId) => {
    const connector = connectorPolicies.find((policy) => policy.connectorId === connectorId)!;
    const baselineTools = baseline.connectors.toolPolicies[connectorId] ?? {};
    const organizationTools = overlay?.connectors?.toolPolicies[connectorId] ?? {};
    const decisions = Object.fromEntries(Object.entries(baselineTools).sort(([left], [right]) => left.localeCompare(right)).map(([toolName, baselineDecision]) => [
      toolName,
      strictestToolDecision([
        baselineDecision,
        ...(organizationTools[toolName] ? [organizationTools[toolName]] : []),
        connector.toolPolicies[toolName] ?? "deny",
      ]),
    ]));
    return [connectorId, decisions];
  }));

  requireSelected([selection.workspaceProfile], workspaceProfileIds, "POLICY_WORKSPACE_PROFILE_DENIED", "workspace profile");
  requireSelected(selection.agentIds, agentIds, "POLICY_AGENT_DENIED", "agent");
  requireSelected(selection.applicationIds, applicationIds, "POLICY_APPLICATION_DENIED", "application");
  requireSelected([selection.modelAlias], modelAliases, "POLICY_MODEL_DENIED", "model");
  requireSelected([selection.serviceClass], serviceClasses, "POLICY_SERVICE_CLASS_DENIED", "service class");
  requireSelected(selection.connectorIds, connectorIds, "POLICY_CONNECTOR_DENIED", "connector");
  if (effortRank(selection.reasoningEffort) > effortRank(maximumReasoningEffort)) {
    throw new ProtectedPolicyResolutionError("POLICY_REASONING_EFFORT_EXCEEDED", "The selected reasoning effort exceeds the protected maximum");
  }
  if (egressRank(selection.egressMode) > egressRank(maximumEgressMode)) {
    throw new ProtectedPolicyResolutionError("POLICY_EGRESS_EXCEEDED", "The selected egress mode exceeds the protected maximum");
  }

  const sources = [
    {
      kind: "protected_baseline" as const,
      sourceId: input.baseline.payload.templateVersionId,
      version: input.baseline.payload.version,
      documentHash: input.baseline.payload.documentHash,
      releaseId: input.baseline.payload.release.releaseId,
    },
    ...(organizationPolicy ? [{
      kind: "organization_policy" as const,
      sourceId: organizationPolicy.policyVersionId,
      version: organizationPolicy.version,
      documentHash: organizationPolicy.documentHash,
    }] : []),
    ...selection.connectorIds.map((connectorId) => {
      const connector = connectorPolicies.find((policy) => policy.connectorId === connectorId)!;
      return {
        kind: "connector_policy" as const,
        sourceId: connector.connectorId,
        version: connector.version,
        documentHash: connector.documentHash,
      };
    }),
  ];
  const draft = {
    schemaVersion: 1 as const,
    template: {
      templateId: input.baseline.payload.templateId,
      templateVersionId: input.baseline.payload.templateVersionId,
      version: input.baseline.payload.version,
      documentHash: input.baseline.payload.documentHash,
      envelopeDigest: input.baseline.envelopeDigest,
      release: input.baseline.payload.release,
    },
    allowed: {
      workspaceProfileIds,
      agentIds,
      applicationIds,
      modelAliases,
      serviceClasses,
      maximumReasoningEffort,
      maximumEgressMode,
      clipboard,
      connectorIds,
      connectorToolPolicies,
      capabilityIds,
    },
    selection,
    sources,
  };
  return effectiveProtectedWorkspacePolicySchema.parse({
    ...draft,
    effectiveHash: createHash("sha256").update(canonicalJson(draft), "utf8").digest("hex"),
  });
}
