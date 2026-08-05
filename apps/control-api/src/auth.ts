import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { LemmaComputerError, type IdentityContext } from "@lemmacomputer/contracts";
import { hasOrganizationPermission, type IdentityPolicyStore, type MembershipAdmissionMode, type SessionPrincipal } from "@lemmacomputer/workspace-store";

export type EntraAuthConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  publicWebUrl: string;
  sessionSecret: string;
  bootstrapOwnedTenantId: string;
  bootstrapOwnedUserId: string;
  tenantDisplayName: string;
  bootstrapOwnerObjectIds: string[];
  membershipAdmissionMode: MembershipAdmissionMode;
  sessionTtlMs?: number;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  idTokenVerifier?: (token: string, expected: { issuer: string; audience: string }) => Promise<Record<string, unknown>>;
};

const cookieValue = (header: string | undefined, name: string) => {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const base64url = (value: Buffer) => value.toString("base64url");
const validReturnPath = (value: string | undefined) => value?.startsWith("/") && !value.startsWith("//") ? value : "/";

export class EntraAuthenticationService {
  private readonly now: () => Date;
  private readonly request: typeof globalThis.fetch;
  private readonly encryptionKey: Buffer;
  private readonly issuer: string;
  private readonly callbackUrl: string;
  private readonly secureCookie: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly verifyIdToken: (token: string) => Promise<Record<string, unknown>>;

  constructor(private readonly store: IdentityPolicyStore, private readonly config: EntraAuthConfig) {
    this.now = config.now ?? (() => new Date());
    this.request = config.fetch ?? globalThis.fetch;
    this.encryptionKey = createHash("sha256").update(config.sessionSecret).digest();
    this.issuer = `https://login.microsoftonline.com/${config.tenantId}/v2.0`;
    this.callbackUrl = `${config.publicWebUrl.replace(/\/$/, "")}/api/v1/auth/callback`;
    this.secureCookie = new URL(config.publicWebUrl).protocol === "https:" ? "; Secure" : "";
    this.jwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`));
    this.verifyIdToken = config.idTokenVerifier
      ? (token) => config.idTokenVerifier!(token, { issuer: this.issuer, audience: config.clientId })
      : async (token) => {
          const verified = await jwtVerify(token, this.jwks, { issuer: this.issuer, audience: config.clientId });
          return verified.payload;
        };
  }

  async begin(returnPath?: string) {
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const nonce = base64url(randomBytes(24));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    await this.store.createLoginAttempt({
      stateHash: hash(state),
      verifierCiphertext: this.encrypt(verifier),
      nonce,
      returnPath: validReturnPath(returnPath),
      expiresAt: new Date(this.now().getTime() + 10 * 60_000),
    });
    const query = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: "code",
      redirect_uri: this.callbackUrl,
      response_mode: "query",
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return {
      location: `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/authorize?${query}`,
      cookie: `oc_oidc_state=${encodeURIComponent(state)}; Path=/api/v1/auth/callback; HttpOnly; SameSite=Lax; Max-Age=600${this.secureCookie}`,
    };
  }

  async complete(input: { state?: string; code?: string; error?: string; cookie?: string }) {
    if (input.error) throw new LemmaComputerError("OIDC_DENIED", "Microsoft sign-in was not completed", 401);
    if (!input.state || !input.code) throw new LemmaComputerError("OIDC_CALLBACK_INVALID", "Microsoft sign-in could not be verified", 400);
    const stateCookie = cookieValue(input.cookie, "oc_oidc_state");
    const left = Buffer.from(input.state);
    const right = Buffer.from(stateCookie ?? "");
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new LemmaComputerError("OIDC_STATE_MISMATCH", "Microsoft sign-in could not be verified", 401);
    }
    const attempt = await this.store.consumeLoginAttempt(hash(input.state), this.now());
    if (!attempt) throw new LemmaComputerError("OIDC_STATE_EXPIRED", "Microsoft sign-in expired or was already used", 401);
    const tokenResponse = await this.request(`https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: this.decrypt(attempt.verifierCiphertext),
        redirect_uri: this.callbackUrl,
        scope: "openid profile email",
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!tokenResponse?.ok) {
      await tokenResponse?.body?.cancel().catch(() => undefined);
      throw new LemmaComputerError("OIDC_TOKEN_EXCHANGE_FAILED", "Microsoft sign-in could not be completed", 502, true);
    }
    const tokenPayload = await tokenResponse.json() as { id_token?: string };
    if (!tokenPayload.id_token) throw new LemmaComputerError("OIDC_ID_TOKEN_MISSING", "Microsoft sign-in response was invalid", 502);
    const payload = await this.verifyIdToken(tokenPayload.id_token)
      .catch(() => { throw new LemmaComputerError("OIDC_ID_TOKEN_INVALID", "Microsoft sign-in response was invalid", 401); });
    const receivedNonce = typeof payload.nonce === "string" ? Buffer.from(payload.nonce) : Buffer.alloc(0);
    const expectedNonce = Buffer.from(attempt.nonce);
    if (receivedNonce.length !== expectedNonce.length || !timingSafeEqual(receivedNonce, expectedNonce)) {
      throw new LemmaComputerError("OIDC_NONCE_MISMATCH", "Microsoft sign-in response was invalid", 401);
    }
    const externalSubject = typeof payload.sub === "string" ? payload.sub : "";
    const externalTenantId = typeof payload.tid === "string" ? payload.tid : "";
    const providerObjectId = typeof payload.oid === "string" ? payload.oid.toLowerCase() : "";
    const emailClaim = payload.preferred_username ?? payload.email;
    const email = typeof emailClaim === "string" ? emailClaim.toLowerCase() : "";
    if (!externalSubject || !providerObjectId || externalTenantId !== this.config.tenantId || !email) {
      throw new LemmaComputerError("OIDC_IDENTITY_INVALID", "The signed-in Microsoft identity is not allowed", 403);
    }
    const isBootstrapOwner = this.config.bootstrapOwnerObjectIds.map((item) => item.toLowerCase()).includes(providerObjectId);
    const ownedUserId = isBootstrapOwner
      ? this.config.bootstrapOwnedUserId
      : `user-${hash(`${externalTenantId}:${providerObjectId}`).slice(0, 24)}`;
    const identity: IdentityContext = { tenantId: this.config.bootstrapOwnedTenantId, subjectId: ownedUserId, audience: "lemmacomputer-control" };
    const gatewayUserId = `oc-user-${createHash("sha256").update(`lemmacomputer:litellm:user:${identity.tenantId}:${identity.subjectId}`).digest("base64url")}`;
    const principal = await this.store.resolveAuthenticatedIdentity({
      provider: "entra",
      organizationId: this.config.bootstrapOwnedTenantId,
      userId: ownedUserId,
      externalTenantId,
      subject: externalSubject,
      providerObjectId,
      issuer: this.issuer,
      email,
      displayName: typeof payload.name === "string" ? payload.name : email.split("@")[0],
      organizationDisplayName: this.config.tenantDisplayName,
      bootstrapOwner: isBootstrapOwner,
      membershipAdmissionMode: this.config.membershipAdmissionMode,
      gatewayUserId,
    });
    const token = base64url(randomBytes(48));
    const expiresAt = new Date(this.now().getTime() + (this.config.sessionTtlMs ?? 12 * 60 * 60_000));
    await this.store.createSession({
      tokenHash: hash(token),
      userId: principal.userId,
      ...(principal.membershipId ? { membershipId: principal.membershipId } : {}),
      expiresAt,
    });
    return {
      principal,
      returnPath: attempt.returnPath,
      cookie: `lemmacomputer_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expiresAt.getTime() - this.now().getTime()) / 1000)}${this.secureCookie}`,
      clearStateCookie: `oc_oidc_state=; Path=/api/v1/auth/callback; HttpOnly; SameSite=Lax; Max-Age=0${this.secureCookie}`,
    };
  }

  async authenticate(cookieHeader: string | undefined) {
    const token = cookieValue(cookieHeader, "lemmacomputer_session");
    return token ? this.store.getSession(hash(token), this.now()) : null;
  }

  async logout(cookieHeader: string | undefined) {
    const token = cookieValue(cookieHeader, "lemmacomputer_session");
    if (token) await this.store.revokeSession(hash(token));
    return `lemmacomputer_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.secureCookie}`;
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `${base64url(iv)}.${base64url(cipher.getAuthTag())}.${base64url(ciphertext)}`;
  }

  private decrypt(value: string) {
    const [iv, tag, ciphertext] = value.split(".").map((item) => Buffer.from(item, "base64url"));
    if (!iv || !tag || !ciphertext) throw new LemmaComputerError("OIDC_STATE_INVALID", "Microsoft sign-in state was invalid", 401);
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

export const testPrincipalFromHeaders = (headers: Record<string, unknown>): SessionPrincipal => {
  const tenantId = String(headers["x-lemmacomputer-test-tenant-id"] ?? "test-tenant");
  const userId = String(headers["x-lemmacomputer-test-user-id"] ?? "test-user");
  return {
    userId,
    tenantId,
    organizationId: tenantId,
    membershipId: `test-membership:${tenantId}:${userId}`,
    membershipStatus: "active",
    role: "owner",
    email: `${userId}@example.test`,
    displayName: userId,
    tenantDisplayName: tenantId,
    roles: ["owner", "administrator"],
    identity: { tenantId, subjectId: userId, audience: "lemmacomputer-control" },
  };
};

export const isAdministrator = (principal: SessionPrincipal) => (
  hasOrganizationPermission(principal, "organization.manage_settings")
);
