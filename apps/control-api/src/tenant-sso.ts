import { randomBytes } from "node:crypto";

import { discoverOIDCConfig } from "@better-auth/sso";
import { LemmaComputerError } from "@lemmacomputer/contracts";
import type {
  IdentityPolicyStore,
  OrganizationSsoConnectionSummary,
  OrganizationSsoTransition,
} from "@lemmacomputer/workspace-store";

export type TenantSsoProviderRegistration = {
  providerId: string;
  organizationId: string;
  domain: string;
  issuer: string;
} & (
  | {
      protocol: "oidc";
      clientId: string;
      clientSecret: string;
      discoveryEndpoint?: string;
    }
  | {
      protocol: "saml";
      entryPoint: string;
      certificate: string;
    }
);

export interface TenantSsoAuthenticationAdministration {
  registerProvider(
    headers: Headers,
    input: TenantSsoProviderRegistration,
  ): Promise<{ domainVerificationToken: string; redirectURI: string }>;
  requestDomainVerification(
    headers: Headers,
    providerId: string,
  ): Promise<{ domainVerificationToken: string; redirectURI: string }>;
  verifyDomain(headers: Headers, providerId: string): Promise<void>;
  startSignIn(
    headers: Headers,
    input: {
      providerId: string;
      callbackURL: string;
      errorCallbackURL?: string;
      requestSignUp?: boolean;
      loginHint?: string;
    },
  ): Promise<{ url: string; redirect: boolean; cookies: string[] }>;
  listAccounts(headers: Headers): Promise<Array<{ providerId: string }>>;
  updateProvider(headers: Headers, providerId: string, input: Record<string, unknown>): Promise<void>;
  refreshProviderMetadata(
    headers: Headers,
    providerId: string,
    input: { protocol: "oidc"; issuer: string } | { protocol: "saml"; metadata: string },
  ): Promise<void>;
  deleteProvider(headers: Headers, providerId: string): Promise<void>;
}

type BetterAuthTenantSsoServer = {
  options: {
    baseURL?: string;
    basePath?: string;
    trustedOrigins?: string[] | ((request?: Request) => string[] | Promise<string[]>);
  };
  api: unknown;
};

type BetterAuthTenantSsoApi = {
    registerSSOProvider(input: { headers: Headers; body: Record<string, unknown> }): Promise<unknown>;
    requestDomainVerification(input: { headers: Headers; body: { providerId: string } }): Promise<unknown>;
    verifyDomain(input: { headers: Headers; body: { providerId: string } }): Promise<unknown>;
    signInSSO(input: { headers: Headers; body: Record<string, unknown>; asResponse: true }): Promise<Response>;
    listUserAccounts(input: { headers: Headers }): Promise<unknown>;
    getSSOProvider(input: { headers: Headers; query: { providerId: string } }): Promise<unknown>;
    updateSSOProvider(input: { headers: Headers; body: Record<string, unknown> }): Promise<unknown>;
    deleteSSOProvider(input: { headers: Headers; body: { providerId: string } }): Promise<unknown>;
};

const responseRecord = (value: unknown) => value && typeof value === "object"
  ? value as Record<string, unknown>
  : {};

const trustedServerOrigins = async (authentication: BetterAuthTenantSsoServer) => {
  const configured = authentication.options.trustedOrigins;
  const values = typeof configured === "function" ? await configured(undefined) : configured ?? [];
  return new Set(values.map((value) => new URL(value).origin));
};

const oidcScopes = ["openid", "email", "profile", "offline_access"];
const oidcMapping = {
  id: "sub",
  email: "email",
  emailVerified: "email_verified",
  name: "name",
};

