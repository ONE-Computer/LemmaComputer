import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { LemmaComputerError } from "@lemmacomputer/contracts";
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
  provider?: "entra" | "entra-external-id";
  authority?: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  jwksUri?: string;
  callbackPath?: string;
  stateCookieName?: string;
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
const validReturnPath = (value: string | undefined) => {
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  const base = new URL("https://return-path.invalid");
  const resolved = new URL(value, base);
  return resolved.origin === base.origin ? `${resolved.pathname}${resolved.search}${resolved.hash}` : "/";
};

export class EntraAuthenticationService {
  private readonly now: () => Date;
  private readonly request: typeof globalThis.fetch;
  private readonly encryptionKey: Buffer;
  private readonly issuer: string;
  private readonly authorizationEndpoint: string;
  private readonly tokenEndpoint: string;
  private readonly callbackUrl: string;
  private readonly callbackPath: string;
  private readonly stateCookieName: string;
  private readonly secureCookie: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly verifyIdToken: (token: string) => Promise<Record<string, unknown>>;

  constructor(private readonly store: IdentityPolicyStore, private readonly config: EntraAuthConfig) {
    this.now = config.now ?? (() => new Date());
    this.request = config.fetch ?? globalThis.fetch;
    this.encryptionKey = createHash("sha256").update(config.sessionSecret).digest();
    const authority = (config.authority ?? `https://login.microsoftonline.com/${config.tenantId}`).replace(/\/$/, "");
    this.issuer = config.issuer ?? `${authority}/v2.0`;
    this.authorizationEndpoint = config.authorizationEndpoint ?? `${authority}/oauth2/v2.0/authorize`;
    this.tokenEndpoint = config.tokenEndpoint ?? `${authority}/oauth2/v2.0/token`;
    this.callbackPath = config.callbackPath ?? "/api/v1/auth/callback";
    this.callbackUrl = `${config.publicWebUrl.replace(/\/$/, "")}${this.callbackPath}`;
    this.stateCookieName = config.stateCookieName ?? "oc_oidc_state";
    this.secureCookie = new URL(config.publicWebUrl).protocol === "https:" ? "; Secure" : "";
    this.jwks = createRemoteJWKSet(new URL(config.jwksUri ?? `${authority}/discovery/v2.0/keys`));
    this.verifyIdToken = config.idTokenVerifier
      ? (token) => config.idTokenVerifier!(token, { issuer: this.issuer, audience: config.clientId })
      : async (token) => {
          const verified = await jwtVerify(token, this.jwks, { issuer: this.issuer, audience: config.clientId });
          return verified.payload;
        };
  }

