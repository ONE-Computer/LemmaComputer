import { passkey } from "@better-auth/passkey";
import {
  DataEncryptionAlgorithm,
  DigestAlgorithm,
  KeyEncryptionAlgorithm,
  SignatureAlgorithm,
  sso,
} from "@better-auth/sso";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { fromNodeHeaders } from "better-auth/node";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { FastifyInstance } from "fastify";
import { isIP } from "node:net";

import type { TransactionalEmailAdapter, TransactionalEmailKind } from "./transactional-email.js";

export const customerAuthenticationBasePath = "/api/v1/auth/customer";
export const customerAuthenticationControlPath = "/v1/auth/customer";

type SocialProviderCredentials = {
  clientId: string;
  clientSecret: string;
};

export type CustomerAuthenticationOptions = {
  database: NonNullable<BetterAuthOptions["database"]>;
  baseUrl: string;
  trustedOrigins: string[];
  ssoTrustedOrigins?: string[];
  versionedSecrets: Array<{ version: number; value: string }>;
  legacySecret?: string;
  installationKind: "customer-managed" | "hosted" | "worktree";
  trustedProxyCidrs?: string[];
  email: TransactionalEmailAdapter;
  passkey: { rpId: string; origin: string };
  socialProviders?: {
    google?: SocialProviderCredentials;
    microsoft?: SocialProviderCredentials & { tenantId?: string };
  };
};

const exactOrigin = (value: string, label: string) => {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== value) {
    throw new Error(`${label} must be an exact origin without credentials, path, query, or fragment`);
  }
  return url;
};

const validProxyNetwork = (value: string) => {
  const [address, prefix, extra] = value.split("/");
  const family = isIP(address ?? "");
  if (!family || extra !== undefined) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const numeric = Number(prefix);
  return numeric >= 0 && numeric <= (family === 4 ? 32 : 128);
};

export const parseVersionedBetterAuthSecrets = (value: string) => {
  if (!value.trim()) throw new Error("BETTER_AUTH_SECRETS is required");
  const secrets = value.split(",").map((entry) => {
    const separator = entry.indexOf(":");
    if (separator < 1) throw new Error("Every Better Auth secret must use version:value format");
    const version = Number(entry.slice(0, separator));
    const secret = entry.slice(separator + 1);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error("Every Better Auth secret version must be a positive integer");
    if (secret.length < 32) throw new Error("Every Better Auth secret must contain at least 32 characters");
    return { version, value: secret };
  });
  for (let index = 1; index < secrets.length; index += 1) {
    if (secrets[index]!.version >= secrets[index - 1]!.version) {
      throw new Error("Better Auth secret versions must be unique and strictly descending with the current key first");
    }
  }
  return secrets;
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;",
}[character]!));

const deliverAuthenticationEmail = async (
  adapter: TransactionalEmailAdapter,
  kind: Extract<TransactionalEmailKind, "email-verification" | "password-recovery">,
  recipient: string,
  url: string,
) => {
  const action = kind === "email-verification" ? "Verify your email" : "Reset your password";
  const purpose = kind === "email-verification"
    ? "Finish creating your LemmaComputer account."
    : "Use this link to choose a new LemmaComputer password.";
  const result = await adapter.send({
    kind,
    to: recipient,
    subject: `${action} for LemmaComputer`,
    text: `${purpose}\n\n${url}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>${escapeHtml(purpose)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(action)}</a></p><p>If you did not request this, you can ignore this email.</p>`,
  });
  if (!result.accepted) throw new Error("Transactional authentication email delivery failed");
};

const safeBetterAuthLogger = {
  level: "error" as const,
  log: (level: "debug" | "info" | "warn" | "error") => {
    const record = JSON.stringify({ component: "customer-authentication", level, event: "authentication_operation_failed" });
    if (level === "error") console.error(record);
    else if (level === "warn") console.warn(record);
    else console.info(record);
  },
};