export const createBetterAuthTenantSsoAuthenticationAdministration = (
  authentication: BetterAuthTenantSsoServer,
): TenantSsoAuthenticationAdministration => {
  // The pinned Better Auth endpoints use schema-derived argument types. Keep
  // the cast at this adapter boundary and present a stable, narrow interface
  // to the rest of Control.
  const api = authentication.api as BetterAuthTenantSsoApi;
  const baseUrl = String(authentication.options.baseURL ?? "").replace(/\/$/, "");
  const basePath = String(authentication.options.basePath ?? "/api/auth").replace(/^([^/])/, "/$1").replace(/\/$/, "");
  return {
    registerProvider: async (headers, input) => {
      const provider = input.protocol === "oidc"
        ? {
            providerId: input.providerId,
            issuer: input.issuer,
            domain: input.domain,
            oidcConfig: {
              clientId: input.clientId,
              clientSecret: input.clientSecret,
              ...(input.discoveryEndpoint ? { discoveryEndpoint: input.discoveryEndpoint } : {}),
              pkce: true,
              scopes: oidcScopes,
              mapping: oidcMapping,
            },
          }
        : {
            providerId: input.providerId,
            issuer: input.issuer,
            domain: input.domain,
            samlConfig: {
              entryPoint: input.entryPoint,
              cert: input.certificate,
              callbackUrl: `${baseUrl}${basePath}/sso/saml2/sp/acs/${encodeURIComponent(input.providerId)}`,
              spMetadata: {},
              wantAssertionsSigned: true,
              authnRequestsSigned: false,
              signatureAlgorithm: "sha256",
              digestAlgorithm: "sha256",
              identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
              mapping: { id: "nameID", email: "email", name: "displayName" },
            },
          };
      // Product organizations and memberships are intentionally not copied to
      // Better Auth. Better Auth owns provider credentials and login proof;
      // LemmaComputer remains the sole tenant-admission authority.
      const result = responseRecord(await api.registerSSOProvider({ headers, body: provider }));
      const token = String(result.domainVerificationToken ?? "");
      if (!token) throw new LemmaComputerError("SSO_DOMAIN_PROOF_MISSING", "The authentication provider did not issue a domain proof", 502);
      return {
        domainVerificationToken: token,
        redirectURI: String(result.redirectURI ?? `${baseUrl}${basePath}/sso/callback/${encodeURIComponent(input.providerId)}`),
      };
    },
    requestDomainVerification: async (headers, providerId) => {
      const result = responseRecord(await api.requestDomainVerification({ headers, body: { providerId } }));
      const token = String(result.domainVerificationToken ?? "");
      if (!token) throw new LemmaComputerError("SSO_DOMAIN_PROOF_MISSING", "The authentication provider did not issue a domain proof", 502);
      return {
        domainVerificationToken: token,
        redirectURI: `${baseUrl}${basePath}/sso/callback/${encodeURIComponent(providerId)}`,
      };
    },
    verifyDomain: async (headers, providerId) => {
      await api.verifyDomain({ headers, body: { providerId } });
    },
    startSignIn: async (headers, input) => {
      const response = await api.signInSSO({
        headers,
        asResponse: true,
        body: {
          providerId: input.providerId,
          callbackURL: input.callbackURL,
          errorCallbackURL: input.errorCallbackURL ?? input.callbackURL,
          newUserCallbackURL: input.callbackURL,
          requestSignUp: input.requestSignUp ?? false,
          ...(input.loginHint ? { loginHint: input.loginHint } : {}),
        },
      });
      if (!response.ok) {
        throw new LemmaComputerError("SSO_SIGNIN_START_FAILED", "The authentication provider sign-in could not be started", 502, true);
      }
      const result = responseRecord(await response.json());
      return {
        url: String(result.url ?? ""),
        redirect: result.redirect === true,
        cookies: response.headers.getSetCookie(),
      };
    },
    listAccounts: async (headers) => {
      const result = await api.listUserAccounts({ headers });
      return Array.isArray(result)
        ? result.flatMap((account) => {
            const providerId = responseRecord(account).providerId;
            return typeof providerId === "string" ? [{ providerId }] : [];
          })
        : [];
    },
    updateProvider: async (headers, providerId, input) => {
      await api.updateSSOProvider({ headers, body: { providerId, ...input } });
    },
    refreshProviderMetadata: async (headers, providerId, input) => {
      if (input.protocol === "saml") {
        await api.updateSSOProvider({
          headers,
          body: { providerId, samlConfig: { idpMetadata: { metadata: input.metadata } } },
        });
        return;
      }
      const provider = responseRecord(await api.getSSOProvider({ headers, query: { providerId } }));
      const oidc = responseRecord(provider.oidcConfig);
      const allowedOrigins = await trustedServerOrigins(authentication);
      const discovered = await discoverOIDCConfig({
        issuer: input.issuer,
        existingConfig: {
          ...(typeof oidc.discoveryEndpoint === "string" ? { discoveryEndpoint: oidc.discoveryEndpoint } : {}),
          ...(typeof oidc.tokenEndpointAuthentication === "string"
            ? { tokenEndpointAuthentication: oidc.tokenEndpointAuthentication as "client_secret_basic" | "client_secret_post" }
            : {}),
        },
        isTrustedOrigin: (url) => allowedOrigins.has(new URL(url).origin),
      });
      await api.updateSSOProvider({
        headers,
        body: {
          providerId,
          oidcConfig: {
            discoveryEndpoint: discovered.discoveryEndpoint,
            authorizationEndpoint: discovered.authorizationEndpoint,
            tokenEndpoint: discovered.tokenEndpoint,
            jwksEndpoint: discovered.jwksEndpoint,
            userInfoEndpoint: discovered.userInfoEndpoint,
            tokenEndpointAuthentication: discovered.tokenEndpointAuthentication,
            scopes: oidcScopes,
            mapping: oidcMapping,
          },
        },
      });
    },
    deleteProvider: async (headers, providerId) => {
      await api.deleteSSOProvider({ headers, body: { providerId } });
    },
  };
};

