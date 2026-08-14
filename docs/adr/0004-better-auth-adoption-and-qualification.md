# ADR 0004: Better Auth adoption and qualification

- Status: Accepted
- Date: 2026-08-09
- Epic: #1
- Implementation issue: #51
- Normative architecture: [Customer authentication architecture](../architecture/authentication.md)

## Context

LemmaComputer needs one customer-authentication implementation for hosted and
customer-managed deployments without making authentication authoritative for
product access. The provider decision is settled: Better Auth is embedded in
Control API and LemmaComputer operates its authentication store. This ADR fixes
the remaining implementation contracts and qualification gates; it does not
reopen provider selection.

The first qualified production pins are `better-auth` `1.6.26`,
`@better-auth/passkey` `1.6.26`, and `@better-auth/sso` `1.6.26`. All must remain exact direct Control API
dependencies. An upgrade changes the qualified security surface and therefore
requires reviewed release notes and generated schema, all automated gates, and
the applicable external-provider and recovery smoke tests. A rollback is
permitted only when the prior code is compatible with the current forward-only
authentication schema; otherwise ship a forward fix.

## Decision

Mount Better Auth in Control API at `/api/v1/auth/customer/*`. Hosted Control
replicas share one logical authentication database. A customer-managed
installation embeds the same integration with its own authentication database
and no required LemmaComputer-hosted identity dependency. A per-hosted-tenant
Better Auth deployment is not the default topology.

Better Auth owns credentials, verification, recovery, authentication factors,
provider accounts, federation protocol handling, and authentication sessions.
LemmaComputer owns product accounts, organizations, invitations, memberships,
roles, permissions, resource scope, protected ownership, active-organization
selection, data-plane placement, authorization, and product audit.

Email, domain, provider groups, and provider administrator claims are
non-authoritative. Unknown identities, methods, capabilities, assurance levels,
memberships, roles, permissions, scopes, and placement inputs deny by default.

## Trust boundaries and data flow

1. The browser reaches only reviewed customer-authentication or operator
   ingress. Their routes, cookies, audiences, callbacks, and sessions are
   distinct.
2. Better Auth validates a local credential, passkey, social provider, SAML, or
   OIDC exchange and returns a customer authentication user and session.
3. Control maps the Better Auth UUID to the same `account_users.id`
   idempotently. Provider-account records remain in the authentication database.
4. A protected product request validates the Better Auth session, then resolves
   an active LemmaComputer account, organization membership, and explicit active
   organization entirely from server-side product state.
5. The placement resolver accepts that admitted organization ID, never a
   browser identifier, email domain, provider group, or provider role.
6. Product authorization evaluates permissions and resource ownership before
   calling pooled or dedicated tenant data planes.

There is no cross-database foreign key and no direct authentication-database to
tenant-data-plane path. Reading the authentication database cannot grant a
product permission; reading the product database cannot reveal credential,
MFA, passkey, provider-token, or raw authentication-session material.

## Provider-neutral contracts

`packages/contracts/src/authentication.ts` is the executable boundary.

- `CustomerAuthenticatedPrincipal` contains the customer realm, opaque
  authentication-session ID, stable product account UUID, immutable
  issuer/subject identity, method, assurance evidence, email-verification flag,
  authentication time, and recent-step-up time. It deliberately contains no
  organization, membership, role, permission, provider-group, or placement
  authority.
- Customer methods are email/password, passkey, Google OAuth, Microsoft OAuth,
  SAML, and OIDC. Workforce OIDC is excluded from the customer principal.
- Assurance is `aal1` or `aal2` with explicit password, TOTP, passkey, or
  federated factors. Sensitive product operations require `aal2` and a
  server-validated step-up no more than ten minutes old.
- Provider capabilities are an allow-list: email verification, password reset,
  TOTP, backup codes, passkeys, social OAuth, enterprise SSO, session
  revocation, and explicit account linking. Unknown capabilities fail parsing.
- Every provider contract fixes implicit email linking to `false` and product
  authorization claims to `ignored`.
- `PlatformOperatorPrincipal` accepts only the separate workforce identity
  realm. It cannot parse as a customer principal or product authorization
  context.

The current Entra and External ID customer implementations are adapters behind
this boundary during the bounded replacement window. No new provider-specific
authorization branch may be added.

## Authentication database and migration operations

The initial PostgreSQL cluster contains two logical databases:

| Database | Runtime role | Migration role | Authority |
| --- | --- | --- | --- |
| `lemmacomputer_auth` | `lemmacomputer_auth_runtime` | `lemmacomputer_auth_migrator` | Better Auth users, credentials, provider accounts, factors, sessions, verification, and SSO configuration |
| `lemmacomputer_control` | `lemmacomputer_control_runtime` | `lemmacomputer_control_migrator` | Product accounts, organizations, membership, invitations, IAM, authorization context, placement, and audit |