const validateOptions = (options: CustomerAuthenticationOptions) => {
  const baseUrl = exactOrigin(options.baseUrl, "Better Auth base URL");
  if (!options.trustedOrigins.length) throw new Error("At least one trusted authentication origin is required");
  const trustedOrigins = options.trustedOrigins.map((origin) => exactOrigin(origin, "Trusted authentication origin").origin);
  if (new Set(trustedOrigins).size !== trustedOrigins.length) throw new Error("Trusted authentication origins must be unique");
  if (!trustedOrigins.includes(baseUrl.origin)) throw new Error("Better Auth base URL must be a trusted authentication origin");
  const ssoTrustedOrigins = (options.ssoTrustedOrigins ?? []).map((origin) => {
    const parsed = exactOrigin(origin, "Company SSO trusted IdP origin");
    if (parsed.protocol !== "https:") throw new Error("Company SSO trusted IdP origins must use HTTPS");
    if (parsed.hostname.includes("*")) throw new Error("Company SSO trusted IdP origin must be an exact origin without wildcards");
    return parsed.origin;
  });
  if (new Set(ssoTrustedOrigins).size !== ssoTrustedOrigins.length) {
    throw new Error("Company SSO trusted IdP origins must be unique");
  }
  if (options.installationKind === "hosted" && baseUrl.protocol !== "https:") {
    throw new Error("Hosted customer authentication requires an HTTPS base URL");
  }
  if (options.installationKind === "hosted" && !options.trustedProxyCidrs?.length) {
    throw new Error("Hosted customer authentication requires an explicit trusted proxy CIDR list");
  }
  if (options.trustedProxyCidrs?.some((network) => !validProxyNetwork(network))) {
    throw new Error("Every trusted authentication proxy must be a valid IP address or CIDR network");
  }
  if (!options.versionedSecrets.length) throw new Error("At least one versioned Better Auth secret is required");
  const secretVersions = new Set<number>();
  let priorSecretVersion = Number.POSITIVE_INFINITY;
  for (const secret of options.versionedSecrets) {
    if (!Number.isSafeInteger(secret.version) || secret.version < 1 || secretVersions.has(secret.version) || secret.version >= priorSecretVersion) {
      throw new Error("Better Auth secret versions must be unique positive integers in strictly descending order");
    }
    if (secret.value.length < 32) throw new Error("Every Better Auth secret must contain at least 32 characters");
    secretVersions.add(secret.version);
    priorSecretVersion = secret.version;
  }
  if (options.legacySecret !== undefined && options.legacySecret.length < 32) {
    throw new Error("The legacy Better Auth secret must contain at least 32 characters");
  }
  const passkeyOrigin = exactOrigin(options.passkey.origin, "Passkey origin");
  if (!trustedOrigins.includes(passkeyOrigin.origin)) throw new Error("Passkey origin must be a trusted authentication origin");
  if (options.passkey.rpId !== passkeyOrigin.hostname) throw new Error("Passkey RP ID must match the passkey origin hostname");
  for (const [provider, credentials] of Object.entries(options.socialProviders ?? {})) {
    if (!credentials) continue;
    if (!credentials.clientId.trim() || !credentials.clientSecret.trim()) {
      throw new Error(`${provider} social authentication requires both client ID and client secret`);
    }
  }
  return { baseUrl: baseUrl.origin, trustedOrigins, ssoTrustedOrigins };
};

export const createInMemoryCustomerAuthenticationDatabase = () => memoryAdapter({
  user: [],
  session: [],
  account: [],
  verification: [],
  twoFactor: [],
  passkey: [],
  rateLimit: [],
  ssoProvider: [],
});