type TenantSsoProjectionStore = Required<Pick<
  IdentityPolicyStore,
  | "listOrganizationSsoConnections"
  | "findEnforcedOrganizationSsoConnectionByDomain"
  | "createOrganizationSsoConnection"
  | "transitionOrganizationSsoConnection"
  | "prepareOrganizationSsoConfigurationChange"
>>;

export type TenantSsoRegistrationInput = {
  organizationId: string;
  actorUserId: string;
  domain: string;
  issuer: string;
} & (
  | {
      protocol: "oidc";
      clientId: string;
      clientSecret: string;
      discoveryEndpoint?: string;
    }
  | {
      protocol: "saml";
      entryPoint: string;
      certificate: string;
    }
);

export type TenantSsoCredentialRotationInput = {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
} & (
  | { protocol: "oidc"; clientId: string; clientSecret: string }
  | { protocol: "saml"; certificate: string }
);

export type TenantSsoMetadataRefreshInput = {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
} & (
  | { protocol: "oidc" }
  | { protocol: "saml"; metadata: string }
);

const defaultProviderId = () => `sso_${randomBytes(24).toString("base64url")}`;

const requireConnection = async (
  store: TenantSsoProjectionStore,
  organizationId: string,
  connectionId: string,
) => {
  const connection = (await store.listOrganizationSsoConnections(organizationId))
    .find((candidate) => candidate.id === connectionId);
  if (!connection) {
    throw new LemmaComputerError("SSO_CONNECTION_NOT_FOUND", "SSO connection not found", 404);
  }
  return connection;
};

const requireDistinctOidcCredentials = (input: TenantSsoRegistrationInput | TenantSsoCredentialRotationInput) => {
  if (input.protocol === "oidc" && input.clientId === input.clientSecret) {
    throw new LemmaComputerError(
      "SSO_CREDENTIALS_INVALID",
      "The client secret must be the provider secret value, not the client ID",
      400,
    );
  }
};

export class TenantSsoAdministrationService {
  constructor(
    private readonly authentication: TenantSsoAuthenticationAdministration,
    private readonly store: TenantSsoProjectionStore,
    private readonly providerIdFactory: () => string = defaultProviderId,
  ) {}

  list(organizationId: string) {
    return this.store.listOrganizationSsoConnections(organizationId);
  }

  async register(headers: Headers, input: TenantSsoRegistrationInput) {
    requireDistinctOidcCredentials(input);
    const providerId = this.providerIdFactory();
    const registered = await this.authentication.registerProvider(headers, {
      ...input,
      providerId,
      organizationId: input.organizationId,
    });
    try {
      const connection = await this.store.createOrganizationSsoConnection({
        organizationId: input.organizationId,
        authenticationProviderId: providerId,
        protocol: input.protocol,
        domain: input.domain,
        issuer: input.issuer,
        createdBy: input.actorUserId,
      });
      return {
        connection,
        domainVerification: {
          token: registered.domainVerificationToken,
          redirectURI: registered.redirectURI,
        },
      };
    } catch (error) {
      await this.authentication.deleteProvider(headers, providerId).catch(() => undefined);
      throw error;
    }
  }