  async begin(returnPath?: string, invitationToken?: string) {
    const invitationTokenHash = invitationToken ? hash(invitationToken) : undefined;
    if (invitationTokenHash && (!this.store.getOrganizationInvitationContext
      || !await this.store.getOrganizationInvitationContext(invitationTokenHash, this.now()))) {
      await this.store.recordInvitationLinkFailure?.(
        invitationTokenHash,
        this.config.provider ?? "entra",
        "INVITATION_NOT_USABLE",
        this.now(),
      );
      throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
    }
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const nonce = base64url(randomBytes(24));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    await this.store.createLoginAttempt({
      stateHash: hash(state),
      verifierCiphertext: this.encrypt(JSON.stringify({ verifier, invitationTokenHash: invitationTokenHash ?? null })),
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
      location: `${this.authorizationEndpoint}?${query}`,
      cookie: `${this.stateCookieName}=${encodeURIComponent(state)}; Path=${this.callbackPath}; HttpOnly; SameSite=Lax; Max-Age=600${this.secureCookie}`,
    };
  }

  async complete(input: { state?: string; code?: string; error?: string; cookie?: string }) {
    if (input.error) throw new LemmaComputerError("OIDC_DENIED", "Microsoft sign-in was not completed", 401);
    if (!input.state || !input.code) throw new LemmaComputerError("OIDC_CALLBACK_INVALID", "Microsoft sign-in could not be verified", 400);
    const stateCookie = cookieValue(input.cookie, this.stateCookieName);
    const left = Buffer.from(input.state);
    const right = Buffer.from(stateCookie ?? "");
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new LemmaComputerError("OIDC_STATE_MISMATCH", "Microsoft sign-in could not be verified", 401);
    }
    const attempt = await this.store.consumeLoginAttempt(hash(input.state), this.now());
    if (!attempt) throw new LemmaComputerError("OIDC_STATE_EXPIRED", "Microsoft sign-in expired or was already used", 401);
    const protectedAttempt = this.decryptAttempt(attempt.verifierCiphertext);
    const tokenResponse = await this.request(this.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: protectedAttempt.verifier,
        redirect_uri: this.callbackUrl,
        scope: "openid profile email",
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!tokenResponse?.ok) {
      await tokenResponse?.body?.cancel().catch(() => undefined);
      await this.recordAuthenticationFailure(protectedAttempt.invitationTokenHash, "OIDC_TOKEN_EXCHANGE_FAILED");
      throw new LemmaComputerError("OIDC_TOKEN_EXCHANGE_FAILED", "Microsoft sign-in could not be completed", 502, true);
    }
    const tokenPayload = await tokenResponse.json() as { id_token?: string };
    if (!tokenPayload.id_token) {
      await this.recordAuthenticationFailure(protectedAttempt.invitationTokenHash, "OIDC_ID_TOKEN_MISSING");
      throw new LemmaComputerError("OIDC_ID_TOKEN_MISSING", "Microsoft sign-in response was invalid", 502);
    }
    const payload = await this.verifyIdToken(tokenPayload.id_token)
      .catch(async () => {
        await this.recordAuthenticationFailure(protectedAttempt.invitationTokenHash, "OIDC_ID_TOKEN_INVALID");
        throw new LemmaComputerError("OIDC_ID_TOKEN_INVALID", "Microsoft sign-in response was invalid", 401);
      });
    const receivedNonce = typeof payload.nonce === "string" ? Buffer.from(payload.nonce) : Buffer.alloc(0);
    const expectedNonce = Buffer.from(attempt.nonce);
    if (receivedNonce.length !== expectedNonce.length || !timingSafeEqual(receivedNonce, expectedNonce)) {
      await this.recordAuthenticationFailure(protectedAttempt.invitationTokenHash, "OIDC_NONCE_MISMATCH");
      throw new LemmaComputerError("OIDC_NONCE_MISMATCH", "Microsoft sign-in response was invalid", 401);
    }
    const externalSubject = typeof payload.sub === "string" ? payload.sub : "";
    const externalTenantClaim = typeof payload.tid === "string" ? payload.tid : "";
    const externalTenantId = externalTenantClaim || this.config.tenantId;
    const providerObjectId = typeof payload.oid === "string" ? payload.oid.toLowerCase() : "";
    const emailClaim = payload.email ?? payload.preferred_username
      ?? (Array.isArray(payload.emails) ? payload.emails[0] : undefined);
    const email = typeof emailClaim === "string" ? emailClaim.trim().toLowerCase() : "";
    const workforceIdentityInvalid = (this.config.provider ?? "entra") === "entra"
      && (!providerObjectId || externalTenantId !== this.config.tenantId);
    const externalTenantInvalid = (this.config.provider ?? "entra") === "entra-external-id"
      && externalTenantClaim !== "" && externalTenantClaim !== this.config.tenantId;
    if (!externalSubject || workforceIdentityInvalid || externalTenantInvalid || !email) {
      await this.recordAuthenticationFailure(protectedAttempt.invitationTokenHash, "OIDC_IDENTITY_INVALID");
      throw new LemmaComputerError("OIDC_IDENTITY_INVALID", "The signed-in Microsoft identity is not allowed", 403);
    }
    const invitationContext = protectedAttempt.invitationTokenHash && this.store.getOrganizationInvitationContext
      ? await this.store.getOrganizationInvitationContext(protectedAttempt.invitationTokenHash, this.now())
      : null;
    if (protectedAttempt.invitationTokenHash && !invitationContext) {
      await this.recordAuthenticationFailure(protectedAttempt.invitationTokenHash, "INVITATION_NOT_USABLE");
      throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
    }
    const isBootstrapOwner = this.config.bootstrapOwnerObjectIds.map((item) => item.toLowerCase()).includes(providerObjectId);
    const immutableProviderUserId = providerObjectId || externalSubject;
    const ownedUserId = isBootstrapOwner
      ? this.config.bootstrapOwnedUserId
      : `user-${hash(`${this.issuer}:${immutableProviderUserId}`).slice(0, 24)}`;
    const organizationId = invitationContext?.organizationId ?? this.config.bootstrapOwnedTenantId;
    const token = base64url(randomBytes(48));
    const expiresAt = new Date(this.now().getTime() + (this.config.sessionTtlMs ?? 12 * 60 * 60_000));
    const principal = await this.store.resolveAuthenticatedIdentity({
      provider: this.config.provider ?? "entra",
      organizationId,
      userId: ownedUserId,
      externalTenantId,
      subject: externalSubject,
      ...(providerObjectId ? { providerObjectId } : {}),
      issuer: this.issuer,
      email,
      displayName: typeof payload.name === "string" ? payload.name : email.split("@")[0],
      organizationDisplayName: invitationContext?.organizationDisplayName ?? this.config.tenantDisplayName,
      bootstrapOwner: isBootstrapOwner,
      membershipAdmissionMode: this.config.membershipAdmissionMode,
      ...(protectedAttempt.invitationTokenHash ? { invitationTokenHash: protectedAttempt.invitationTokenHash } : {}),
      browserSession: { tokenHash: hash(token), expiresAt },
    }).catch(async (error) => {
      await this.recordAuthenticationFailure(
        protectedAttempt.invitationTokenHash,
        error instanceof LemmaComputerError ? error.code : "IDENTITY_RESOLUTION_FAILED",
        { subject: externalSubject },
      );
      throw error;
    });
    return {
      principal,
      returnPath: attempt.returnPath,
      cookie: `lemmacomputer_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expiresAt.getTime() - this.now().getTime()) / 1000)}${this.secureCookie}`,
      clearStateCookie: `${this.stateCookieName}=; Path=${this.callbackPath}; HttpOnly; SameSite=Lax; Max-Age=0${this.secureCookie}`,
    };
  }

