# ADR 0004: Better Auth adoption and qualification

- Status: accepted; transitional Microsoft adapter plan superseded by [ADR 0007](0007-better-auth-only-customer-and-platform-authentication.md)
- Date: 2026-08-09
- Current implementation: [Authentication architecture](../architecture/authentication.md)

## Context

Both production profiles need the same customer sign-in boundary. The prior
direct Microsoft adapters made authentication depend on deployment profile.
Authentication must identify a person without granting that person product
permissions.

## Decision

Embed Better Auth in Control API at `/api/v1/auth/customer/*` in both profiles.
Hosted Control replicas share one logical customer-authentication database;
customer-managed installations use their own database with no required
LemmaComputer-hosted identity dependency. Do not deploy an authentication
service per ordinary hosted tenant.

Better Auth owns credentials, factors, provider accounts, federation, and
authentication sessions. LemmaComputer owns product accounts, organizations,
membership, permissions, tenant placement, authorization, and audit. Email,
domain, provider groups, and provider administrator claims are
non-authoritative for product access.

The initial qualified pins are `better-auth` `1.6.26`,
`@better-auth/passkey` `1.6.26`, and `@better-auth/sso` `1.6.26`. The checked-in
qualification contract and package manifest are the current version authority;
changing a pin requires schema review and requalification.

## Trust boundaries and data flow

1. Better Auth validates a customer method and yields a stable user and
   authentication session.
2. Control maps that ID to a product account without matching or merging by
   email.
3. Control resolves the active organization and membership from product data,
   checks permissions and resource ownership, then chooses tenant placement.
4. Customer and platform operator cookies, audiences, routes, and databases
   remain separate. A session in either realm cannot authorize the other.

## Provider-neutral contracts

`packages/contracts/src/authentication.ts` defines the customer principal and
supported methods. Authentication principals carry no organization, role, or
placement authority. Implicit email linking is disabled; unknown methods,
capabilities, assurance levels, and scopes deny by default. Platform operators
use a distinct principal that cannot parse as a customer principal.

## Authentication database and migration operations

Authentication and product data use separate logical databases and runtime
roles. Migration roles run only in explicit one-shot jobs.
Application startup never migrates. It checks schema compatibility before
serving auth routes.
Migration files are reviewed and forward-only. Recovery must restore
authentication and product data to a consistent point and prove that account
mapping and session revocation still work. The current backup set also includes
the platform-auth and LiteLLM databases; see [Operations](../guides/operations.md#backup-and-restore).

## Account and session mapping

Better Auth user UUIDs map idempotently to `account_users.id`; provider links
remain in the authentication database. Product requests require a separately
validated, active product authorization context. Suspended accounts or
memberships lose product access even if an authentication cookie is still valid.
Recovery, unlinking, compromise, and sign-out-all-devices revoke the affected
sessions and contexts.

## Threat model

- Never turn identity-provider claims, email, or client-selected tenant IDs
  into product authority.
- Never merge accounts by matching email. Linking needs proof of both
  identities or audited recovery.
- Separate credentials and factors from product data; redact secrets from
  logs and audit.
- Deny access when authentication, authorization, or tenant placement cannot
  be verified. Do not fall back to cached claims.
- Keep customer and operator realms isolated; operator support access is
  separately authorized, scoped, time-bounded, and audited.

## Recovery, linking, and elevation

Account linking requires two authenticated identities or an approved recovery
case. Sensitive owner changes require recent step-up; the final active owner
cannot be removed. Hosted support elevation requires a platform session,
specific organization, reason, scope, expiry, and audit. The current
[authentication architecture](../architecture/authentication.md) contains the
operational details.

## Failure and incident response

Authentication or product database failure denies protected access. Provider
outage leaves only independently enabled methods available. Key or session
compromise requires revocation, rotation, audit, and a verified recovery path.
Do not add a credential or claim bypass to restore availability.

## Completed contraction

Direct customer and platform Microsoft identity adapters were removed under
[ADR 0007](0007-better-auth-only-customer-and-platform-authentication.md).
Microsoft 365 connector consent uses its own application; it is not the
customer sign-in mechanism.

## Qualification and evidence

`config/better-auth-qualification.json` and `npm run qualify:better-auth`
check pins and structural boundaries. They do not prove live social login,
tenant SSO, email delivery, recovery, or a production restore. Those need
separate environment and human evidence before go-live.

## Rejected alternatives

Mandatory Microsoft CIAM, one auth service per ordinary hosted tenant,
Better Auth Organization as product IAM, bespoke password/MFA/SSO crypto,
and email-based account merging were rejected.

## Consequences

One auth contract serves both profiles, while LemmaComputer takes custody of
the auth database, secrets, delivery, backups, rate limits, and incidents.
