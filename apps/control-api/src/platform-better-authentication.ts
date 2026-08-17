import { createHash } from "node:crypto";
import { passkey } from "@better-auth/passkey";
import { LemmaComputerError, type AuthenticationAssurance } from "@lemmacomputer/contracts";
import type { PlatformOperatorSession, PostgresPlatformOperatorStore } from "@lemmacomputer/workspace-store";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply } from "fastify";
import pg from "pg";
import { z } from "zod";

import type { PlatformOperatorAuthenticationBoundary } from "./platform-operator-routes.js";

export const platformAuthenticationBasePath = "/api/v1/auth/platform";
export const platformAuthenticationControlPath = "/v1/auth/platform";
const platformIssuer = "urn:lemmacomputer:platform-better-auth";
const platformRealm = "lemmacomputer-platform";

type PlatformBetterAuthSession = {
  session: { id: string; createdAt: Date | string; expiresAt: Date | string };
  user: { id: string; email: string; name: string };
};

export type PlatformAuthenticationOptions = {
  database: NonNullable<BetterAuthOptions["database"]>;
  baseUrl: string;
  trustedOrigins: string[];
  versionedSecrets: Array<{ version: number; value: string }>;
  installationKind: "customer-managed" | "hosted" | "worktree";
  passkey: { rpId: string; origin: string };
};

export type PlatformOperatorBootstrap = {
  mode: "worktree" | "hosted";
  email: string;
  displayName: string;
  secret?: string;
};

export const worktreePlatformOperatorBootstrap = (secret: string): PlatformOperatorBootstrap => ({
  mode: "worktree",
  email: "platform-admin@worktree.invalid",
  displayName: "Local platform administrator",
  secret,
});

