import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { LemmaComputerError, type AuthenticationAssurance } from "@lemmacomputer/contracts";
import type {
  PlatformOperatorSession,
  PostgresPlatformOperatorStore,
} from "@lemmacomputer/workspace-store";

export type PlatformOperatorAuthenticationStore = Pick<PostgresPlatformOperatorStore,
  | "createOperatorLoginAttempt"
  | "consumeOperatorLoginAttempt"
  | "resolveWorkforceOperator"
  | "createSession"
  | "markSessionStepUp"
  | "getSession"
  | "revokeSession"
>;

export type PlatformOperatorAuthConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  publicWebUrl: string;
  sessionSecret: string;
  stepUpAuthenticationContext: string;
  sessionTtlMs?: number;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  idTokenVerifier?: (token: string, expected: { issuer: string; audience: string }) => Promise<Record<string, unknown>>;
};

const stateCookieName = "oc_platform_oidc_state";
const sessionCookieName = "oc_platform_session";
const stepUpStateCookieName = "oc_platform_step_up_state";
const callbackPath = "/api/v1/platform/auth/callback";
const stepUpCallbackPath = "/api/v1/platform/auth/step-up/callback";
const sessionPath = "/api/v1/platform";
const operatorUiPath = "/platform";

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
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return operatorUiPath;
  const base = new URL("https://return-path.invalid");
  const resolved = new URL(value, base);
  return resolved.origin === base.origin ? `${resolved.pathname}${resolved.search}${resolved.hash}` : operatorUiPath;
};

export class PlatformOperatorAuthenticationService {
  private readonly now: () => Date;
  private readonly request: typeof globalThis.fetch;
  private readonly encryptionKey: Buffer;
  private readonly issuer: string;
  private readonly authorizationEndpoint: string;
  private readonly tokenEndpoint: string;
  private readonly callbackUrl: string;
  private readonly stepUpCallbackUrl: string;
  private readonly secureCookie: string;
  private readonly verifyIdToken: (token: string) => Promise<Record<string, unknown>>;

  constructor(
    private readonly store: PlatformOperatorAuthenticationStore,
    private readonly config: PlatformOperatorAuthConfig,
  ) {
    this.now = config.now ?? (() => new Date());
    this.request = config.fetch ?? globalThis.fetch;
    this.encryptionKey = createHash("sha256").update(config.sessionSecret).digest();
    const authority = `https://login.microsoftonline.com/${config.tenantId}`;
    this.issuer = `${authority}/v2.0`;
    this.authorizationEndpoint = `${authority}/oauth2/v2.0/authorize`;
    this.tokenEndpoint = `${authority}/oauth2/v2.0/token`;
    this.callbackUrl = `${config.publicWebUrl.replace(/\/$/, "")}${callbackPath}`;
    this.stepUpCallbackUrl = `${config.publicWebUrl.replace(/\/$/, "")}${stepUpCallbackPath}`;
    this.secureCookie = new URL(config.publicWebUrl).protocol === "https:" ? "; Secure" : "";
    const jwks = createRemoteJWKSet(new URL(`${authority}/discovery/v2.0/keys`));
    this.verifyIdToken = config.idTokenVerifier
      ? (token) => config.idTokenVerifier!(token, { issuer: this.issuer, audience: config.clientId })
      : async (token) => (await jwtVerify(token, jwks, { issuer: this.issuer, audience: config.clientId })).payload;
  }

  async begin(returnPath?: string) {
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const nonce = base64url(randomBytes(24));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const now = this.now();
    await this.store.createOperatorLoginAttempt({
      stateHash: hash(state),
      verifierCiphertext: this.encrypt(verifier),
      nonce,
      returnPath: validReturnPath(returnPath),
      expiresAt: new Date(now.getTime() + 10 * 60_000),
      createdAt: now,
      purpose: "login",
      operatorSessionId: null,
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
      prompt: "login",
    });
    return {
      location: `${this.authorizationEndpoint}?${query}`,
      cookie: `${stateCookieName}=${encodeURIComponent(state)}; Path=${callbackPath}; HttpOnly; SameSite=Lax; Max-Age=600${this.secureCookie}`,
    };
  }

