# Handoff: Epic #1 — provider-neutral identity, tenant IAM, and hosted SaaS readiness

## Purpose

This document is the clean-start handoff for the next agent working in:

- Repository: `ONE-Computer/LemmaComputer`
- Local checkout: `/home/mike/Documents/onecomputer`
- Epic: [#1 — Provider-neutral identity, tenant IAM, and hosted SaaS readiness](https://github.com/ONE-Computer/LemmaComputer/issues/1)

Read this document, the linked GitHub issue, the root `AGENTS.md`, and any subsystem `AGENTS.md` before changing code. Treat GitHub issue bodies and native GitHub dependencies as the execution contract.

## Mandatory authentication architecture read

Before implementing **any** Epic #1 issue that touches authentication,
accounts, sessions, invitations, organization admission, enterprise SSO,
platform operators, tenant routing, or deployment profiles, the agent **MUST read**
the complete
[Customer authentication architecture](../authentication-architecture.md).

**Implementation gate:** Do not begin implementation until that document has
been read in full and its boundaries have been incorporated into the issue plan.

That document is the normative Better Auth design and records the selected
service boundary, database ownership, hosted multitenancy model,
customer-managed topology, enterprise SSO boundary, session mapping, security
baseline, and migration sequence. This handoff summarizes execution state; it
does not replace the architecture document.

If a GitHub issue body or existing implementation conflicts with that design,
the agent must stop and reconcile issue #51 and the architecture document before
implementing. The agent must not silently choose a different authentication
provider, make Better Auth authoritative for product permissions, deploy one
identity service per hosted tenant, or reintroduce a mandatory Microsoft
customer identity.

The central correction is:

> Microsoft Entra External ID remains only a transitional customer adapter. Better Auth is the selected open-source customer authentication framework. Better Auth implements credential, authentication, MFA, passkey, social OAuth, SAML/OIDC, and session mechanics inside the LemmaComputer deployment; LemmaComputer operates that authentication store while remaining authoritative for accounts, organizations, memberships, invitations, roles, permissions, tenant placement, and product authorization.

## Verified snapshot

Snapshot date: **2026-08-08, Asia/Singapore**.

### Git

- Current branch: `main`
- Current HEAD: `157b4cc`
- Working tree was clean before this handoff file was added.
- Local `main` is **five commits ahead** of `origin/main` and has no remote-only commits.
- The five commits are local and have **not been pushed**:

```text
157b4cc fix:match-external-id-token-issuer
c8bd0a3 fix:allow-external-id-qualification-in-worktrees
271f934 feat: add hosted External ID invitation login
63403fb feat: add organization access administration
9b8b548 feat: add organization membership admin API
```

Do not create new work from `origin/main`; that would omit the #11 foundation. Create issue worktrees from the current local `main` unless the user separately authorizes and completes a push first.

Do not roll back local `main`. The useful authorization and membership foundation should be evolved additively. If Microsoft-specific behavior is later removed, do it through a dedicated compatibility/contraction issue after the provider-neutral replacement is qualified.

### Local runtime

- Compose project: `lemmacomputer`
- Installation kind remains `worktree`; it is not a production `hosted` deployment.
- The running services reported healthy through `docker compose ps -a`.
- The browser ingress is exposed on `127.0.0.1:4174`.
- `GET http://127.0.0.1:4174/__lemmacomputer/healthz` returned `{"status":"ok"}`.
- The one-shot `db-migrate` container exited successfully.
- The migration log reported: `Database schema is current; no migrations applied.`

The real External ID qualification path has a narrow development exception for the `worktree` profile and loopback HTTP. Do not switch the local installation to `hosted` merely to test identity. The production hosted contract requires HTTPS, remote-isolated workspaces, managed infrastructure, external secrets, and other controls that localhost does not provide.

### Database and migration state

The current local schema includes the forward-only #11 migrations:

- `packages/workspace-store/migrations/01KZCV5X3BP4M3A5GCGXG07K7E_organization_invitations.sql`
- `packages/workspace-store/migrations/01KZDMJVTS4Y1K48DEZMFQ65VE_external_id_invitation_acceptance.sql`

Repository migration policy is forward-only and expand/migrate/contract. Never edit or remove an applied migration. A correction is a new generated migration. Read:

- `packages/workspace-store/AGENTS.md`
- `docs/database-migrations.md`

## Product goal

The target is an AWS-like multitenant SaaS authority model, adapted for LemmaComputer:

1. **LemmaComputer platform operators** administer the service through a separate internal authority plane.
2. **A customer signs up independently** using a universal customer account path.
3. The first verified customer creates an organization and becomes its protected **owner/root-equivalent**.
4. Each organization manages its own administrators, members, roles, permission assignments, identity-provider options, workspaces, providers, audit, and lifecycle.
5. Email is universally available. Google, Microsoft, and tenant enterprise SSO are optional authentication methods.
6. Authentication never decides product authorization.
7. One product codebase supports both hosted multi-organization and customer-managed single-organization deployment profiles.

### Target user-facing authentication

The hosted login experience should eventually offer choices such as:

- Continue with email
- Continue with Google
- Continue with Microsoft
- Sign in with company SSO

The default customer path must work for a person whose organization does not use Microsoft.

Do not implement bespoke password hashing, password reset, TOTP, passkey,
OAuth, SAML, OIDC, or session cryptography in LemmaComputer. Use Better Auth's
qualified implementations behind the provider-neutral authentication contract.
Credential hashes, encrypted TOTP material, passkeys, provider accounts, and
authentication sessions belong only in the dedicated Better Auth database and
must not leak into the product control or tenant data-plane stores.

### Target authority chain

```text
identity provider
    -> immutable external identity
    -> stable LemmaComputer account
    -> organization membership
    -> organization role assignment
    -> permission and resource scope
    -> server-side resource decision
```

Email is display/contact data. Never use email alone as an identity key, account-linking proof, tenant selector, or role grant.

## Required identity realms

### Customer account realm

- Provider-neutral authentication backed by the embedded Better Auth customer
  identity plane defined in `docs/authentication-architecture.md`.
- One stable product account may have multiple external identities.
- One account may belong to multiple organizations.
- Linking two provider identities requires authenticated proof of both identities or an explicit audited recovery process; never merge by matching email.
- Each browser session has one server-resolved active organization membership.

### Protected tenant owner/root-equivalent

- Created atomically with a self-service organization.
- Has protected ownership and recovery operations.
- Must use strong authentication and recent step-up for ownership transfer, recovery, closure, billing ownership, and SSO recovery.
- Cannot remove or demote the final active owner.
- Should not be the recommended everyday administrator identity.

### Tenant administrator and member realm

- Authorization belongs to the organization membership, not the global account.
- Tenant administrators manage members and tenant-defined roles within their own authority.
- Provider groups, provider directory roles, and email domains cannot silently grant a LemmaComputer role.

### Platform-operator realm

- Separate operator client/application, audience, session, cookie boundary, and workforce identity policy.
- Platform roles are distinct from customer roles.
- Platform operators are not implicit customer members.
- Tenant support access requires explicit target, reason, scope, expiry, step-up, and where configured approval.
- Elevation is short-lived and fully audited; do not implement a permanent global `isAdmin` bypass.

### Workload identity realm

- Service accounts and workloads use scoped, short-lived credentials/grants.
- Human passwords or customer browser sessions must not become machine credentials.
- Workload authority remains tenant-, resource-, action-, and expiry-scoped.

## What is already valuable and must be retained

### Completed earlier foundations

- [#2](https://github.com/ONE-Computer/LemmaComputer/issues/2) is closed: provider-neutral account/external-identity/organization-membership/session/RBAC foundation.
- [#3](https://github.com/ONE-Computer/LemmaComputer/issues/3) is closed: fail-closed deployment-profile capability contract.

Important existing domain properties include:

- `account_users` as the stable product person, not keyed by email.
- `external_identities` linked by immutable provider identity.
- `organization_memberships` linking one account to one organization-local subject.
- membership-bound browser sessions.
- built-in `owner`, `admin`, and `member` roles.
- a versioned product permission catalog.
- last-active-owner protection.
- tenant-local session revocation and audit.
- fail-closed server-side permission checks.

### Current #11 implementation on local main

[#11](https://github.com/ONE-Computer/LemmaComputer/issues/11) is open and has been reframed as **organization invitations and membership lifecycle foundation**.

The five local commits add:

- organization membership administration APIs;
- People and Access administration UI;
- invite, resend, revoke, accept, expire, suspend, reactivate, remove, role-change, and session-revocation behavior;
- invitation token hashing and audit behavior;
- hosted External ID invitation acceptance as a transitional adapter;
- OIDC state, nonce, PKCE, issuer, audience, subject, and callback checks;
- focused browser/API/database tests and External ID qualification tooling.

Keep the membership, invitation, audit, and session-revocation foundation. Do not keep the assumption that Microsoft External ID is the only hosted customer login or that every customer identity must be administratively pre-created in Microsoft's portal.

## What is transitional and must change

The current hosted flow is invitation-only and Microsoft-specific:

- the deployment profile names `external-id` and `enterprise-entra` as hosted sign-in providers;
- product routes and docs name Microsoft External ID directly;
- the current runbook disables public self-service signup;
- the tested journey assumed a provider account existed before a LemmaComputer invitation could be accepted;
- the login UI redirects into a Microsoft-hosted flow.

This is an adapter implementation, not the final product contract.

The next implementation must:

- define a provider-neutral `AuthenticatedPrincipal` and provider capability contract;
- preserve immutable issuer/subject identity mapping;
- make the login UI provider-neutral;
- add a universal customer email path through Better Auth;
- support optional passkeys and optional Google/Microsoft/federated methods according to the qualified provider;
- add self-service organization creation and protected owner bootstrap;
- retain invitation-bound activation for joining an existing organization;
- keep customer enterprise SSO optional and tenant-configurable;
- separate the platform-operator realm from all customer login paths.

Do not rename/remove the existing External ID adapter first. Introduce the neutral boundary, move the adapter behind it, qualify the replacement paths, and only then decide whether a separate contraction issue should retire unused Microsoft-specific code.

## Human testing already performed and what it proved

A real Microsoft Entra External ID external tenant and app were configured for local qualification.

Non-secret identifiers:

- External tenant: `ME TECH Customers`
- Tenant domain: `metechcustomers.onmicrosoft.com`
- Tenant ID: `492402d1-45e6-4b71-99f3-574cce83b598`
- App display name: `LemmaComputer`
- Client ID: `087cbef9-baeb-4094-8815-51d09408c9cd`
- Local callback: `http://localhost:4174/api/v1/auth/external-id/callback`

The real-provider preflight reached the correct discovery/signing infrastructure after fixing the External ID token issuer host.

The invitation acceptance browser test then reached `ME TECH Customers`, but a new personal email received the Microsoft error that the account did not exist in the organization. The sign-up user flow was missing, disabled, or not attached in the required way. This exposed the product mismatch:

- LemmaComputer generated a one-time link but did not send an email.
- The invitation created product membership intent but not a CIAM identity.
- The runbook expected administrators to pre-create each External ID customer account.
- That is not acceptable for the target self-service SaaS.

Do not “fix” this by requiring tenant administrators or LemmaComputer operators to visit Entra for every user. #52, #53, and #56 own the correct product journeys.

## Prior verification evidence

The following evidence was reported during #11 integration and was not rerun merely to write this handoff:

- focused auth/External ID qualification tests: 13 passed;
- targeted Playwright invitation test: 1 passed;
- `npm run verify:quick`: 487 passed, 0 failed, with 18 PostgreSQL-dependent skips in that quick run;
- real External ID non-interactive preflight: passed;
- current Compose services: healthy;
- current migration job: schema current.

The real interactive signup/invitation journey is **not complete** and must not be described as passing.

## Security-sensitive operational notes

- The real External ID client secret exists in the local `.env`. Never print, copy, commit, screenshot, or place it in an issue/handoff.
- A workforce Entra secret was exposed in earlier tool output. Treat it as compromised until rotation is independently confirmed. Never repeat its value.
- Invitation URLs were shown in screenshots. Revoke any exposed pending invitation before further testing and create a fresh one. Never paste a raw invitation token into GitHub, chat, logs, or screenshots.
- Do not expose provider access tokens, refresh tokens, ID tokens, authorization codes, passwords, OTPs, passkey material, client secrets, session cookies, or MFA QR codes.
- Do not infer that a `#EXT#` representation changes or replaces the person's home identity; it is a directory representation.

## GitHub epic and issue graph

All listed issues are children of epic #1 where applicable. Their bodies use the standard sections `Blocked by`, `Blocks`, `Can run in parallel with`, scope, non-goals, definition of success, and done criteria. Native GitHub issue dependencies were synchronized with the text.

### Identity and authorization critical path

| Issue | State | Purpose | Native blocked by | Can run in parallel with |
|---|---|---|---|---|
| [#51](https://github.com/ONE-Computer/LemmaComputer/issues/51) | Open | Provider-neutral identity ADR and threat model | None | #4, #5, #11, #14, #15, #21 |
| [#52](https://github.com/ONE-Computer/LemmaComputer/issues/52) | Open | Customer email/passkey/optional federated authentication | #51 | #54 and, after #11, #55 |
| [#53](https://github.com/ONE-Computer/LemmaComputer/issues/53) | Open | Self-service organization signup and protected owner | #52 | #12, #56 |
| [#54](https://github.com/ONE-Computer/LemmaComputer/issues/54) | Open | Separate platform-operator plane | #51 | #52 and, after #11, #55 |
| [#55](https://github.com/ONE-Computer/LemmaComputer/issues/55) | Open | Tenant-defined roles and scoped permissions | #11, #51 | #52, #54 |
| [#56](https://github.com/ONE-Computer/LemmaComputer/issues/56) | Open | Invitation email delivery and provider-neutral activation | #11, #52 | #12, #53 |
| [#12](https://github.com/ONE-Computer/LemmaComputer/issues/12) | Open | Tenant-configured enterprise SSO and verified domains | #51, #52 | #53, #54, #55, #56 |
| [#13](https://github.com/ONE-Computer/LemmaComputer/issues/13) | Open | Adversarial tenant isolation | #12, #53, #54, #55, #56 | #21, #22 |

### Supporting platform and release graph

| Issue | State | Purpose | Native blocked by | Can run in parallel with |
|---|---|---|---|---|
| [#4](https://github.com/ONE-Computer/LemmaComputer/issues/4) | Open | Pluggable external secret storage | None | #5, #11, #21, #51 |
| [#5](https://github.com/ONE-Computer/LemmaComputer/issues/5) | Open | Remote Kasm security/lifecycle parity | None | #4, #11, #14, #15, #21, #51 |
| [#11](https://github.com/ONE-Computer/LemmaComputer/issues/11) | Open | Invitations and member lifecycle foundation | #2, #3 are closed prerequisites | #4, #5, #14, #15, #21, #51 |
| [#14](https://github.com/ONE-Computer/LemmaComputer/issues/14) | Open | Separate product login from Microsoft 365 connector consent | #4 | #5, #15, #52, #54, #55 |
| [#15](https://github.com/ONE-Computer/LemmaComputer/issues/15) | Open | Tenant-scoped provider connections | #4 | #5, #14, #52, #54, #55 |
| [#21](https://github.com/ONE-Computer/LemmaComputer/issues/21) | Open, P1 | Usage accounting, quotas, idle suspension | None active | #4, #5, #11, #51, #52, #54 |
| [#22](https://github.com/ONE-Computer/LemmaComputer/issues/22) | Open | Audit, retention, export, deletion | #4 | Later identity/isolation work where worktrees do not overlap |
| [#23](https://github.com/ONE-Computer/LemmaComputer/issues/23) | Open | Customer-managed package | #4, #13 | #22 and later #24 |
| [#24](https://github.com/ONE-Computer/LemmaComputer/issues/24) | Open | Hosted production runtime | #4, #5, #13, #22 | #21, #23 |
| [#25](https://github.com/ONE-Computer/LemmaComputer/issues/25) | Open, P1 | Subscription entitlements and billing adapter | #21, #24 | #26 |
| [#26](https://github.com/ONE-Computer/LemmaComputer/issues/26) | Open | Final hosted/customer-managed release gates | #12, #13, #14, #15, #22, #23, #24 | #25 |

## Recommended execution sequence

### Start next

Start [#51](https://github.com/ONE-Computer/LemmaComputer/issues/51) first.

Recommended worktree:

```bash
git worktree add .worktrees/issue-51 -b codex/51-provider-neutral-identity main
cd .worktrees/issue-51
npm run worktree:init
npm run dev:doctor
```

Before editing, read the full #51 body. Its job is to remove unresolved architecture choices for downstream implementation, not to build every login and IAM screen.

### Work that can proceed independently

If the user explicitly requests parallel implementation, these may run in separate worktrees from the current local `main`:

- #4 — external SecretStore
- #5 — remote Kasm qualification
- #11 — final integration/closeout of the existing membership foundation
- #21 — P1 usage/quota work if separately prioritized

Do not start #14 or #15 until #4 closes.

### After #51

The following may run in parallel:

- #52 — provider-neutral customer authentication
- #54 — platform-operator administration plane
- #55 — tenant IAM, only after #11 also closes

### After #52

The following may run in parallel:

- #53 — self-service organization and protected owner
- #12 — tenant-configured enterprise SSO
- #56 — invitation delivery/activation, only after #11 also closes

### Hardening and packaging

- Run #13 after #12 and #53-#56.
- Run #22 after #4 and in parallel with non-overlapping identity work where safe.
- Run #23 after #4 and #13.
- Run #24 after #4, #5, #13, and #22.
- Run #26 after its direct blockers; #25 may run beside it.

## #51 architecture-adoption questions that must be answered

The Better Auth architecture is selected in
`docs/authentication-architecture.md`. The #51 ADR must adopt that document,
add the threat model, and record the implementation-level answers below without
silently changing its service, database, tenancy, or authorization boundaries:

1. Which pinned Better Auth and plugin versions are qualified, and how is the
   framework mounted inside the existing Control authentication boundary?
2. What provider-neutral principal, authentication method, MFA assurance,
   recent-step-up, session, and provider-identity fields are required?
3. How are the logical authentication database, separate database role,
   explicit migration job, schema compatibility gate, backup, and restoration
   implemented?
4. How is the Better Auth UUID mapped idempotently to `account_users.id`, and
   how does the current `external_identities` table remain a bounded projection
   rather than a competing provider-account authority?
5. How does the validated Better Auth session map to a membership-bound product
   authorization context, active-organization selection, suspension, logout,
   and full session revocation?
6. How are email/password, TOTP, passkeys, Google, Microsoft, and enterprise
   federation exposed without changing LemmaComputer product authorization?
7. What is the secure identity-linking and unlinking process?
8. What is the protected-owner recovery and step-up policy?
9. What is the platform-operator break-glass and tenant-support elevation model?
10. How does customer-managed SAML/OIDC and local authentication use the same
    Better Auth contract without a LemmaComputer-hosted dependency?
11. How are provider outages, library upgrades, key rotation, disabled accounts,
    compromised recovery, and tenant SSO lockout handled?
12. Which current External ID components remain transitional adapters, and what
    is the qualified expand/migrate/contract path for retiring them while
    retaining workforce Entra for the separate operator realm?

The ADR should include a threat model, trust boundaries, rejected alternatives, migration strategy, and testable invariants.

## Tenant IAM target for #55

The first flexible authorization increment should be tenant-defined RBAC, not a full AWS IAM policy language.

- Keep protected built-in Owner, Administrator, and Member roles.
- Add tenant-defined roles with stable IDs and versions.
- Let authorized tenant admins select from a product-defined permission catalog.
- Support multiple roles per membership.
- Add supported resource scopes such as selected workspaces/providers where required.
- Compute effective permissions server-side.
- Prevent admins from granting permissions/scopes they do not possess.
- Never silently grant new product permissions to existing custom roles.
- Avoid arbitrary permission strings and direct per-user exceptions in the first version.
- Unknown permissions, roles, catalog versions, and scopes fail closed.

## Likely code areas

Identity and authorization work currently spans:

- `docs/authentication-architecture.md` (**mandatory read before implementation**)
- `apps/control-api/src/auth.ts`
- `apps/control-api/src/server.ts`
- `apps/web/src/App.jsx`
- `apps/web/src/workspace-api.js`
- `packages/workspace-store/src/identity-policy.ts`
- `packages/workspace-store/src/rbac.ts`
- `packages/workspace-store/src/index.ts`
- `packages/workspace-store/migrations/`
- `packages/deployment-profile/src/index.mjs`
- `scripts/deployment-config.mjs`
- `scripts/qualify-external-id.mjs`
- `docs/organization-rbac.md`
- `docs/hosted-external-id.md`
- `docs/deployment-profiles.md`
- `docs/architecture.md`

Tests to inspect before changing contracts:

- `tests/control-auth-boundary.test.ts`
- `tests/entra-authentication.test.ts`
- `tests/external-id-qualification.test.ts`
- `tests/organization-rbac-postgres.test.ts`
- `tests/e2e/external-id-invitation.spec.ts`
- `tests/e2e/people-access.spec.ts`

Do not assume these names represent the final provider-neutral boundaries. #51 should decide which abstractions are renamed or introduced while retaining compatibility.

## Repository workflow and safety

- One issue per branch and one branch per worktree.
- Branch names use `codex/<issue>-<short-name>` when an issue exists.
- Never develop directly on `main`.
- Run `npm run worktree:init` once in a new worktree.
- Run `npm run dev:doctor` at the start of each work session.
- Read the issue definition of success and native blockers before starting.
- Keep `.env`, Compose project names, ports, networks, images, volumes, and databases isolated across worktrees.
- Changes to `apps/web` require the smallest relevant Playwright suite plus `npm run verify:quick`.
- Database changes require the workspace-store instructions, a generated migration, `npm run verify:db`, and forward-only compatibility reasoning.
- Do not point tests or migrations at the demo database.
- Do not push, deploy, restart EC2, or change production from this handoff without separate user authorization.
- Local command output is the verification record; do not claim a check ran when it did not.

## Definition of the new implementation's success

The identity and IAM phase is successful when:

- a new customer without a Microsoft account can create and recover an account;
- that customer can create an organization and become its protected owner without operator action;
- the owner/admin can invite members without manually creating accounts in an
  external identity-provider console or choosing passwords;
- recipients can activate the predetermined membership through any supported authentication method;
- tenant admins can define safe custom roles from a fixed permission catalog;
- one account can belong to multiple organizations with different roles and explicit active-tenant selection;
- enterprise SSO is optional, domain-verified, tested before enforcement, and cannot grant product roles from provider claims;
- platform operators use a separate authority plane and require time-bound audited elevation for tenant support;
- passwords, MFA secrets, passkey material, provider tokens, client secrets, raw invitation tokens, and session tokens never enter inappropriate product storage or logs;
- every resource, cache, job, stream, secret, workspace, export, and audit path passes adversarial cross-tenant tests;
- hosted and customer-managed releases come from the same git SHA and pass their respective release gates.

## Immediate handoff instruction

Do not roll back #11 and do not continue patching the current Microsoft screen as the final product experience.

Start with #51 in a new worktree based on the current local `main`. Before any
implementation, read the complete mandatory
[Customer authentication architecture](../authentication-architecture.md),
adopt it in the #51 ADR and threat model, and reconcile any conflicting issue
text. Preserve the membership/invitation foundation, embed Better Auth behind
the provider-neutral customer authentication contract, retain a separate
platform-operator realm, and use that decision to drive #52, #54, #55, #53,
#56, and #12 in the dependency order recorded above.
