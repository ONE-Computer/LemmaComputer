import { LemmaComputerError, recentAuthenticationStepUpWindowMs } from "@lemmacomputer/contracts";
import { createHash, randomBytes } from "node:crypto";
import type {
  CustomerProductMembership,
  CustomerProductSessionStore,
  SessionPrincipal,
} from "@lemmacomputer/workspace-store";
import { z } from "zod";
import type { CustomerAuthentication } from "./customer-authentication.js";

export type { CustomerProductSessionStore } from "@lemmacomputer/workspace-store";

export const customerInvitationContextMaxAgeSeconds = 7 * 24 * 60 * 60;

const customerAuthenticationSessionSchema = z.object({
  session: z.object({
    id: z.uuid(),
    userId: z.uuid(),
    createdAt: z.coerce.date().optional(),
    updatedAt: z.coerce.date().optional(),
    expiresAt: z.coerce.date(),
  }),
  user: z.object({
    id: z.uuid(),
    email: z.email(),
    name: z.string().trim().min(1).max(255),
    emailVerified: z.boolean(),
    twoFactorEnabled: z.boolean().optional(),
  }),
});

export type CustomerAuthenticationSession = z.infer<typeof customerAuthenticationSessionSchema>;

export interface CustomerAuthenticationSessionReader {
  getSession(headers: Headers): Promise<unknown | null>;
}

export const createBetterAuthSessionReader = (
  authentication: Pick<CustomerAuthentication, "api">,
): CustomerAuthenticationSessionReader => ({
  getSession: (headers) => authentication.api.getSession({
    headers,
    query: { disableCookieCache: true, disableRefresh: true },
  }),
});

type AuthenticatedResolutionBase = {
  accountUserId: string;
  authenticationSessionId: string;
  user: { id: string; email: string; name: string };
  memberships: CustomerProductMembership[];
};

export type CustomerProductAuthenticationResolution =
  | { status: "anonymous" }
  | (AuthenticatedResolutionBase & { status: "membership-required" })
  | (AuthenticatedResolutionBase & { status: "authorized"; principal: SessionPrincipal });

export class CustomerProductAuthenticationService {
  constructor(
    private readonly reader: CustomerAuthenticationSessionReader,
    private readonly store: CustomerProductSessionStore,
    private readonly now: () => Date = () => new Date(),
    private readonly options: {
      installationKind: "customer-managed" | "hosted" | "worktree";
    } = { installationKind: "customer-managed" },
  ) {}

  private async verifiedSession(headers: Headers) {
    const raw = await this.reader.getSession(headers);
    if (!raw) return null;
    const parsed = customerAuthenticationSessionSchema.safeParse(raw);
    if (!parsed.success) {
      const sessionIdInvalid = parsed.error.issues.some((issue) => issue.path.join(".") === "session.id");
      throw new LemmaComputerError(
        "AUTHENTICATION_SESSION_INVALID",
        sessionIdInvalid ? "The authentication session identifier is invalid" : "The authentication session is invalid",
        401,
      );
    }
    if (!parsed.data.user.emailVerified || parsed.data.session.userId !== parsed.data.user.id) return null;
    if (parsed.data.session.expiresAt <= this.now()) return null;
    return parsed.data;
  }

  private async synchronize(headers: Headers) {
    const authenticated = await this.verifiedSession(headers);
    if (!authenticated) return null;
    const account = await this.store.ensureCustomerAccount({ accountUserId: authenticated.user.id });
    if (account.status !== "active") {
      throw new LemmaComputerError("ACCOUNT_DISABLED", "This account is disabled", 403);
    }
    const memberships = await this.store.listCustomerMemberships(account.accountUserId);
    return { authenticated, account, memberships };
  }

  async resolve(headers: Headers): Promise<CustomerProductAuthenticationResolution> {
    const synchronized = await this.synchronize(headers);
    if (!synchronized) return { status: "anonymous" };
    const { authenticated, account, memberships } = synchronized;
    const base: AuthenticatedResolutionBase = {
      accountUserId: account.accountUserId,
      authenticationSessionId: authenticated.session.id,
      user: {
        id: authenticated.user.id,
        email: authenticated.user.email,
        name: authenticated.user.name,
      },
      memberships,
    };
    const principal = await this.store.getCustomerProductSession({
      authenticationSessionId: authenticated.session.id,
      accountUserId: account.accountUserId,
      now: this.now(),
    });
    return principal
      ? { ...base, status: "authorized", principal }
      : { ...base, status: "membership-required" };
  }