  async verifyDomain(
    headers: Headers,
    organizationId: string,
    connectionId: string,
    actorUserId: string,
  ) {
    const connection = await requireConnection(this.store, organizationId, connectionId);
    await this.authentication.verifyDomain(headers, connection.authenticationProviderId);
    return this.transition(organizationId, connectionId, "domain_verified", actorUserId);
  }

  async requestDomainVerification(headers: Headers, organizationId: string, connectionId: string) {
    const connection = await requireConnection(this.store, organizationId, connectionId);
    if (connection.domainVerifiedAt || connection.state === "disconnected") {
      throw new LemmaComputerError("SSO_DOMAIN_PROOF_UNAVAILABLE", "This SSO connection does not need a DNS proof", 409);
    }
    const proof = await this.authentication.requestDomainVerification(
      headers,
      connection.authenticationProviderId,
    );
    return {
      connectionId: connection.id,
      providerId: connection.authenticationProviderId,
      domain: connection.domain,
      token: proof.domainVerificationToken,
      redirectURI: proof.redirectURI,
    };
  }

  async startTest(headers: Headers, organizationId: string, connectionId: string) {
    const connection = await requireConnection(this.store, organizationId, connectionId);
    if (connection.protocol === "oidc") {
      // A provider test is also the compatibility boundary for stored OIDC
      // metadata. Better Auth reads Entra's discovered UserInfo endpoint, whose
      // standard email field is `email` rather than the ID-token-only
      // `preferred_username` claim. Refresh before the test so existing saved
      // connections receive the corrected scopes and mapping automatically.
      await this.authentication.refreshProviderMetadata(
        headers,
        connection.authenticationProviderId,
        { protocol: "oidc", issuer: connection.issuer },
      );
    }
    const callbackURL = `/sso-test/${encodeURIComponent(connectionId)}`;
    const started = await this.authentication.startSignIn(headers, {
      providerId: connection.authenticationProviderId,
      callbackURL,
      errorCallbackURL: callbackURL,
    });
    if (!started.url || !started.redirect) {
      throw new LemmaComputerError("SSO_TEST_START_FAILED", "The SSO provider test could not be started", 502);
    }
    return { location: started.url, cookies: started.cookies };
  }

  async startEnforcedSignIn(headers: Headers, email: string, returnPath: "/" | "/invite") {
    const normalizedEmail = email.trim().toLowerCase();
    const separator = normalizedEmail.lastIndexOf("@");
    const domain = separator > 0 ? normalizedEmail.slice(separator + 1) : "";
    const connection = domain
      ? await this.store.findEnforcedOrganizationSsoConnectionByDomain(domain)
      : null;
    if (!connection) {
      throw new LemmaComputerError(
        "COMPANY_SSO_UNAVAILABLE",
        "Company SSO is not available for this email. Use another sign-in method or contact your organization administrator.",
        400,
      );
    }
    const started = await this.authentication.startSignIn(headers, {
      providerId: connection.authenticationProviderId,
      callbackURL: returnPath,
      requestSignUp: true,
      loginHint: normalizedEmail,
    });
    if (!started.url || !started.redirect) {
      throw new LemmaComputerError("COMPANY_SSO_UNAVAILABLE", "Company SSO could not be started", 502, true);
    }
    return { location: started.url, cookies: started.cookies };
  }

  async startInvitationSignIn(headers: Headers, organizationId: string, email: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const connection = await this.invitationConnection(organizationId, email);
    if (!connection) {
      throw new LemmaComputerError(
        "COMPANY_SSO_UNAVAILABLE",
        "Company SSO is not available for this invitation. Use another sign-in method or contact the organization administrator.",
        400,
      );
    }
    const started = await this.authentication.startSignIn(headers, {
      providerId: connection.authenticationProviderId,
      callbackURL: "/invite",
      requestSignUp: true,
      loginHint: normalizedEmail,
    });
    if (!started.url || !started.redirect) {
      throw new LemmaComputerError("COMPANY_SSO_UNAVAILABLE", "Company SSO could not be started", 502, true);
    }
    return { location: started.url, cookies: started.cookies };
  }

