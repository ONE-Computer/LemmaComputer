# ADR 0007: Better Auth-only customer and platform authentication

Status: Accepted

Date: 2026-08-16

## Context

LemmaComputer had three overlapping authentication implementations: embedded
Better Auth for customers, direct workforce-Entra OIDC for customer-managed
deployments, and Entra External ID for hosted customers. Hosted platform
operators additionally depended on a separate workforce-Entra application,
while worktree operators already used an isolated Better Auth passkey realm.
The product is not live, so retaining compatibility adapters creates security
and operational complexity without a migration benefit.

Authentication and product authorization remain separate. Better Auth proves
the account and authentication assurance; LemmaComputer resolves organizations,
memberships, platform roles, tenant placement, support elevation, and audit.

## Decision

1. Customer authentication uses embedded Better Auth in every profile.
   Email/password, passkeys, optional social OAuth, and tenant-configured SAML
   or OIDC are the supported methods. Direct workforce-Entra and External ID
   routes, configuration, and runtime adapters are removed.
2. Hosted and worktree platform operators use a second, isolated Better Auth
   realm. It has its own PostgreSQL database roles, signing/encryption secrets,
   cookie namespace, session audience, rate-limit records, and passkeys.
   Customer-managed deployments expose no platform-operator realm.
3. Platform sign-in is passkey-only after enrollment and requires resident
   credentials with user verification. Customer accounts and tenant SSO cannot
   authenticate the platform realm.
4. Initial hosted enrollment requires an exact configured operator email, an
   explicit one-time secret of at least 32 characters, HTTPS, and the configured
   origin. The secret authorizes only the preconfigured identity; there is no
   public platform signup. After the first passkey is registered, Control
   deletes the temporary credential and all bootstrap sessions. The deployment
   secret can then be removed without preventing restart.
5. Microsoft 365 uses only the dedicated `LEMMACOMPUTER_MS365_*` connector
   application. It does not fall back to a retired product-sign-in app.

## Security consequences

- Hosted no longer requires any Entra application merely to start or operate
  customer or platform authentication.
- The customer and platform realms cannot substitute for one another.
- A leaked bootstrap secret cannot choose an arbitrary email, create a public
  operator account, or authenticate after enrollment has completed.
- Edge WAF and application rate limits remain required for hosted authentication.
- Recovery and additional platform-operator administration must use an audited
  platform process; reintroducing a general credential login is not an allowed
  recovery shortcut.

## Data and migration consequences

No schema migration is required. Historical forward-only migrations and their
old provider values remain immutable migration history, but current runtime
code, routes, configuration, and documentation do not use them. The application
has no live customer data requiring identity migration.

## Supersedes

This ADR completes the adapter contraction described in ADR 0004 and supersedes
the transitional sign-in-provider portions of ADR 0003 and ADR 0004. Their
provider-neutral authorization and deployment-profile boundaries remain in
force.