  async selectMembership(headers: Headers, membershipId: string) {
    const synchronized = await this.synchronize(headers);
    if (!synchronized) throw new LemmaComputerError("UNAUTHENTICATED", "Authentication is required", 401);
    const parsedMembershipId = z.uuid().safeParse(membershipId);
    if (!parsedMembershipId.success) throw new LemmaComputerError("MEMBERSHIP_INVALID", "The membership identifier is invalid", 400);
    return this.store.selectCustomerProductSession({
      authenticationSessionId: synchronized.authenticated.session.id,
      accountUserId: synchronized.account.accountUserId,
      membershipId: parsedMembershipId.data,
      expiresAt: synchronized.authenticated.session.expiresAt,
      now: this.now(),
    });
  }

  async createOrganization(headers: Headers, input: { displayName: string; idempotencyKey: string }) {
    const synchronized = await this.synchronize(headers);
    if (!synchronized) throw new LemmaComputerError("UNAUTHENTICATED", "Authentication is required", 401);
    if (!this.store.createCustomerOrganization) {
      throw new LemmaComputerError(
        "ORGANIZATION_SIGNUP_NOT_CONFIGURED",
        "Organization signup is unavailable",
        503,
        true,
      );
    }
    const organizationDisplayName = z.string()
      .transform((value) => value.trim().replace(/\s+/g, " "))
      .pipe(z.string().min(2).max(100))
      .parse(input.displayName);
    const idempotencyKey = z.uuid().parse(input.idempotencyKey);
    const { authenticated, account } = synchronized;
    return this.store.createCustomerOrganization({
      accountUserId: account.accountUserId,
      authenticationSessionId: authenticated.session.id,
      email: authenticated.user.email,
      userDisplayName: authenticated.user.name,
      organizationDisplayName,
      tenantKind: "organization",
      idempotencyKey,
      installationKind: this.options.installationKind,
      expiresAt: authenticated.session.expiresAt,
      now: this.now(),
    });
  }

  async createPersonalTenant(headers: Headers, input: { idempotencyKey: string }) {
    if (this.options.installationKind === "customer-managed") {
      throw new LemmaComputerError("PERSONAL_TENANT_NOT_AVAILABLE", "Personal tenants are unavailable in this installation", 404);
    }
    const synchronized = await this.synchronize(headers);
    if (!synchronized) throw new LemmaComputerError("UNAUTHENTICATED", "Authentication is required", 401);
    if (!this.store.createCustomerOrganization) {
      throw new LemmaComputerError(
        "PERSONAL_TENANT_SIGNUP_NOT_CONFIGURED",
        "Personal tenant signup is unavailable",
        503,
        true,
      );
    }
    const idempotencyKey = z.uuid().parse(input.idempotencyKey);
    const { authenticated, account } = synchronized;
    const normalizedName = authenticated.user.name.trim().replace(/\s+/g, " ");
    const personalDisplayName = `${normalizedName.slice(0, 88).trimEnd()}'s workspace`;
    return this.store.createCustomerOrganization({
      accountUserId: account.accountUserId,
      authenticationSessionId: authenticated.session.id,
      email: authenticated.user.email,
      userDisplayName: authenticated.user.name,
      organizationDisplayName: personalDisplayName,
      tenantKind: "personal",
      idempotencyKey,
      installationKind: this.options.installationKind,
      now: this.now(),
      expiresAt: authenticated.session.expiresAt,
    });
  }