  async isInvitationSignInAvailable(organizationId: string, email: string) {
    return Boolean(await this.invitationConnection(organizationId, email));
  }

  private async invitationConnection(organizationId: string, email: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const separator = normalizedEmail.lastIndexOf("@");
    const domain = separator > 0 ? normalizedEmail.slice(separator + 1) : "";
    return (await this.store.listOrganizationSsoConnections(organizationId)).find((candidate) => (
      candidate.domain === domain
      && candidate.domainVerifiedAt
      && candidate.lastTestedAt
      && ["active", "enforced"].includes(candidate.state)
    ));
  }

  async completeTest(
    headers: Headers,
    organizationId: string,
    connectionId: string,
    actorUserId: string,
  ) {
    const connection = await requireConnection(this.store, organizationId, connectionId);
    const accounts = await this.authentication.listAccounts(headers);
    if (!accounts.some((account) => account.providerId === connection.authenticationProviderId)) {
      throw new LemmaComputerError(
        "SSO_TEST_PROOF_MISSING",
        "The signed-in account does not prove a successful login through this SSO provider",
        403,
      );
    }
    return this.transition(organizationId, connectionId, "test_succeeded", actorUserId);
  }

  transition(
    organizationId: string,
    connectionId: string,
    action: OrganizationSsoTransition,
    actorUserId: string,
  ): Promise<OrganizationSsoConnectionSummary> {
    return this.store.transitionOrganizationSsoConnection({
      organizationId,
      connectionId,
      action,
      actorUserId,
    });
  }

  async rotateCredentials(headers: Headers, input: TenantSsoCredentialRotationInput) {
    requireDistinctOidcCredentials(input);
    const connection = await requireConnection(this.store, input.organizationId, input.connectionId);
    if (connection.protocol !== input.protocol) {
      throw new LemmaComputerError("SSO_PROTOCOL_MISMATCH", "The replacement credentials do not match this SSO protocol", 409);
    }
    // Fence tenant routing before touching the authentication credential. If
    // Better Auth rejects the replacement, the old provider remains stored but
    // is no longer eligible for company sign-in until an administrator retries
    // and completes a fresh provider test and recovery confirmation.
    const pending = await this.store.prepareOrganizationSsoConfigurationChange({
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      change: "credentials_rotated",
      actorUserId: input.actorUserId,
    });
    await this.authentication.updateProvider(
      headers,
      connection.authenticationProviderId,
      input.protocol === "oidc"
        ? { oidcConfig: { clientId: input.clientId, clientSecret: input.clientSecret } }
        : { samlConfig: { cert: input.certificate } },
    );
    return pending;
  }

  async refreshMetadata(headers: Headers, input: TenantSsoMetadataRefreshInput) {
    const connection = await requireConnection(this.store, input.organizationId, input.connectionId);
    if (connection.protocol !== input.protocol) {
      throw new LemmaComputerError("SSO_PROTOCOL_MISMATCH", "The metadata does not match this SSO protocol", 409);
    }
    // Stale or invalid metadata must never remain eligible for domain routing.
    // Fence the product projection first, then refresh only Better Auth's
    // credential/configuration record. A failed refresh remains pending.
    const pending = await this.store.prepareOrganizationSsoConfigurationChange({
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      change: "metadata_refreshed",
      actorUserId: input.actorUserId,
    });
    await this.authentication.refreshProviderMetadata(
      headers,
      connection.authenticationProviderId,
      input.protocol === "oidc"
        ? { protocol: "oidc", issuer: connection.issuer }
        : { protocol: "saml", metadata: input.metadata },
    );
    return pending;
  }

  async disconnect(
    headers: Headers,
    organizationId: string,
    connectionId: string,
    actorUserId: string,
  ) {
    const connection = await requireConnection(this.store, organizationId, connectionId);
    const disconnected = await this.transition(organizationId, connectionId, "disconnect", actorUserId);
    // Product state is changed first so a Better Auth cleanup failure remains
    // fail-closed. Raw provider sign-in is never exposed to the browser.
    await this.authentication.deleteProvider(headers, connection.authenticationProviderId);
    return disconnected;
  }
}
