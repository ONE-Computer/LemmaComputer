import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IdentityContext } from "@onecomputer/contracts";

export const workspaceIngressAccessParameter = "oc_workspace_access";
export const workspaceIngressSessionCookie = "onecomputer_workspace_session";

export type WorkspaceIngressTarget = {
  protocol: "http" | "https";
  host: string;
  port: number;
};

export type WorkspaceIngressClaims = WorkspaceIngressTarget & {
  version: 1;
  kind: "launch" | "session";
  tenantId: string;
  subjectId: string;
  workspaceId: string;
  issuedAt: number;
  expiresAt: number;
  tokenId: string;
};

type LaunchInput = {
  identity: IdentityContext;
  workspaceId: string;
  target: WorkspaceIngressTarget;
};

const hostnamePattern = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const validTarget = (target: WorkspaceIngressTarget) => (
  (target.protocol === "http" || target.protocol === "https")
  && hostnamePattern.test(target.host)
  && Number.isInteger(target.port)
  && target.port >= 1
  && target.port <= 65_535
);

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const parseClaims = (value: unknown): WorkspaceIngressClaims | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claims = value as Partial<WorkspaceIngressClaims>;
  if (
    claims.version !== 1
    || (claims.kind !== "launch" && claims.kind !== "session")
    || typeof claims.tenantId !== "string"
    || !claims.tenantId
    || typeof claims.subjectId !== "string"
    || !claims.subjectId
    || typeof claims.workspaceId !== "string"
    || !workspaceIdPattern.test(claims.workspaceId)
    || typeof claims.issuedAt !== "number"
    || !Number.isInteger(claims.issuedAt)
    || typeof claims.expiresAt !== "number"
    || !Number.isInteger(claims.expiresAt)
    || claims.expiresAt <= claims.issuedAt
    || typeof claims.tokenId !== "string"
    || !/^[A-Za-z0-9_-]{22}$/.test(claims.tokenId)
    || !validTarget(claims as WorkspaceIngressTarget)
  ) return null;
  return claims as WorkspaceIngressClaims;
};

export class WorkspaceIngressAuthority {
  constructor(
    private readonly secret: string,
    private readonly launchTtlSeconds = 5 * 60,
    private readonly sessionTtlSeconds = 8 * 60 * 60,
  ) {
    if (secret.length < 32) throw new Error("Workspace ingress secret must be at least 32 characters");
    if (!Number.isInteger(launchTtlSeconds) || launchTtlSeconds < 30 || launchTtlSeconds > 15 * 60) {
      throw new Error("Workspace ingress launch TTL must be between 30 and 900 seconds");
    }
    if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds < 5 * 60 || sessionTtlSeconds > 24 * 60 * 60) {
      throw new Error("Workspace ingress session TTL must be between 300 and 86400 seconds");
    }
  }

  issueLaunch(input: LaunchInput, now = new Date()) {
    if (!workspaceIdPattern.test(input.workspaceId)) throw new Error("Workspace ingress requires a UUID workspace identifier");
    if (!validTarget(input.target)) throw new Error("Workspace ingress target is invalid");
    const claims = this.claims("launch", input, now, this.launchTtlSeconds);
    return {
      token: this.sign(claims),
      expiresAt: new Date(claims.expiresAt * 1000).toISOString(),
    };
  }

  exchangeLaunch(token: string, workspaceId: string, now = new Date()) {
    const launch = this.verify(token, "launch", workspaceId, now);
    if (!launch) return null;
    const session = this.claims("session", {
      identity: {
        tenantId: launch.tenantId,
        subjectId: launch.subjectId,
        audience: "onecomputer-control",
      },
      workspaceId: launch.workspaceId,
      target: {
        protocol: launch.protocol,
        host: launch.host,
        port: launch.port,
      },
    }, now, this.sessionTtlSeconds);
    return {
      claims: session,
      token: this.sign(session),
      expiresAt: new Date(session.expiresAt * 1000).toISOString(),
    };
  }

  verifySession(token: string, workspaceId: string, now = new Date()) {
    return this.verify(token, "session", workspaceId, now);
  }

  private claims(kind: WorkspaceIngressClaims["kind"], input: LaunchInput, now: Date, ttlSeconds: number): WorkspaceIngressClaims {
    const issuedAt = Math.floor(now.getTime() / 1000);
    return {
      version: 1,
      kind,
      tenantId: input.identity.tenantId,
      subjectId: input.identity.subjectId,
      workspaceId: input.workspaceId,
      protocol: input.target.protocol,
      host: input.target.host,
      port: input.target.port,
      issuedAt,
      expiresAt: issuedAt + ttlSeconds,
      tokenId: randomBytes(16).toString("base64url"),
    };
  }

  private sign(claims: WorkspaceIngressClaims) {
    const payload = encode(claims);
    const signature = createHmac("sha256", this.secret)
      .update(`onecomputer:workspace-ingress:v1:${payload}`, "utf8")
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  private verify(token: string, kind: WorkspaceIngressClaims["kind"], workspaceId: string, now: Date) {
    if (token.length > 4096 || !workspaceIdPattern.test(workspaceId)) return null;
    const separator = token.indexOf(".");
    if (separator <= 0 || token.indexOf(".", separator + 1) !== -1) return null;
    const payload = token.slice(0, separator);
    const receivedSignature = token.slice(separator + 1);
    const expectedSignature = createHmac("sha256", this.secret)
      .update(`onecomputer:workspace-ingress:v1:${payload}`, "utf8")
      .digest("base64url");
    if (!safeEqual(receivedSignature, expectedSignature)) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const claims = parseClaims(decoded);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (
      !claims
      || claims.kind !== kind
      || claims.workspaceId !== workspaceId
      || claims.issuedAt > nowSeconds + 30
      || claims.expiresAt <= nowSeconds
    ) return null;
    return claims;
  }
}