const createCustomerAuthenticationForMode = (
  options: CustomerAuthenticationOptions,
  mode: "customer" | "company-sso",
) => {
  const validated = validateOptions(options);
  const secureCookies = options.installationKind === "hosted" || validated.baseUrl.startsWith("https://");
  const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  if (mode === "customer" && options.socialProviders?.google) socialProviders.google = {
    ...options.socialProviders.google,
    disableIdTokenSignIn: true,
  };
  if (mode === "customer" && options.socialProviders?.microsoft) socialProviders.microsoft = {
    ...options.socialProviders.microsoft,
    tenantId: options.socialProviders.microsoft.tenantId ?? "common",
    disableIdTokenSignIn: true,
  };

  return betterAuth({
    appName: "LemmaComputer",
    baseURL: validated.baseUrl,
    basePath: customerAuthenticationBasePath,
    // Better Auth uses this function without a Request during server-side
    // auth.api calls such as OIDC discovery. IdP origins are therefore
    // available to the SSO adapter without also becoming accepted browser
    // CSRF origins for ordinary HTTP requests.
    trustedOrigins: (request) => request
      ? validated.trustedOrigins
      : [...validated.trustedOrigins, ...validated.ssoTrustedOrigins],
    database: options.database,
    secrets: options.versionedSecrets,
    secret: options.legacySecret,
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: secureCookies,
      disableCSRFCheck: false,
      disableOriginCheck: false,
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: {
        httpOnly: true,
        secure: secureCookies,
        sameSite: "lax",
        path: "/",
      },
      ipAddress: options.trustedProxyCidrs?.length ? { trustedProxies: options.trustedProxyCidrs } : undefined,
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => deliverAuthenticationEmail(options.email, "email-verification", user.email, url),
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => deliverAuthenticationEmail(options.email, "password-recovery", user.email, url),
    },
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: "database",
      accountLinking: {
        enabled: true,
        // Consumer Google/Microsoft sign-in must be linked explicitly from a
        // fresh LemmaComputer session. The isolated company-SSO callback may
        // link only after Better Auth has verified the provider's DNS domain
        // and the provider email exactly matches a verified local identity.
        disableImplicitLinking: mode === "customer",
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
        // Microsoft personal-account tokens do not consistently carry an
        // email_verified claim. Trust the validated Microsoft OAuth proof only
        // for this explicit, fresh-session link flow; implicit linking remains
        // disabled above and the provider email must still match.
        trustedProviders: mode === "customer" ? ["microsoft"] : [],
      },
    },
    verification: { storeIdentifier: "hashed" },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 15,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-up/email": { window: 60, max: 5 },
        "/sign-in/email": { window: 60, max: 10 },
        "/request-password-reset": { window: 60, max: 5 },
        "/two-factor/*": { window: 60, max: 10 },
        "/passkey/*": { window: 60, max: 20 },
      },
    },
    socialProviders,
    plugins: [
      twoFactor({
        issuer: "LemmaComputer",
        skipVerificationOnEnable: false,
        allowPasswordless: false,
        twoFactorCookieMaxAge: 10 * 60,
        trustDeviceMaxAge: 30 * 24 * 60 * 60,
        accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 15 * 60 },
      }),
      passkey({
        rpID: options.passkey.rpId,
        rpName: "LemmaComputer",
        origin: options.passkey.origin,
        registration: { requireSession: true },
      }),
      sso({
        // Better Auth's SAML callback does not carry the OIDC-only
        // requestSignUp override. Allow the verified provider to create an
        // authentication identity; LemmaComputer still grants no product
        // access without an existing membership, invitation, or explicit
        // admission policy. The raw SSO initiation route is blocked below.
        disableImplicitSignUp: false,
        organizationProvisioning: { disabled: true },
        domainVerification: { enabled: true, tokenPrefix: "lemmacomputer-sso" },
        saml: {
          enableInResponseToValidation: true,
          allowIdpInitiated: false,
          requestTTL: 5 * 60 * 1_000,
          clockSkew: 2 * 60 * 1_000,
          requireTimestamps: true,
          maxResponseSize: 256 * 1024,
          maxMetadataSize: 100 * 1024,
          algorithms: {
            onDeprecated: "reject",
            allowedSignatureAlgorithms: [
              SignatureAlgorithm.RSA_SHA256,
              SignatureAlgorithm.RSA_SHA384,
              SignatureAlgorithm.RSA_SHA512,
              SignatureAlgorithm.ECDSA_SHA256,
              SignatureAlgorithm.ECDSA_SHA384,
              SignatureAlgorithm.ECDSA_SHA512,
            ],
            allowedDigestAlgorithms: [DigestAlgorithm.SHA256, DigestAlgorithm.SHA384, DigestAlgorithm.SHA512],
            allowedKeyEncryptionAlgorithms: [KeyEncryptionAlgorithm.RSA_OAEP, KeyEncryptionAlgorithm.RSA_OAEP_SHA256],
            allowedDataEncryptionAlgorithms: [
              DataEncryptionAlgorithm.AES_128_CBC,
              DataEncryptionAlgorithm.AES_192_CBC,
              DataEncryptionAlgorithm.AES_256_CBC,
              DataEncryptionAlgorithm.AES_128_GCM,
              DataEncryptionAlgorithm.AES_192_GCM,
              DataEncryptionAlgorithm.AES_256_GCM,
            ],
          },
        },
      }),
    ],
    // Better Auth error objects can contain OAuth state, authorization codes,
    // or provider response details. Emit only a bounded event classification;
    // request correlation and HTTP outcome remain in Control's redacted log.
    logger: safeBetterAuthLogger,
  });
};

