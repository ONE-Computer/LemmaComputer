import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import {
  egressDecisionSchema,
  egressSecurityGroupVersionSchema,
  type EgressDecision,
  type EgressMode,
  type EgressProtocol,
  type RuntimeEgressPolicy,
  type EgressSecurityGroupVersion,
} from "@onecomputer/contracts";

export type CompiledEgressRule = {
  id: string;
  action: "allow" | "deny";
  protocol: EgressProtocol;
  host: string;
  includeSubdomains: boolean;
  port: number;
  purpose: string;
};

export type CompiledEgressSecurityGroup = {
  schemaVersion?: 1 | 2;
  mode?: "restricted";
  id: string;
  securityGroupId: string;
  tenantId?: string;
  version: number;
  name: string;
  defaultAction: "deny";
  documentHash: string;
  rules: CompiledEgressRule[];
};

export type CompiledFullWebPolicy = {
  schemaVersion: 2;
  mode: "full-web";
  id: string;
  securityGroupId: string;
  version: number;
  name: string;
  defaultAction: "allow-public-http-https";
  documentHash: string;
  rules: CompiledEgressRule[];
};

export type CompiledEgressPolicy = CompiledEgressSecurityGroup | CompiledFullWebPolicy;

export type EgressConnection = {
  protocol: EgressProtocol;
  host: string;
  port: number;
  resolvedAddresses: string[];
};

/** A resolver must return every A and AAAA answer it received for the hostname. */
export type PublicHttpsTargetResolver = (hostname: string) => Promise<ReadonlyArray<{
  address: string;
  family: 4 | 6;
}>>;

export type PublicHttpsTargetValidationOptions = {
  /**
   * Override DNS lookup for tests or a controlled resolver. The default uses
   * the host resolver and asks for all A and AAAA answers without reordering.
   */
  resolveHostname?: PublicHttpsTargetResolver;
  /**
   * Optional destination policy. Without one, the candidate host and port are
   * evaluated as an exact, deny-by-default HTTPS rule solely to prove that the
   * address is public. Callers with an approval allowlist should supply it.
   */
  policy?: CompiledEgressPolicy;
};

export type ValidatedPublicHttpsTarget = {
  canonicalUrl: string;
  origin: string;
  host: string;
  port: number;
  resolvedAddresses: string[];
  decision: EgressDecision;
};

export type PublicHttpsTargetValidationReason =
  | "EGRESS_INVALID_URL"
  | "EGRESS_HTTPS_REQUIRED"
  | "EGRESS_URL_CREDENTIALS_DENIED"
  | "EGRESS_URL_FRAGMENT_DENIED"
  | EgressDecision["reasonCode"];

export class PublicHttpsTargetValidationError extends Error {
  constructor(
    message: string,
    readonly reasonCode: PublicHttpsTargetValidationReason,
    readonly decision?: EgressDecision,
  ) {
    super(message);
    this.name = "PublicHttpsTargetValidationError";
  }
}

export type EgressProxyGrantClaims = {
  aud: "onecomputer-egress-proxy";
  tenantId: string;
  subjectId: string;
  workspaceId: string;
  agentId: string;
  securityGroupVersionId: string;
  egressMode: EgressMode;
  policyHash: string;
  iat: number;
  exp: number;
  jti: string;
};

export type EgressProxyGrantExpectation = Pick<
  EgressProxyGrantClaims,
  "tenantId" | "subjectId" | "workspaceId" | "agentId"
> & Partial<Pick<
  EgressProxyGrantClaims,
  "securityGroupVersionId" | "egressMode" | "policyHash"
>>;

const encode = (value: string | Buffer) => Buffer.from(value).toString("base64url");
const sign = (value: string, secret: string) => encode(createHmac("sha256", secret).update(value).digest());

export function deriveEgressProxySecret(rootSecret: string, workspaceId: string) {
  if (rootSecret.length < 32) throw new Error("Egress proxy root secret must be at least 32 characters");
  return createHmac("sha256", rootSecret).update(`onecomputer-egress-proxy\0${workspaceId}`).digest("base64url");
}