  async complete(input: { state?: string; code?: string; error?: string; cookie?: string }) {
    if (input.error) throw new LemmaComputerError("PLATFORM_OIDC_DENIED", "Workforce sign-in was not completed", 401);
    if (!input.state || !input.code) throw new LemmaComputerError("PLATFORM_OIDC_CALLBACK_INVALID", "Workforce sign-in could not be verified", 400);
    const stateCookie = cookieValue(input.cookie, stateCookieName);
    const left = Buffer.from(input.state);
    const right = Buffer.from(stateCookie ?? "");
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new LemmaComputerError("PLATFORM_OIDC_STATE_MISMATCH", "Workforce sign-in could not be verified", 401);
    }
    const stateHash = hash(input.state);
    const attempt = await this.store.consumeOperatorLoginAttempt(stateHash, this.now());
    if (!attempt) throw new LemmaComputerError("PLATFORM_OIDC_STATE_EXPIRED", "Workforce sign-in expired or was already used", 401);
    if (attempt.purpose !== "login" || attempt.operatorSessionId !== null) {
      throw new LemmaComputerError("PLATFORM_OIDC_STATE_INVALID", "Workforce sign-in state was invalid", 401);
    }
    const verifier = this.decrypt(attempt.verifierCiphertext);
    const tokenResponse = await this.request(this.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: verifier,
        redirect_uri: this.callbackUrl,
        scope: "openid profile email",
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!tokenResponse?.ok) {
      await tokenResponse?.body?.cancel().catch(() => undefined);
      throw new LemmaComputerError("PLATFORM_OIDC_TOKEN_EXCHANGE_FAILED", "Workforce sign-in could not be completed", 502, true);
    }
    const tokenPayload = await tokenResponse.json() as { id_token?: string };
    if (!tokenPayload.id_token) throw new LemmaComputerError("PLATFORM_OIDC_ID_TOKEN_MISSING", "Workforce sign-in response was invalid", 502);
    const payload = await this.verifyIdToken(tokenPayload.id_token).catch(() => {
      throw new LemmaComputerError("PLATFORM_OIDC_ID_TOKEN_INVALID", "Workforce sign-in response was invalid", 401);
    });
    const receivedNonce = typeof payload.nonce === "string" ? Buffer.from(payload.nonce) : Buffer.alloc(0);
    const expectedNonce = Buffer.from(attempt.nonce);
    if (receivedNonce.length !== expectedNonce.length || !timingSafeEqual(receivedNonce, expectedNonce)) {
      throw new LemmaComputerError("PLATFORM_OIDC_NONCE_MISMATCH", "Workforce sign-in response was invalid", 401);
    }
    const subject = typeof payload.oid === "string" ? payload.oid.toLowerCase() : "";
    const workforceTenantId = typeof payload.tid === "string" ? payload.tid : "";
    if (!subject || workforceTenantId !== this.config.tenantId) {
      throw new LemmaComputerError("PLATFORM_OIDC_IDENTITY_INVALID", "The workforce identity is not allowed", 403);
    }
    const operator = await this.store.resolveWorkforceOperator({
      issuer: this.issuer,
      subject,
      workforceTenantId,
    });
    if (!operator) {
      throw new LemmaComputerError("PLATFORM_OPERATOR_NOT_PROVISIONED", "The workforce identity is not provisioned", 403);
    }
    const now = this.now();
    const amr = Array.isArray(payload.amr) ? payload.amr.filter((value): value is string => typeof value === "string") : [];
    const factors: AuthenticationAssurance["factors"] = ["federated"];
    if (amr.includes("pwd")) factors.push("password");
    if (amr.includes("mfa")) factors.push("totp");
    const assurance: AuthenticationAssurance = {
      level: amr.includes("mfa") ? "aal2" : "aal1",
      factors,
    };
    const rawSessionToken = base64url(randomBytes(48));
    const session = await this.store.createSession({
      operatorId: operator.operatorId,
      tokenHash: hash(rawSessionToken),
      assurance,
      authenticatedAt: now,
      recentStepUpAt: null,
      expiresAt: new Date(now.getTime() + (this.config.sessionTtlMs ?? 8 * 60 * 60_000)),
      correlationId: `platform-login:${stateHash.slice(0, 32)}`,
    });
    return {
      session,
      returnPath: attempt.returnPath,
      cookie: `${sessionCookieName}=${encodeURIComponent(rawSessionToken)}; Path=${sessionPath}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((this.config.sessionTtlMs ?? 8 * 60 * 60_000) / 1_000)}${this.secureCookie}`,
      clearStateCookie: `${stateCookieName}=; Path=${callbackPath}; HttpOnly; SameSite=Lax; Max-Age=0${this.secureCookie}`,
    };
  }

  async authenticate(cookieHeader: string | undefined) {
    const token = cookieValue(cookieHeader, sessionCookieName);
    return token ? this.store.getSession(hash(token), this.now()) : null;
  }

  async beginStepUp(cookieHeader: string | undefined, returnPath?: string) {
    const session = await this.authenticate(cookieHeader);
    if (!session) throw new LemmaComputerError("PLATFORM_UNAUTHENTICATED", "Sign in with your workforce account", 401);
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const nonce = base64url(randomBytes(24));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const now = this.now();
    await this.store.createOperatorLoginAttempt({
      stateHash: hash(state),
      verifierCiphertext: this.encrypt(verifier),
      nonce,
      returnPath: validReturnPath(returnPath),
      expiresAt: new Date(now.getTime() + 10 * 60_000),
      createdAt: now,
      purpose: "step-up",
      operatorSessionId: session.principal.operatorSessionId,
    });
    const claims = JSON.stringify({
      id_token: {
        auth_time: { essential: true },
        acrs: { essential: true, value: this.config.stepUpAuthenticationContext },
      },
    });
    const query = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: "code",
      redirect_uri: this.stepUpCallbackUrl,
      response_mode: "query",
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "login",
      max_age: "0",
      acr_values: this.config.stepUpAuthenticationContext,
      claims,
    });
    return {
      location: `${this.authorizationEndpoint}?${query}`,
      cookie: `${stepUpStateCookieName}=${encodeURIComponent(state)}; Path=${stepUpCallbackPath}; HttpOnly; SameSite=Lax; Max-Age=600${this.secureCookie}`,
    };
  }

  async completeStepUp(input: { state?: string; code?: string; error?: string; cookie?: string }) {
    if (input.error) throw new LemmaComputerError("PLATFORM_STEP_UP_DENIED", "Workforce step-up was not completed", 401);
    if (!input.state || !input.code) throw new LemmaComputerError("PLATFORM_STEP_UP_CALLBACK_INVALID", "Workforce step-up could not be verified", 400);
    const activeSession = await this.authenticate(input.cookie);
    if (!activeSession) throw new LemmaComputerError("PLATFORM_UNAUTHENTICATED", "Sign in with your workforce account", 401);
    const stateCookie = cookieValue(input.cookie, stepUpStateCookieName);
    const left = Buffer.from(input.state);
    const right = Buffer.from(stateCookie ?? "");
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new LemmaComputerError("PLATFORM_STEP_UP_STATE_MISMATCH", "Workforce step-up could not be verified", 401);
    }
    const stateHash = hash(input.state);
    const now = this.now();
    const attempt = await this.store.consumeOperatorLoginAttempt(stateHash, now);
    if (!attempt) throw new LemmaComputerError("PLATFORM_STEP_UP_STATE_EXPIRED", "Workforce step-up expired or was already used", 401);
    if (attempt.purpose !== "step-up" || attempt.operatorSessionId !== activeSession.principal.operatorSessionId) {
      throw new LemmaComputerError("PLATFORM_STEP_UP_STATE_INVALID", "Workforce step-up state was invalid", 401);
    }
    const verifier = this.decrypt(attempt.verifierCiphertext);
    const tokenResponse = await this.request(this.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: verifier,
        redirect_uri: this.stepUpCallbackUrl,
        scope: "openid profile email",
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!tokenResponse?.ok) {
      await tokenResponse?.body?.cancel().catch(() => undefined);
      throw new LemmaComputerError("PLATFORM_STEP_UP_TOKEN_EXCHANGE_FAILED", "Workforce step-up could not be completed", 502, true);
    }
    const tokenPayload = await tokenResponse.json() as { id_token?: string };
    if (!tokenPayload.id_token) throw new LemmaComputerError("PLATFORM_STEP_UP_ID_TOKEN_MISSING", "Workforce step-up response was invalid", 502);
    const payload = await this.verifyIdToken(tokenPayload.id_token).catch(() => {
      throw new LemmaComputerError("PLATFORM_STEP_UP_ID_TOKEN_INVALID", "Workforce step-up response was invalid", 401);
    });
    const receivedNonce = typeof payload.nonce === "string" ? Buffer.from(payload.nonce) : Buffer.alloc(0);
    const expectedNonce = Buffer.from(attempt.nonce);
    if (receivedNonce.length !== expectedNonce.length || !timingSafeEqual(receivedNonce, expectedNonce)) {
      throw new LemmaComputerError("PLATFORM_STEP_UP_NONCE_MISMATCH", "Workforce step-up response was invalid", 401);
    }
    const subject = typeof payload.oid === "string" ? payload.oid.toLowerCase() : "";
    const workforceTenantId = typeof payload.tid === "string" ? payload.tid : "";
    if (subject !== activeSession.principal.identity.subject || workforceTenantId !== this.config.tenantId) {
      throw new LemmaComputerError("PLATFORM_STEP_UP_IDENTITY_MISMATCH", "Step-up must use the signed-in workforce identity", 403);
    }
    const authTimeSeconds = typeof payload.auth_time === "number" && Number.isInteger(payload.auth_time) ? payload.auth_time : 0;
    const authTime = new Date(authTimeSeconds * 1_000);
    const acrs = Array.isArray(payload.acrs)
      ? payload.acrs.filter((value): value is string => typeof value === "string")
      : typeof payload.acrs === "string" ? [payload.acrs] : [];
    const recentEnough = authTimeSeconds > 0
      && authTime.getTime() >= attempt.createdAt.getTime() - 30_000
      && authTime.getTime() <= now.getTime() + 30_000
      && now.getTime() - authTime.getTime() <= 5 * 60_000;
    if (!recentEnough || !acrs.includes(this.config.stepUpAuthenticationContext)) {
      throw new LemmaComputerError("PLATFORM_STEP_UP_CONTEXT_INVALID", "Required recent workforce authentication context was not satisfied", 403);
    }
    const session = await this.store.markSessionStepUp({
      operatorSessionId: activeSession.principal.operatorSessionId,
      operatorId: activeSession.principal.operatorId,
      authenticatedAt: now,
      authenticationContext: this.config.stepUpAuthenticationContext,
      correlationId: `platform-step-up:${stateHash.slice(0, 32)}`,
    });
    if (!session) throw new LemmaComputerError("PLATFORM_STEP_UP_SESSION_INVALID", "The platform session is no longer active", 401);
    return {
      session,
      returnPath: attempt.returnPath,
      clearStateCookie: `${stepUpStateCookieName}=; Path=${stepUpCallbackPath}; HttpOnly; SameSite=Lax; Max-Age=0${this.secureCookie}`,
    };
  }

  async logout(cookieHeader: string | undefined, correlationId: string) {
    const token = cookieValue(cookieHeader, sessionCookieName);
    if (token) {
      const session = await this.store.getSession(hash(token), this.now());
      if (session) await this.store.revokeSession(session, correlationId, this.now());
    }
    return `${sessionCookieName}=; Path=${sessionPath}; HttpOnly; SameSite=Lax; Max-Age=0${this.secureCookie}`;
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `${base64url(iv)}.${base64url(cipher.getAuthTag())}.${base64url(ciphertext)}`;
  }

  private decrypt(value: string) {
    const [iv, tag, ciphertext] = value.split(".").map((part) => Buffer.from(part, "base64url"));
    if (!iv || !tag || !ciphertext) throw new LemmaComputerError("PLATFORM_OIDC_STATE_INVALID", "Workforce sign-in state was invalid", 401);
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}