export const createCustomerAuthentication = (options: CustomerAuthenticationOptions) => (
  createCustomerAuthenticationForMode(options, "customer")
);

export const createCustomerSsoAuthentication = (options: CustomerAuthenticationOptions) => (
  createCustomerAuthenticationForMode({ ...options, socialProviders: undefined }, "company-sso")
);

export type CustomerAuthentication = ReturnType<typeof createCustomerAuthentication>;

const requestBody = (body: unknown, contentType: string | undefined) => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (contentType?.startsWith("application/x-www-form-urlencoded") && typeof body === "object") {
    return new URLSearchParams(Object.entries(body as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
  }
  return JSON.stringify(body);
};

export const customerAuthenticationOperationOutcome = (response: Response) => {
  if (response.status >= 400) return "failed" as const;
  const location = response.headers.get("location");
  if (!location) return "succeeded" as const;
  try {
    return new URL(location, "http://control.internal").searchParams.has("error") ? "failed" as const : "succeeded" as const;
  } catch {
    return "failed" as const;
  }
};

export const registerCustomerAuthenticationRoutes = (
  app: FastifyInstance,
  authentication: Pick<CustomerAuthentication, "api" | "handler" | "options">,
  companySsoAuthentication?: Pick<CustomerAuthentication, "api" | "handler" | "options">,
) => {
  app.all(`${customerAuthenticationControlPath}/*`, async (request, reply) => {
    const internalUrl = new URL(request.raw.url ?? request.url, "http://control.internal");
    const publicPath = `${customerAuthenticationBasePath}${internalUrl.pathname.slice(customerAuthenticationControlPath.length)}`;
    const publicUrl = new URL(`${publicPath}${internalUrl.search}`, authentication.options.baseURL as string);
    const method = request.method.toUpperCase();
    const guardedSsoAdministrationPaths = new Set([
      `${customerAuthenticationBasePath}/sso/register`,
      `${customerAuthenticationBasePath}/sso/providers`,
      `${customerAuthenticationBasePath}/sso/get-provider`,
      `${customerAuthenticationBasePath}/sso/update-provider`,
      `${customerAuthenticationBasePath}/sso/delete-provider`,
      `${customerAuthenticationBasePath}/sso/request-domain-verification`,
      `${customerAuthenticationBasePath}/sso/verify-domain`,
      `${customerAuthenticationBasePath}/sign-in/sso`,
    ]);
    if (guardedSsoAdministrationPaths.has(publicUrl.pathname)) {
      return reply.code(404).header("cache-control", "no-store").send({
        code: "NOT_FOUND",
        message: "Not found",
      });
    }
    const actionByPath: Record<string, string> = {
      [`${customerAuthenticationBasePath}/link-social`]: "identity.link_started",
      [`${customerAuthenticationBasePath}/unlink-account`]: "identity.unlink_completed",
      [`${customerAuthenticationBasePath}/two-factor/enable`]: "mfa.enrollment_started",
      [`${customerAuthenticationBasePath}/two-factor/verify-totp`]: "mfa.enrollment_verified",
      [`${customerAuthenticationBasePath}/two-factor/disable`]: "mfa.disabled",
      [`${customerAuthenticationBasePath}/passkey/verify-registration`]: "passkey.registered",
      [`${customerAuthenticationBasePath}/revoke-other-sessions`]: "session.other_devices_revoked",
      [`${customerAuthenticationBasePath}/revoke-sessions`]: "session.all_devices_revoked",
    };
    const callbackProvider = publicUrl.pathname.match(new RegExp(`^${customerAuthenticationBasePath}/callback/(google|microsoft)$`))?.[1];
    const securityAction = actionByPath[publicUrl.pathname] ?? (callbackProvider ? "identity.provider_callback" : undefined);
    const actor = securityAction ? await authentication.api.getSession({
      headers: fromNodeHeaders(request.raw.headers),
      query: { disableCookieCache: true, disableRefresh: true },
    }) as { session?: { id?: string }; user?: { id?: string } } | null : null;
    if (method === "POST" && publicUrl.pathname === `${customerAuthenticationBasePath}/link-social`) {
      const current = await authentication.api.getSession({
        headers: fromNodeHeaders(request.raw.headers),
        query: { disableCookieCache: true, disableRefresh: true },
      }) as { session?: { createdAt?: Date | string; updatedAt?: Date | string } } | null;
      const sessionTime = Math.max(
        new Date(current?.session?.createdAt ?? 0).getTime(),
        new Date(current?.session?.updatedAt ?? 0).getTime(),
      );
      const freshAgeMs = (authentication.options.session?.freshAge ?? 0) * 1_000;
      if (!current || !freshAgeMs || !Number.isFinite(sessionTime) || Date.now() - sessionTime > freshAgeMs) {
        app.log.info({
          event: "customer_authentication_security_event",
          action: "identity.link_started",
          outcome: "denied",
          reasonCode: "SESSION_NOT_FRESH",
          correlationId: request.id,
          actorUserId: actor?.user?.id,
          authenticationSessionId: actor?.session?.id,
        }, "customer authentication security event");
        return reply.code(401).header("cache-control", "no-store").send({
          code: "SESSION_NOT_FRESH",
          message: "Sign in again before linking another identity provider.",
        });
      }
    }
    const isCompanySsoCallback = new RegExp(
      `^${customerAuthenticationBasePath}/sso/(?:callback(?:/|$)|saml2/(?:callback|sp/(?:acs|slo))(?:/|$))`,
    ).test(publicUrl.pathname);
    const callbackAuthentication = isCompanySsoCallback
      ? companySsoAuthentication ?? authentication
      : authentication;
    const response = await callbackAuthentication.handler(new Request(publicUrl, {
      method,
      headers: fromNodeHeaders(request.raw.headers),
      body: method === "GET" || method === "HEAD" ? undefined : requestBody(request.body, request.headers["content-type"]),
    }));

    if (securityAction) {
      const inputProvider = request.body && typeof request.body === "object"
        ? (request.body as { provider?: unknown; providerId?: unknown }).provider
          ?? (request.body as { providerId?: unknown }).providerId
        : undefined;
      const provider = callbackProvider ?? (["google", "microsoft"].includes(String(inputProvider)) ? String(inputProvider) : undefined);
      app.log.info({
        event: "customer_authentication_security_event",
        action: securityAction,
        outcome: customerAuthenticationOperationOutcome(response),
        correlationId: request.id,
        actorUserId: actor?.user?.id,
        authenticationSessionId: actor?.session?.id,
        provider,
      }, "customer authentication security event");
    }

    reply.hijack();
    reply.raw.statusCode = response.status;
    reply.raw.statusMessage = response.statusText;
    for (const [name, value] of response.headers) {
      if (name !== "set-cookie" && name !== "content-length" && name !== "transfer-encoding") {
        reply.raw.setHeader(name, value);
      }
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.raw.setHeader("set-cookie", cookies);
    if (method === "HEAD" || response.body === null) reply.raw.end();
    else reply.raw.end(Buffer.from(await response.arrayBuffer()));
    return reply;
  });
};