const exactOrigin = (value: string, label: string) => {
  const parsed = new URL(value);
  if (parsed.origin !== value || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an exact origin`);
  }
  return parsed;
};

const validateOptions = (options: PlatformAuthenticationOptions) => {
  const baseUrl = exactOrigin(options.baseUrl, "Platform Better Auth base URL");
  const origins = options.trustedOrigins.map((origin) => exactOrigin(origin, "Platform trusted origin").origin);
  if (!origins.includes(baseUrl.origin)) throw new Error("Platform Better Auth base URL must be trusted");
  if (options.installationKind === "hosted" && baseUrl.protocol !== "https:") {
    throw new Error("Hosted platform authentication requires HTTPS");
  }
  if (!options.versionedSecrets.length || options.versionedSecrets.some((secret) => secret.value.length < 32)) {
    throw new Error("Platform Better Auth requires a versioned secret with at least 32 characters");
  }
  const passkeyOrigin = exactOrigin(options.passkey.origin, "Platform passkey origin");
  if (passkeyOrigin.origin !== baseUrl.origin || options.passkey.rpId !== passkeyOrigin.hostname) {
    throw new Error("Platform passkey origin and RP ID must match the platform authentication origin");
  }
  return { baseUrl: baseUrl.origin, origins };
};

export const createInMemoryPlatformAuthenticationDatabase = () => memoryAdapter({
  user: [],
  session: [],
  account: [],
  verification: [],
  passkey: [],
  rateLimit: [],
});

export const createPlatformAuthentication = (options: PlatformAuthenticationOptions) => {
  const validated = validateOptions(options);
  const secureCookies = options.installationKind === "hosted" || validated.baseUrl.startsWith("https://");
  return betterAuth({
    appName: "LemmaComputer Platform",
    baseURL: validated.baseUrl,
    basePath: platformAuthenticationBasePath,
    trustedOrigins: validated.origins,
    database: options.database,
    secrets: options.versionedSecrets,
    advanced: {
      database: { generateId: "uuid" },
      cookiePrefix: "lemmacomputer-platform",
      useSecureCookies: secureCookies,
      disableCSRFCheck: false,
      disableOriginCheck: false,
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: {
        httpOnly: true,
        secure: secureCookies,
        sameSite: "strict",
        path: "/",
      },
    },
    emailAndPassword: {
      // Credential routes are never exposed by registerPlatformAuthenticationRoutes.
      // A credential exists only long enough to authorize the first passkey
      // enrollment and is permanently removed by finalizeBootstrap().
      enabled: options.installationKind !== "customer-managed",
      minPasswordLength: 32,
      maxPasswordLength: 256,
      requireEmailVerification: false,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
    },
    user: {
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
    },
    session: {
      expiresIn: 8 * 60 * 60,
      updateAge: 30 * 60,
      freshAge: 5 * 60,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 30,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-in/passkey": { window: 60, max: 5 },
        "/passkey/*": { window: 60, max: 10 },
      },
    },
    plugins: [passkey({
      rpID: options.passkey.rpId,
      rpName: "LemmaComputer Platform",
      origin: options.passkey.origin,
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      registration: { requireSession: true },
    })],
    logger: {
      level: "error",
      log: (level) => console.error(JSON.stringify({
        component: "platform-authentication",
        level,
        event: "platform_authentication_operation_failed",
      })),
    },
  });
};

export type PlatformAuthentication = ReturnType<typeof createPlatformAuthentication>;

const requestHeaders = (headers: Record<string, string | string[] | undefined>) => fromNodeHeaders(headers);
const responseCookies = (response: Response) => {
  const values = response.headers.getSetCookie?.() ?? [];
  if (values.length) return values;
  const combined = response.headers.get("set-cookie");
  return combined ? [combined] : [];
};

const forwardBetterAuthResponse = async (response: Response, reply: FastifyReply) => {
  const cookies = responseCookies(response);
  if (cookies.length) reply.header("set-cookie", cookies);
  const body = await response.text();
  return reply
    .code(response.status)
    .headers(Object.fromEntries([...response.headers.entries()].filter(([name]) => name.toLowerCase() !== "set-cookie")))
    .send(body);
};

const allowedPlatformAuthenticationPath = (path: string) => new Set([
  "/get-session",
  "/sign-out",
  "/sign-in/passkey",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/list-user-passkeys",
]).has(path);

export class BetterAuthPlatformOperatorAuthenticationService implements PlatformOperatorAuthenticationBoundary {
  constructor(
    private readonly authentication: PlatformAuthentication,
    private readonly authenticationPool: pg.Pool,
    private readonly store: PostgresPlatformOperatorStore,
    private readonly baseUrl: string,
    private readonly bootstrap: PlatformOperatorBootstrap,
  ) {}

  async initializeBootstrapOperator() {
    let account = await this.authenticationPool.query(
      `SELECT "id","email","name" FROM "user" WHERE lower("email")=lower($1)`,
      [this.bootstrap.email],
    );
    if (!account.rowCount) {
      if (!this.bootstrap.secret || this.bootstrap.secret.length < 32) {
        throw new Error("Initial platform enrollment requires a one-time bootstrap secret with at least 32 characters");
      }
      const response = await this.authentication.handler(new Request(
        `${this.baseUrl}${platformAuthenticationBasePath}/sign-up/email`,
        {
          method: "POST",
          headers: { origin: this.baseUrl, "content-type": "application/json" },
          body: JSON.stringify({
            email: this.bootstrap.email,
            name: this.bootstrap.displayName,
            password: this.bootstrap.secret,
          }),
        },
      ));
      if (!response.ok && response.status !== 422) {
        throw new Error(`Platform operator bootstrap initialization failed with ${response.status}`);
      }
      account = await this.authenticationPool.query(
        `SELECT "id","email","name" FROM "user" WHERE lower("email")=lower($1)`,
        [this.bootstrap.email],
      );
    }
    if (!account.rowCount) throw new Error("Platform operator bootstrap account was not created");
    const user = account.rows[0];
    await this.store.provisionOperator({
      issuer: platformIssuer,
      subject: String(user.id),
      workforceTenantId: platformRealm,
      email: String(user.email),
      displayName: String(user.name),
      roles: ["platform-administrator"],
    });
  }

  async bootstrapCapability() {
    const account = await this.authenticationPool.query(
      `SELECT "id" FROM "user" WHERE lower("email")=lower($1)`,
      [this.bootstrap.email],
    );
    if (!account.rowCount) return null;
    const state = await this.authenticationState(String(account.rows[0].id));
    return state.enrolled ? null : { mode: this.bootstrap.mode };
  }

  async beginBootstrap(input: { secret?: string; headers?: Record<string, string | string[] | undefined> }) {
    const account = await this.authenticationPool.query(
      `SELECT "id" FROM "user" WHERE lower("email")=lower($1)`,
      [this.bootstrap.email],
    );
    if (!account.rowCount) throw new LemmaComputerError("PLATFORM_OPERATOR_NOT_PROVISIONED", "Platform enrollment is unavailable", 503, true);
    const state = await this.authenticationState(String(account.rows[0].id));
    if (state.enrolled) {
      throw new LemmaComputerError("PLATFORM_BOOTSTRAP_UNAVAILABLE", "Platform enrollment is no longer available", 404);
    }
    const suppliedSecret = this.bootstrap.mode === "worktree" ? this.bootstrap.secret : input.secret;
    if (!suppliedSecret) {
      throw new LemmaComputerError("PLATFORM_BOOTSTRAP_REJECTED", "Platform enrollment was not authorized", 401);
    }
    const headers = requestHeaders(input.headers ?? {});
    headers.set("origin", this.baseUrl);
    headers.set("content-type", "application/json");
    const response = await this.authentication.handler(new Request(
      `${this.baseUrl}${platformAuthenticationBasePath}/sign-in/email`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ email: this.bootstrap.email, password: suppliedSecret }),
      },
    ));
    if (!response.ok) {
      throw new LemmaComputerError("PLATFORM_BOOTSTRAP_REJECTED", "Platform enrollment was not authorized", 401);
    }
    return { cookies: responseCookies(response) };
  }

  assertBootstrapOrigin(origin: string | undefined) {
    if (origin !== this.baseUrl) {
      throw new LemmaComputerError("PLATFORM_BOOTSTRAP_FORBIDDEN", "Platform enrollment requires the configured platform origin", 403);
    }
  }

  async finalizeBootstrap(cookieHeader: string | undefined) {
    const current = await this.betterAuthSession(cookieHeader);
    if (!current || current.user.email.toLowerCase() !== this.bootstrap.email.toLowerCase()) {
      throw new LemmaComputerError("PLATFORM_UNAUTHENTICATED", "Platform enrollment requires its temporary session", 401);
    }
    const state = await this.authenticationState(current.user.id);
    if (state.passkeys < 1) {
      throw new LemmaComputerError("PLATFORM_PASSKEY_REQUIRED", "Register a passkey before completing platform enrollment", 409);
    }
    const client = await this.authenticationPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM "account" WHERE "userId"=$1 AND "providerId"='credential'`,
        [current.user.id],
      );
      await client.query(`DELETE FROM "session" WHERE "userId"=$1`, [current.user.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { enrolled: true };
  }

  async begin(returnPath?: string) {
    return {
      location: `/platform/sign-in?return=${encodeURIComponent(validReturnPath(returnPath))}`,
      cookie: "oc_platform_entry=; Path=/api/v1/platform; HttpOnly; SameSite=Strict; Max-Age=0",
    };
  }

  async beginStepUp(cookieHeader: string | undefined, returnPath?: string) {
    if (!await this.authenticate(cookieHeader)) {
      throw new LemmaComputerError("PLATFORM_UNAUTHENTICATED", "Sign in with a platform passkey", 401);
    }
    return {
      location: `/platform/sign-in?mode=step-up&return=${encodeURIComponent(validReturnPath(returnPath))}`,
      cookie: "oc_platform_step_up=; Path=/api/v1/platform; HttpOnly; SameSite=Strict; Max-Age=0",
    };
  }

  async authenticate(cookieHeader: string | undefined) {
    const current = await this.betterAuthSession(cookieHeader);
    if (!current) return null;
    const state = await this.authenticationState(current.user.id);
    if (!state.enrolled) return null;
    const operator = await this.store.resolveWorkforceOperator({
      issuer: platformIssuer,
      subject: current.user.id,
      workforceTenantId: platformRealm,
    });
    if (!operator) return null;
    const tokenHash = createHash("sha256").update(`platform-better-auth:${current.session.id}`).digest("hex");
    const existing = await this.store.getSession(tokenHash);
    if (existing) return existing;
    const authenticatedAt = new Date(current.session.createdAt);
    const expiresAt = new Date(current.session.expiresAt);
    const assurance: AuthenticationAssurance = { level: "aal2", factors: ["passkey"] };
    try {
      return await this.store.createSession({
        operatorId: operator.operatorId,
        tokenHash,
        assurance,
        authenticatedAt,
        recentStepUpAt: authenticatedAt,
        expiresAt,
        correlationId: `platform-better-auth:${current.session.id}`,
      });
    } catch (error) {
      const replay = await this.store.getSession(tokenHash);
      if (replay) return replay;
      throw error;
    }
  }

  async logout(cookieHeader: string | undefined, correlationId: string) {
    const platformSession = await this.authenticate(cookieHeader);
    if (platformSession) await this.store.revokeSession(platformSession, correlationId);
    const response = await this.authentication.handler(new Request(
      `${this.baseUrl}${platformAuthenticationBasePath}/sign-out`,
      { method: "POST", headers: { origin: this.baseUrl, ...(cookieHeader ? { cookie: cookieHeader } : {}) } },
    ));
    return responseCookies(response);
  }

  private async betterAuthSession(cookieHeader: string | undefined): Promise<PlatformBetterAuthSession | null> {
    if (!cookieHeader) return null;
    const session = await this.authentication.api.getSession({
      headers: requestHeaders({ cookie: cookieHeader }),
      query: { disableCookieCache: true, disableRefresh: true },
    }) as PlatformBetterAuthSession | null;
    return session?.session?.id && session.user?.id ? session : null;
  }

  private async authenticationState(userId: string) {
    const result = await this.authenticationPool.query(
      `SELECT
         (SELECT count(*)::integer FROM "passkey" WHERE "userId"=$1) AS passkeys,
         EXISTS(SELECT 1 FROM "account" WHERE "userId"=$1 AND "providerId"='credential') AS has_credential`,
      [userId],
    );
    const passkeys = Number(result.rows[0]?.passkeys ?? 0);
    const hasCredential = result.rows[0]?.has_credential === true;
    return { passkeys, hasCredential, enrolled: passkeys > 0 && !hasCredential };
  }
}

const validReturnPath = (value: string | undefined) => {
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/platform";
  const base = new URL("https://return.invalid");
  const parsed = new URL(value, base);
  return parsed.origin === base.origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/platform";
};

export const registerPlatformAuthenticationRoutes = (
  app: FastifyInstance,
  authentication: PlatformAuthentication,
  service: BetterAuthPlatformOperatorAuthenticationService,
  installationKind: "customer-managed" | "hosted" | "worktree",
) => {
  app.get(`${platformAuthenticationControlPath}/capabilities`, async (_request, reply) => reply.header("cache-control", "no-store").send({
    passkey: true,
    bootstrap: await service.bootstrapCapability(),
  }));
  app.post(`${platformAuthenticationControlPath}/bootstrap`, async (request, reply) => {
    service.assertBootstrapOrigin(request.headers.origin);
    const body = z.strictObject({ secret: z.string().min(32).max(512).optional() }).parse(request.body ?? {});
    if (installationKind === "hosted" && !body.secret) {
      throw new LemmaComputerError("PLATFORM_BOOTSTRAP_REJECTED", "Platform enrollment was not authorized", 401);
    }
    const result = await service.beginBootstrap({ secret: body.secret, headers: request.raw.headers });
    if (result.cookies.length) reply.header("set-cookie", result.cookies);
    return reply.header("cache-control", "no-store").send({ ready: true });
  });
  app.post(`${platformAuthenticationControlPath}/bootstrap/finalize`, async (request, reply) => {
    service.assertBootstrapOrigin(request.headers.origin);
    const result = await service.finalizeBootstrap(request.headers.cookie);
    return reply
      .header("cache-control", "no-store")
      .header("set-cookie", "lemmacomputer-platform.session_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
      .send(result);
  });
  app.all(`${platformAuthenticationControlPath}/*`, async (request, reply) => {
    const internal = new URL(request.raw.url ?? request.url, "http://control.internal");
    const suffix = internal.pathname.slice(platformAuthenticationControlPath.length);
    if (!allowedPlatformAuthenticationPath(suffix)) {
      return reply.code(404).header("cache-control", "no-store").send({ code: "NOT_FOUND", message: "Not found" });
    }
    const publicUrl = new URL(`${platformAuthenticationBasePath}${suffix}${internal.search}`, authentication.options.baseURL as string);
    const method = request.method.toUpperCase();
    const response = await authentication.handler(new Request(publicUrl, {
      method,
      headers: requestHeaders(request.raw.headers),
      body: method === "GET" || method === "HEAD" || request.body == null
        ? undefined
        : typeof request.body === "string" ? request.body : JSON.stringify(request.body),
    }));
    return forwardBetterAuthResponse(response, reply);
  });
};