Runtime roles receive only the DML required by their application boundary and
cannot alter schemas or assume the other database role. Migration roles are
used only by explicit one-shot jobs. Application startup never migrates. It
checks a pinned authentication schema compatibility marker and fails before
serving authentication routes when the schema is unsupported.

Issue #52 must add a reviewed, forward-only authentication migration ledger and
explicit `auth:db:migrate` and `auth:db:check` jobs. Better Auth CLI output is
candidate SQL, not an unreviewed production migration. Checksums and dependency
order are immutable after application. Authentication and product migrations
may share a deployment transaction boundary only as coordinated jobs; they do
not gain cross-database foreign keys.

Backups use an encryption principal separate from both runtime roles. Restore
qualification creates an isolated target, restores authentication and product
control data to a consistent recovery point, runs both compatibility checks,
and proves user-to-account and session-revocation invariants before promotion.
Encryption keys live outside PostgreSQL, carry versions, and support a bounded
read-old/write-new rotation window.

## Account and session mapping

Better Auth user IDs are UUIDs and are reused as `account_users.id`. The mapping
transaction inserts the product account if absent and otherwise verifies the
same immutable user ID. It never searches or merges by email. Better Auth's
provider-account table is authoritative for authentication links;
`external_identities` is a read-limited compatibility and audit projection only.

A validated customer authentication session does not itself authorize a
product request. Control resolves an active `ProductAuthorizationContext`
containing the Better Auth session ID, account UUID, organization UUID, active
membership UUID, creation/last-seen/step-up timestamps, and null revocation.
Client-supplied tenant or membership IDs are never substituted into that
context. An account with several memberships selects one through a
server-validated transition; the next context is created only after confirming
the membership belongs to the same account and organization.

Every request rechecks account, organization, and membership status and resource
ownership. Suspending an account or membership revokes product contexts
immediately even if Better Auth still presents a valid authentication cookie.
Product logout revokes the product context. Password/MFA recovery, account
disablement, compromise, identity unlinking, and sign-out-all-devices revoke
both product contexts and relevant Better Auth sessions.

## Threat model

| Attacker goal or failure | Required control and evidence |
| --- | --- |
| Turn email, domain, group, or provider-admin claims into tenant authority | Strict principals omit product authority; membership and permission resolution is server-side; negative tests replay privileged claims. |
| Merge an attacker identity into a victim account | Implicit email linking is disabled; distinct identities require dual authenticated proof or audited recovery; link/unlink revokes and converges sessions. |
| Select another organization or data plane | Active membership and placement are resolved from product state; cross-tenant identifiers, colliding local IDs, invitations, role IDs, and placement hints are adversarially replayed. |
| Reuse a stale, fixed, stolen, or revoked session | Secure host-only cookies, rotation, bounded lifetime, CSRF/origin checks, server-side context, prompt revocation, and restart/replay tests. |
| Exploit OAuth/OIDC/SAML callbacks | Exact base URL and trusted origins; state, nonce, PKCE, issuer, audience, SAML request/signature/timestamp/size/replay checks; metadata and key rotation tests. |
| Abuse signup, verification, or recovery to enumerate accounts | Generic responses, shared durable rate limits across replicas, edge abuse controls, bounded tokens, audit correlation, and timing review. |
| Steal credentials, MFA material, provider tokens, or keys from product storage or logs | Separate authentication database and roles, encrypted OAuth tokens, external versioned encryption keys, redaction tests, and forbidden-field scans. |
| Compromise the authentication database or encryption key | Treat all credentials, factors, provider tokens, and sessions as compromised; rotate keys, revoke sessions, notify, and use verified recovery. Product authorization remains independently required. |
| Compromise the product control database | Authentication secrets remain unavailable; force product-context revocation and restore IAM/audit from verified backups. Authentication alone still grants no tenant access. |
| Cross customer and operator realms | Separate clients, audiences, callbacks, cookies, schemas, and negative parsing/routing tests. No customer role or permanent global-admin flag enters the operator plane. |
| Bypass tenant authority with operator support access | Explicit tenant, reason, scope, expiry, recent step-up, configured approval, per-use correlation ID, revocation, and audit. |
| Run unreviewed library schema or vulnerable dependency code | Exact pins, advisory monitoring, reviewed generated SQL, offline load qualification, automated security gates, staged upgrade, and compatible rollback or forward fix. |
| Obtain access during provider, auth DB, or control DB outage | Fail closed. Independent permitted methods may remain available, but no cached or provider claim becomes authorization. |
| Lock a tenant out with enforced SSO | Successful test plus verified protected-owner recovery is required before enforcement; suspension/rotation/rollback remain audited. |

## Recovery, linking, and elevation

Identity linking uses one of two authorizations: two distinct currently
authenticated sessions proving control of both identities, or an explicit
audited recovery case approved in the operator realm. Matching email is never a
linking mechanism. Unlinking requires recent step-up, preserves at least one
usable recovery method, and revokes affected sessions.

