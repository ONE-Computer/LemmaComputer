import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { LemmaComputerError, type IdentityContext, type RuntimePolicy } from "@lemmacomputer/contracts";
import { z } from "zod";

export const agentBridgeAudience = "lemmacomputer-control-agent-bridge";
export const agentBridgeScopes = [
  "agent:usage-bindings",
  "agent:mcp-discovery",
  "agent:sites",
  "agent:operations:read",
  "agent:uploads",
  "agent:deletions",
  "agent:renew",
  "agent:instances",
  "agent:tool-audit",
] as const;

export type AgentBridgeScope = typeof agentBridgeScopes[number];

const scopeSchema = z.enum(agentBridgeScopes);
const payloadSchema = z.strictObject({
  version: z.literal(2),
  aud: z.literal(agentBridgeAudience),
  tenantId: z.string().min(1).max(128),
  subjectId: z.string().min(1).max(128),
  workspaceId: z.uuid(),
  workspaceGeneration: z.number().int().positive(),
  agentId: z.string().min(1).max(128),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z.array(scopeSchema).min(1).max(agentBridgeScopes.length).refine(
    (scopes) => new Set(scopes).size === scopes.length,
    "Agent bridge scopes must be unique",
  ),
  jti: z.uuid(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
}).refine((payload) => payload.exp > payload.iat, "Agent bridge grant expiry must follow issuance");

type AgentBridgePayload = z.infer<typeof payloadSchema>;

export type AgentBridgeIdentity = {
  version: 2;
  audience: typeof agentBridgeAudience;
  tenantId: string;
  subjectId: string;
  workspaceId: string;
  workspaceGeneration: number;
  agentId: string;
  policyHash: string;
  scopes: AgentBridgeScope[];
  jti: string;
  issuedAt: number;
  expiresAt: number;
};

type IssueOptions = {
  workspaceGeneration: number;
  scopes?: AgentBridgeScope[];
  now?: Date;
};

type VerifyOptions = {
  audience?: string;
  scope?: AgentBridgeScope;
  now?: Date;
};

const epochSeconds = (now: Date) => Math.floor(now.getTime() / 1_000);
const unauthenticated = (code = "UNAUTHENTICATED", message = "Agent bridge authentication is invalid") => (
  new LemmaComputerError(code, message, 401)
);

const toIdentity = (payload: AgentBridgePayload): AgentBridgeIdentity => ({
  version: payload.version,
  audience: payload.aud,
  tenantId: payload.tenantId,
  subjectId: payload.subjectId,
  workspaceId: payload.workspaceId,
  workspaceGeneration: payload.workspaceGeneration,
  agentId: payload.agentId,
  policyHash: payload.policyHash,
  scopes: [...payload.scopes],
  jti: payload.jti,
  issuedAt: payload.iat,
  expiresAt: payload.exp,
});

export class AgentBridgeAuthority {
  constructor(private readonly secret: string, private readonly ttlSeconds = 15 * 60) {
    if (secret.length < 32) throw new Error("Agent bridge secret must be at least 32 characters");
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3_600) {
      throw new Error("Agent bridge grant TTL must be between 60 and 3600 seconds");
    }
  }

  issue(identity: IdentityContext, workspaceId: string, policy: RuntimePolicy, options: IssueOptions) {
    const now = options.now ?? new Date();
    return this.encode({
      version: 2,
      aud: agentBridgeAudience,
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      workspaceId,
      workspaceGeneration: options.workspaceGeneration,
      agentId: policy.agentId,
      policyHash: policy.policyHash,
      scopes: options.scopes ?? [...agentBridgeScopes],
      jti: randomUUID(),
      iat: epochSeconds(now),
      exp: epochSeconds(now) + this.ttlSeconds,
    });
  }

  renew(grant: AgentBridgeIdentity, options: Pick<IssueOptions, "now"> = {}) {
    const now = options.now ?? new Date();
    return this.encode({
      version: 2,
      aud: agentBridgeAudience,
      tenantId: grant.tenantId,
      subjectId: grant.subjectId,
      workspaceId: grant.workspaceId,
      workspaceGeneration: grant.workspaceGeneration,
      agentId: grant.agentId,
      policyHash: grant.policyHash,
      scopes: grant.scopes,
      jti: randomUUID(),
      iat: epochSeconds(now),
      exp: epochSeconds(now) + this.ttlSeconds,
    });
  }

  verify(token: string, options: VerifyOptions = {}): AgentBridgeIdentity {
    const match = /^ocab2_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) throw unauthenticated("UNAUTHENTICATED", "Agent bridge authentication is required");
    const expected = Buffer.from(this.sign(match[1]!));
    const received = Buffer.from(match[2]!);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw unauthenticated();
    }
    let payload: AgentBridgePayload;
    try {
      payload = payloadSchema.parse(JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")));
    } catch {
      throw unauthenticated();
    }
    const now = epochSeconds(options.now ?? new Date());
    if (payload.exp <= now) {
      throw unauthenticated("AGENT_BRIDGE_GRANT_EXPIRED", "Agent bridge authentication has expired");
    }
    if (payload.aud !== (options.audience ?? agentBridgeAudience)) {
      throw unauthenticated("AGENT_BRIDGE_GRANT_AUDIENCE_INVALID", "Agent bridge authentication is not intended for this service");
    }
    if (options.scope && !payload.scopes.includes(options.scope)) {
      throw new LemmaComputerError("AGENT_BRIDGE_GRANT_SCOPE_DENIED", "Agent bridge authentication is not authorized for this endpoint", 403);
    }
    return toIdentity(payload);
  }

  private encode(payload: AgentBridgePayload) {
    const parsed = payloadSchema.parse(payload);
    const encoded = Buffer.from(JSON.stringify(parsed)).toString("base64url");
    return `ocab2_${encoded}.${this.sign(encoded)}`;
  }

  private sign(payload: string) {
    return createHmac("sha256", this.secret).update(`lemmacomputer:agent-bridge:v2:${payload}`).digest("base64url");
  }
}