export function issueEgressProxyGrant(
  secret: string,
  claims: Omit<EgressProxyGrantClaims, "aud" | "iat" | "exp" | "jti">,
  now = new Date(),
  ttlSeconds = 86_400,
) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload: EgressProxyGrantClaims = {
    aud: "onecomputer-egress-proxy",
    ...claims,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    jti: randomUUID(),
  };
  const encoded = encode(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyEgressProxyGrant(
  token: string,
  secret: string,
  expected: EgressProxyGrantExpectation,
  now = new Date(),
) {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(sign(encoded, secret));
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return null;
  let claims: EgressProxyGrantClaims;
  try {
    claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as EgressProxyGrantClaims;
  } catch {
    return null;
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    claims.aud !== "onecomputer-egress-proxy"
    || !Number.isInteger(claims.iat)
    || !Number.isInteger(claims.exp)
    || claims.iat > nowSeconds + 30
    || claims.exp <= nowSeconds
    || !claims.jti
    || Object.entries(expected).some(([key, value]) => claims[key as keyof EgressProxyGrantClaims] !== value)
  ) return null;
  return claims;
}

export class EgressHostError extends Error {
  constructor(
    message: string,
    readonly reasonCode: "EGRESS_INVALID_HOST" | "EGRESS_IP_LITERAL_DENIED",
  ) {
    super(message);
    this.name = "EgressHostError";
  }
}

export function normalizeEgressHost(input: string) {
  if (!input || input !== input.trim()) {
    throw new EgressHostError("Egress host must not contain surrounding whitespace", "EGRESS_INVALID_HOST");
  }
  if (input.includes("*")) {
    throw new EgressHostError("Wildcard egress hosts are not allowed", "EGRESS_INVALID_HOST");
  }
  const unbracketed = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  if (isIP(unbracketed)) {
    throw new EgressHostError("IP literal egress destinations are not allowed", "EGRESS_IP_LITERAL_DENIED");
  }
  if (input.endsWith("..")) {
    throw new EgressHostError("Egress host has an invalid trailing label", "EGRESS_INVALID_HOST");
  }
  const withoutRootDot = input.endsWith(".") ? input.slice(0, -1) : input;
  const normalized = domainToASCII(withoutRootDot).toLowerCase();
  if (!normalized || normalized.length > 253 || !normalized.includes(".")) {
    throw new EgressHostError("Egress host must be a fully qualified domain name", "EGRESS_INVALID_HOST");
  }
  const labels = normalized.split(".");
  if (labels.some((label) => (
    !label
    || label.length > 63
    || !/^[a-z0-9-]+$/.test(label)
    || label.startsWith("-")
    || label.endsWith("-")
  ))) {
    throw new EgressHostError("Egress host contains an invalid label", "EGRESS_INVALID_HOST");
  }
  return normalized;
}

export function compileEgressSecurityGroup(input: EgressSecurityGroupVersion): CompiledEgressPolicy {
  const group = egressSecurityGroupVersionSchema.parse(input);
  const rules = group.rules.map((rule) => ({
    ...rule,
    host: normalizeEgressHost(rule.host),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const identities = new Set<string>();
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new Error(`Duplicate egress rule id: ${rule.id}`);
    ids.add(rule.id);
    const identity = `${rule.protocol}\0${rule.host}\0${rule.includeSubdomains}\0${rule.port}`;
    if (identities.has(identity)) throw new Error(`Duplicate egress rule destination: ${rule.id}`);
    identities.add(identity);
  }
  const compiled = {
    id: group.id,
    securityGroupId: group.securityGroupId,
    tenantId: group.tenantId,
    version: group.version,
    name: group.name,
    documentHash: group.documentHash,
    rules,
  };
  return group.defaultAction === "allow-public-http-https"
    ? { ...compiled, schemaVersion: 2, mode: "full-web", defaultAction: "allow-public-http-https" }
    : { ...compiled, defaultAction: "deny" };
}

export function compileRuntimeEgressPolicy(input: RuntimeEgressPolicy): CompiledEgressPolicy {
  const rules = input.rules.map((rule) => ({
    ...rule,
    host: normalizeEgressHost(rule.host),
  })).sort((left, right) => left.id.localeCompare(right.id));
  return { ...input, rules };
}

const isReservedIpv4 = (address: string) => {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  );
};

export function isReservedAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return isReservedIpv4(address);
  if (version !== 6) return true;
  const normalized = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isReservedIpv4(mapped[1]!);

  const ipv6Value = (input: string) => {
    const withExpandedIpv4 = input.includes(".")
      ? input.replace(/(\d+\.\d+\.\d+\.\d+)$/, (literal) => {
        const octets = literal.split(".").map(Number);
        return `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
      })
      : input;
    const halves = withExpandedIpv4.split("::");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const groups = halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left;
    return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group || "0"}`), 0n);
  };
  const value = ipv6Value(normalized);
  const inCidr = (base: string, prefix: number) => {
    const shift = BigInt(128 - prefix);
    return (value >> shift) === (ipv6Value(base) >> shift);
  };

  // Public IPv6 is currently allocated from 2000::/3. Deny the IETF special,
  // transition, benchmarking, and documentation sub-ranges within it too.
  return (
    !inCidr("2000::", 3)
    || inCidr("2001::", 23)
    || inCidr("2001:db8::", 32)
    || inCidr("2002::", 16)
    || inCidr("3fff::", 20)
  );
}

const deny = (reasonCode: EgressDecision["reasonCode"]) => egressDecisionSchema.parse({
  decision: "deny",
  reasonCode,
});

export function decideEgress(
  policy: CompiledEgressPolicy,
  connection: EgressConnection,
): EgressDecision {
  let host: string;
  try {
    host = normalizeEgressHost(connection.host);
  } catch (error) {
    if (error instanceof EgressHostError) return deny(error.reasonCode);
    return deny("EGRESS_INVALID_HOST");
  }
  if (!connection.resolvedAddresses.length) return deny("EGRESS_DNS_UNAVAILABLE");
  if (connection.resolvedAddresses.some(isReservedAddress)) return deny("EGRESS_DESTINATION_RESERVED");
  const matchingRules = policy.rules.filter((candidate) => (
    candidate.protocol === connection.protocol
    && candidate.port === connection.port
    && (
      host === candidate.host
      || (candidate.includeSubdomains && host.endsWith(`.${candidate.host}`))
    )
  ));
  const deniedByRule = matchingRules.find((candidate) => candidate.action === "deny");
  if (deniedByRule) {
    return egressDecisionSchema.parse({
      decision: "deny",
      reasonCode: "EGRESS_EXPLICIT_DENY",
      ruleId: deniedByRule.id,
    });
  }
  if (policy.mode === "full-web") {
    const standardPort = (connection.protocol === "http" && connection.port === 80)
      || (connection.protocol === "https" && connection.port === 443);
    return standardPort
      ? egressDecisionSchema.parse({ decision: "allow", reasonCode: "EGRESS_ALLOWED" })
      : deny("EGRESS_DEFAULT_DENY");
  }
  const rule = matchingRules.find((candidate) => candidate.action === "allow");
  return rule
    ? egressDecisionSchema.parse({ decision: "allow", reasonCode: "EGRESS_ALLOWED", ruleId: rule.id })
    : deny("EGRESS_DEFAULT_DENY");
}

const defaultPublicHttpsTargetResolver: PublicHttpsTargetResolver = async (hostname) => {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

const exactPublicHttpsEndpointPolicy = (host: string, port: number): CompiledEgressSecurityGroup => ({
  id: "egress_public_https_endpoint_validation",
  securityGroupId: "egress_public_https_endpoint_validation",
  version: 1,
  name: "Public HTTPS endpoint validation",
  defaultAction: "deny",
  documentHash: "0".repeat(64),
  rules: [{
    id: "candidate-public-https-endpoint",
    action: "allow",
    protocol: "https",
    host,
    includeSubdomains: false,
    port,
    purpose: "Validate an exact public HTTPS endpoint candidate",
  }],
});

const invalidTarget = (message: string, reasonCode: PublicHttpsTargetValidationReason) => (
  new PublicHttpsTargetValidationError(message, reasonCode)
);

/**
 * Parses and resolves an externally supplied HTTPS endpoint before admission.
 *
 * This is intentionally a validation primitive, not a complete SSRF boundary:
 * a caller that subsequently connects must either pin the returned address or
 * send the connection through an egress proxy that resolves and validates each
 * hop again. That prevents DNS changes after this check from changing the
 * destination.
 */
export async function validatePublicHttpsTarget(
  endpointUrl: string,
  options: PublicHttpsTargetValidationOptions = {},
): Promise<ValidatedPublicHttpsTarget> {
  if (typeof endpointUrl !== "string" || !endpointUrl || endpointUrl !== endpointUrl.trim()) {
    throw invalidTarget("Endpoint URL must be a non-empty URL without surrounding whitespace", "EGRESS_INVALID_URL");
  }

  let url: URL;
  try {
    url = new URL(endpointUrl);
  } catch {
    throw invalidTarget("Endpoint URL is invalid", "EGRESS_INVALID_URL");
  }
  if (url.protocol !== "https:") {
    throw invalidTarget("Endpoint URL must use HTTPS", "EGRESS_HTTPS_REQUIRED");
  }
  if (url.username || url.password) {
    throw invalidTarget("Endpoint URL credentials are not allowed", "EGRESS_URL_CREDENTIALS_DENIED");
  }
  // URL.hash is empty for a trailing bare '#', so check the source too.
  if (url.hash || endpointUrl.includes("#")) {
    throw invalidTarget("Endpoint URL fragments are not allowed", "EGRESS_URL_FRAGMENT_DENIED");
  }

  let host: string;
  try {
    host = normalizeEgressHost(url.hostname);
  } catch (error) {
    if (error instanceof EgressHostError) {
      throw invalidTarget(error.message, error.reasonCode);
    }
    throw invalidTarget("Endpoint hostname is invalid", "EGRESS_INVALID_HOST");
  }
  const port = url.port ? Number(url.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw invalidTarget("Endpoint URL has an invalid port", "EGRESS_INVALID_URL");
  }

  const resolver = options.resolveHostname ?? defaultPublicHttpsTargetResolver;
  let answers: ReadonlyArray<{ address: string; family: 4 | 6 }>;
  try {
    answers = await resolver(host);
  } catch {
    throw invalidTarget("Endpoint hostname could not be resolved", "EGRESS_DNS_UNAVAILABLE");
  }
  if (
    !Array.isArray(answers)
    || answers.some((answer) => (
      !answer
      || (answer.family !== 4 && answer.family !== 6)
      || typeof answer.address !== "string"
      || isIP(answer.address) !== answer.family
    ))
  ) {
    throw invalidTarget("Endpoint hostname returned an invalid DNS answer", "EGRESS_DNS_UNAVAILABLE");
  }
  const resolvedAddresses = answers.map((answer) => answer.address);

  const decision = decideEgress(
    options.policy ?? exactPublicHttpsEndpointPolicy(host, port),
    { protocol: "https", host, port, resolvedAddresses },
  );
  if (decision.decision !== "allow") {
    throw new PublicHttpsTargetValidationError(
      "Endpoint URL is not an allowed public HTTPS destination",
      decision.reasonCode,
      decision,
    );
  }

  url.hostname = host;
  url.port = port === 443 ? "" : String(port);
  return {
    canonicalUrl: url.toString(),
    origin: url.origin,
    host,
    port,
    resolvedAddresses,
    decision,
  };
}