  async prepareInvitation(invitationToken: string) {
    if (!this.store.createCustomerInvitationContext) {
      throw new LemmaComputerError("INVITATION_ACTIVATION_NOT_CONFIGURED", "Invitation activation is unavailable", 503, true);
    }
    const rawToken = z.string().regex(/^oci_[A-Za-z0-9_-]{32,256}$/).parse(invitationToken);
    const contextToken = `oic_${randomBytes(32).toString("base64url")}`;
    const now = this.now();
    const invitation = await this.store.createCustomerInvitationContext({
      invitationTokenHash: createHash("sha256").update(rawToken).digest("hex"),
      contextTokenHash: createHash("sha256").update(contextToken).digest("hex"),
      expiresAt: new Date(now.getTime() + customerInvitationContextMaxAgeSeconds * 1_000),
      now,
    });
    return {
      contextToken,
      organizationId: invitation.organizationId,
      organizationDisplayName: invitation.organizationDisplayName,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  async getInvitationContext(contextToken: string) {
    if (!this.store.getCustomerInvitationContext) {
      throw new LemmaComputerError("INVITATION_ACTIVATION_NOT_CONFIGURED", "Invitation activation is unavailable", 503, true);
    }
    const rawContext = z.string().regex(/^oic_[A-Za-z0-9_-]{32,256}$/).parse(contextToken);
    const invitation = await this.store.getCustomerInvitationContext({
      contextTokenHash: createHash("sha256").update(rawContext).digest("hex"),
      now: this.now(),
    });
    return {
      organizationId: invitation.organizationId,
      organizationDisplayName: invitation.organizationDisplayName,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  async getInvitationSsoContext(contextToken: string, submittedEmail: string) {
    if (!this.store.getCustomerInvitationContext) {
      throw new LemmaComputerError("INVITATION_ACTIVATION_NOT_CONFIGURED", "Invitation activation is unavailable", 503, true);
    }
    const rawContext = z.string().regex(/^oic_[A-Za-z0-9_-]{32,256}$/).parse(contextToken);
    const invitation = await this.store.getCustomerInvitationContext({
      contextTokenHash: createHash("sha256").update(rawContext).digest("hex"),
      now: this.now(),
    });
    if (invitation.email !== submittedEmail.trim().toLowerCase()) {
      throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
    }
    return { organizationId: invitation.organizationId, email: invitation.email };
  }

  async acceptInvitation(headers: Headers, contextToken: string) {
    const authenticated = await this.verifiedSession(headers);
    if (!authenticated) throw new LemmaComputerError("UNAUTHENTICATED", "Authentication is required", 401);
    if (!this.store.acceptCustomerInvitation) {
      throw new LemmaComputerError("INVITATION_ACTIVATION_NOT_CONFIGURED", "Invitation activation is unavailable", 503, true);
    }
    const createdAt = authenticated.session.createdAt?.getTime() ?? Number.NaN;
    const ageMs = this.now().getTime() - createdAt;
    if (!Number.isFinite(createdAt) || ageMs < 0 || ageMs > 15 * 60_000) {
      throw new LemmaComputerError(
        "INVITATION_REAUTHENTICATION_REQUIRED",
        "Sign in again before accepting this invitation",
        403,
      );
    }
    const rawContext = z.string().regex(/^oic_[A-Za-z0-9_-]{32,256}$/).parse(contextToken);
    return this.store.acceptCustomerInvitation({
      accountUserId: authenticated.user.id,
      authenticationSessionId: authenticated.session.id,
      contextTokenHash: createHash("sha256").update(rawContext).digest("hex"),
      email: authenticated.user.email,
      userDisplayName: authenticated.user.name,
      expiresAt: authenticated.session.expiresAt,
      now: this.now(),
    });
  }

  async requireRecentStepUp(headers: Headers) {
    const synchronized = await this.synchronize(headers);
    if (!synchronized) throw new LemmaComputerError("UNAUTHENTICATED", "Authentication is required", 401);
    const { authenticated, account } = synchronized;
    const recentStepUpAt = await this.store.getCustomerOwnerStepUp?.({
      accountUserId: account.accountUserId,
      authenticationSessionId: authenticated.session.id,
    }) ?? null;
    const proofTime = recentStepUpAt?.getTime() ?? Number.NaN;
    const ageMs = this.now().getTime() - proofTime;
    if (authenticated.user.twoFactorEnabled !== true
      || !Number.isFinite(proofTime)
      || ageMs < 0
      || ageMs > recentAuthenticationStepUpWindowMs) {
      throw new LemmaComputerError(
        "OWNER_STEP_UP_REQUIRED",
        "Enable MFA and sign in again before completing this protected owner operation",
        403,
      );
    }
    return {
      accountUserId: account.accountUserId,
      authenticationSessionId: authenticated.session.id,
      recentStepUpAt: recentStepUpAt!,
    };
  }

  async recordRecentStepUp(headers: Headers) {
    const synchronized = await this.synchronize(headers);
    if (!synchronized) throw new LemmaComputerError("UNAUTHENTICATED", "Authentication is required", 401);
    if (synchronized.authenticated.user.twoFactorEnabled !== true) {
      throw new LemmaComputerError("OWNER_STEP_UP_REQUIRED", "Enable MFA before completing this protected owner operation", 403);
    }
    if (!this.store.recordCustomerOwnerStepUp) {
      throw new LemmaComputerError("OWNER_STEP_UP_NOT_CONFIGURED", "Protected owner verification is unavailable", 503, true);
    }
    const recentStepUpAt = this.now();
    await this.store.recordCustomerOwnerStepUp({
      accountUserId: synchronized.account.accountUserId,
      authenticationSessionId: synchronized.authenticated.session.id,
      authenticatedAt: recentStepUpAt,
    });
    return {
      accountUserId: synchronized.account.accountUserId,
      authenticationSessionId: synchronized.authenticated.session.id,
      recentStepUpAt,
    };
  }

  async revokeCurrentSession(headers: Headers) {
    const authenticated = await this.verifiedSession(headers);
    if (!authenticated) return;
    await this.store.revokeCustomerProductSession({
      authenticationSessionId: authenticated.session.id,
      accountUserId: authenticated.user.id,
      now: this.now(),
    });
  }

  async clearCurrentOrganizationSelection(headers: Headers) {
    const authenticated = await this.verifiedSession(headers);
    if (!authenticated) return;
    await this.store.clearCustomerProductSession({
      authenticationSessionId: authenticated.session.id,
      accountUserId: authenticated.user.id,
    });
  }
}