  async authenticate(cookieHeader: string | undefined) {
    const token = cookieValue(cookieHeader, "lemmacomputer_session");
    return token ? this.store.getSession(hash(token), this.now()) : null;
  }

  async logout(cookieHeader: string | undefined) {
    const token = cookieValue(cookieHeader, "lemmacomputer_session");
    if (token) {
      if (this.store.revokeSessionWithAccessAudit) {
        await this.store.revokeSessionWithAccessAudit(hash(token), this.config.provider ?? "entra", this.now());
      } else {
        const current = await this.store.getSession(hash(token), this.now());
        await this.store.revokeSession(hash(token));
        if (current) await this.store.recordOrganizationAccessEvent?.({
          organizationId: current.tenantId,
          ...(current.membershipId ? { membershipId: current.membershipId } : {}),
          actorUserId: current.userId,
          eventType: "authentication.logout",
          provider: this.config.provider ?? "entra",
          occurredAt: this.now(),
        });
      }
    }
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

  private decryptAttempt(value: string) {
    const decrypted = this.decrypt(value);
    try {
      const parsed = JSON.parse(decrypted) as { verifier?: unknown; invitationTokenHash?: unknown };
      if (typeof parsed.verifier !== "string") throw new Error("invalid verifier");
      return {
        verifier: parsed.verifier,
        invitationTokenHash: typeof parsed.invitationTokenHash === "string" ? parsed.invitationTokenHash : undefined,
      };
    } catch {
      // Rolling upgrades may consume a workforce-Entra attempt created by the
      // previous release, where the encrypted value contained only the verifier.
      return { verifier: decrypted, invitationTokenHash: undefined };
    }
  }

  private async recordAuthenticationFailure(
    invitationTokenHash: string | undefined,
    reasonCode: string,
    externalIdentity?: { subject: string },
  ) {
    if (!invitationTokenHash) {
      if (externalIdentity) {
        await this.store.recordExternalIdentityAuthenticationFailure?.({
          provider: this.config.provider ?? "entra",
          issuer: this.issuer,
          subject: externalIdentity.subject,
          reasonCode,
          occurredAt: this.now(),
        });
      }
      return;
    }
    const context = await this.store.getOrganizationInvitationContext?.(invitationTokenHash, this.now());
    if (context) await this.store.recordOrganizationAccessEvent?.({
      organizationId: context.organizationId,
      invitationId: context.invitationId,
      eventType: "authentication.login_failed",
      provider: this.config.provider ?? "entra",
      reasonCode,
      occurredAt: this.now(),
    });
    else await this.store.recordInvitationLinkFailure?.(
      invitationTokenHash,
      this.config.provider ?? "entra",
      reasonCode,
      this.now(),
    );
  }
}

export class ExternalIdAuthenticationService extends EntraAuthenticationService {
  constructor(store: IdentityPolicyStore, config: Omit<EntraAuthConfig,
    "provider" | "authority" | "issuer" | "callbackPath" | "stateCookieName" | "membershipAdmissionMode"
  > & { tenantSubdomain: string }) {
    const authority = `https://${config.tenantSubdomain}.ciamlogin.com/${config.tenantId}`;
    super(store, {
      ...config,
      provider: "entra-external-id",
      authority,
      issuer: `${authority}/v2.0`,
      callbackPath: "/api/v1/auth/external-id/callback",
      stateCookieName: "oc_external_id_state",
      membershipAdmissionMode: "existing-membership-only",
    });
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