Protected-owner transfer, recovery completion, organization closure, SSO
enforcement/recovery, and billing ownership require `aal2` plus step-up within
ten minutes. The final active owner cannot be suspended, removed, or demoted.
An owner recovery case records the account and organization, evidence class,
reason, approver, timestamps, resulting identity links, and all revocations;
secret evidence is not copied into product audit.

Platform support elevation is hosted-only and requires a workforce operator
session, target organization, reason, fixed permission scope, expiry of at most
30 minutes, and step-up within ten minutes. Customer-content or identity
recovery scopes require configured approval. Break-glass elevation is at most
15 minutes, cannot be silent, emits an immediate security alert, and is reviewed
after use. Operator sessions are never accepted as customer membership and
customer-managed artifacts contain no operator routes or workforce dependency.

## Failure and incident response

- Better Auth or authentication-database failure denies login and session
  validation. It never falls back to headers, email, cached roles, or anonymous
  access.
- Product-control failure denies active organization and permission resolution
  even when authentication succeeds.
- A tenant data-plane failure remains confined to that placement and never
  selects another tenant's data.
- Social-provider failure leaves only independently enabled methods available.
  Enforced enterprise SSO uses the protected-owner recovery path, not a claim
  bypass.
- Encryption-key rotation reads a bounded set of previous key versions and
  writes only the current version. Unknown versions fail closed.
- Dependency upgrades run schema diff, migration, backup/restore, security,
  authentication, federation, revocation, and rollback gates on a disposable
  environment before promotion.
- Audit captures decisions and correlation IDs but redacts passwords, tokens,
  codes, cookies, assertions, private keys, passkey material, and TOTP or backup
  codes.

## Expand, migrate, contract

1. Introduce the provider-neutral contracts and tests while current customer
   Entra adapters remain isolated behind the boundary.
2. Issue #52 adds Better Auth storage, migration/check jobs, customer methods,
   product-session mapping, and recovery. New customer authentication then uses
   Better Auth.
3. Existing Microsoft identities link only through authenticated proof. No
   Microsoft password, MFA secret, or provider token is migrated.
4. Issues #53, #56, and #12 move signup, invitation activation, and tenant SSO
   to Better Auth. Issue #54 retains workforce Entra only for operators.
5. After recovery, rollback, redaction, and adversarial gates pass, remove the
   customer External ID routes, customer configuration, and the compatibility
   projection writer. This is a bounded pre-production replacement, not a
   permanent dual-auth compatibility layer.

## Qualification and evidence

`config/better-auth-qualification.json` is the machine-readable gate contract.
`npm run qualify:better-auth` verifies exact package and lockfile pins, loads the
Better Auth core and SSO security entrypoints, and checks the fixed mount,
database, linking, and authorization boundaries without network access.

| Evidence | Automation owner | Human or external evidence |
| --- | --- | --- |
| Contract parsing, unknown-value denial, cross-realm separation, product-context shape, linking proof | #51 | Security review of this ADR |
| Email verification/reset, TOTP/backup codes, passkeys, social login, session revocation, fake email capture, Postmark | #52 | One configured Postmark delivery and Google/Microsoft login smoke |
| Protected owner bootstrap and recovery | #53 | Recovery tabletop for an owner who lost the primary factor |
| Operator realm and elevation | #54 | Break-glass/approval tabletop and audit review |
| Tenant-defined roles and scoped permissions | #55 | Administrator usability and delegation review |
| Invitation activation | #56 | One Postmark invitation activation smoke |
| Tenant SAML/OIDC | #12 | Microsoft Entra plus one non-Microsoft standards-provider smoke, rotation, and lockout recovery |
| Cross-tenant/auth/data-plane isolation | #13 | Reviewed complete resource inventory and parallel two-organization exercise |
| Backup/restore, key rotation, proxy headers, edge limits, dependency rollback | #52 and release qualification | Isolated restore, key-rotation, trusted-proxy, and rollback drills |

Human/provider qualification is intentionally performed when the downstream
implementation exists; it is not replaced by this ADR. A failed or unavailable
human gate blocks promotion of the affected authentication method. It does not
permit weakening the provider-neutral or fail-closed contract.

## Rejected alternatives

- Do not make Microsoft External ID, Cognito, Auth0, or WorkOS the mandatory
  customer realm.
- Do not deploy one Better Auth service or database per ordinary hosted tenant.
- Do not use Better Auth Organization or Dynamic Access Control as product IAM.
- Do not implement password, MFA, passkey, OAuth, SAML, OIDC, or session
  cryptography in LemmaComputer.
- Do not keep two long-term customer authentication cookies or merge identities
  by email.

## Consequences

LemmaComputer gains one authentication contract across both product profiles
and retains its existing tenant/IAM authority. It also assumes operational
custody of authentication availability, secrets, database migration, backup,
email delivery, abuse prevention, monitoring, and incident response. The
machine-readable contract and exact pins make those responsibilities visible;
downstream issues must produce the runtime and human evidence before release.
