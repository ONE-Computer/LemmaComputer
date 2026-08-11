# Handoff: Epic #1 — provider-neutral identity, tenant IAM, and hosted SaaS readiness

## Purpose

This document is the clean-start handoff for the next agent working in:

- Repository: `ONE-Computer/LemmaComputer`
- Local checkout: `<repository-root>`
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

## Official Better Auth development resources

Before implementing or reviewing Better Auth behavior, consult the current
official resources instead of inferring behavior from generated types or
reimplementing a framework feature:

- Documentation MCP: `https://mcp.better-auth.com/mcp`
- MCP setup: [Better Auth MCP](https://better-auth.com/docs/ai-resources/mcp)
- Official skill pack: [Better Auth skills](https://better-auth.com/docs/ai-resources/skills)
- LLM documentation index: [Better Auth llms.txt](https://better-auth.com/llms.txt)
- Skill source: [better-auth/skills](https://github.com/better-auth/skills)

Recommended local setup:

```text
npx skills add better-auth/skills --global --agent codex --skill '*' --yes --full-depth
codex mcp add better-auth --url https://mcp.better-auth.com/mcp
```

The official pack currently provides framework, scaffold, security,
email/password, organization, and two-factor skills. Reload Codex after
installation so the skills and MCP server become available.

The repository currently pins Better Auth `1.6.26`. Current documentation must
be checked for supported framework features and security behavior, but a newer
package must not be adopted implicitly: version upgrades still require pinned
dependencies, generated authentication migrations, compatibility checks, and
the issue qualification gates.

Better Auth's organization plugin is an implementation option to evaluate, not
permission to collapse the accepted authority boundary. LemmaComputer remains
authoritative for product accounts, organizations, memberships, roles,
resource-scoped permissions, tenant placement, and product sessions unless the
architecture is explicitly revised with equivalent fail-closed tenant and
deployment-profile evidence.

## Verified snapshot

Snapshot refreshed: **2026-08-09, Asia/Singapore**.

### Git

- The accepted Better Auth architecture and #11 integration baseline is
  `5b39b11` (`merge: adopt Better Auth authentication architecture`).
- Immediately before this handoff-only refresh, local `main` and freshly
  fetched `origin/main` both resolved to the full SHA
  `5b39b11a0fd84b41ceab47547299085dbc10b5cd` with zero divergence and a clean
  working tree.
- The #11 implementation commits are all contained in that baseline:

```text
157b4cc fix:match-external-id-token-issuer
c8bd0a3 fix:allow-external-id-qualification-in-worktrees
271f934 feat: add hosted External ID invitation login
63403fb feat: add organization access administration
9b8b548 feat: add organization membership admin API
```

Future work must start from a freshly fetched latest `origin/main`. Do not infer
remote parity from an old checkout; verify the full local/remote SHA and working
tree at the start of the session.

### Local core implementation update (not yet pushed)

As of the 2026-08-10 local implementation session, the integration
checkout has advanced beyond the remote snapshot described above:

- local `main` is `a9a09ac` and contains the reviewed #51 Better Auth
  foundation, #52 universal customer authentication, #53 self-service
  organization owner flow, #54 platform-operator separation, and #55 tenant
  IAM;
- the #54 full-suite isolation correction is `3cf0610`;
- #56 is implemented on `codex/56-better-auth-invitations`: the raw invitation
  is exchanged once for a hash-only activation context, every enabled Better
  Auth method can activate the exact preassigned membership, hosted delivery is
  email-only through #52's shared adapter, and copy-link mode is explicit for
  local/customer-managed operation;
- a real Postmark invitation delivery and exact-email acceptance completed in
  an isolated runtime. The invitation page is now one guided organization-join
  flow, explicitly explains social-account email matching, restores its opaque
  context after email verification, and uses Better Auth's verified-session
  handoff to finish acceptance without another login;
- #56 automated gates pass: database verification, quick verification (594
  tests, 0 failures), the focused 8-test invitation suite, and the complete
  67-test Playwright suite. Human review also accepted the revised same-browser
  invitation, verification, and organization-join UX on 2026-08-10;
- after #56, the remaining core order is #12 (tenant SAML/OIDC through Better
  Auth SSO) and #13 (adversarial tenant/authentication isolation). Supporting
  lanes remain deferred until the core is complete.

These are local integration facts only. They do not claim that `origin/main` or
GitHub issue state has advanced; verify both before any remote action.

Do not roll back the #11 or Better Auth architecture baseline. Evolve the useful
authorization and membership foundation additively. Remove Microsoft-specific
customer behavior only through the expand/migrate/contract sequence in the
normative architecture after Better Auth replacement and rollback paths are
qualified.

### GitHub

- Canonical repository: `ONE-Computer/LemmaComputer`.
- GitHub CLI access to the canonical repository was verified on 2026-08-09.
- Epic #1 and issues #12, #13, #23, #24, #26, and #51-#56 were rewritten to
  match the accepted Better Auth architecture.
- #11 was closed as the completed invitation-intent and membership-lifecycle
  foundation. #52 owns universal Better Auth customer authentication plus one
  small transactional-email boundary with an in-memory test adapter and
  Postmark as the initial real transport. #56 reuses it for invitation
  activation.
- Do not reopen provider selection during the core epic. #57 was closed as a
  premature qualification split; replace or expand Postmark only when a
  demonstrated requirement justifies focused follow-up work.
- Native GitHub dependency edges were read back after the rewrite and match the
  `Blocked by` graph below.

### Machine-local operational state

Absolute checkout paths, current container and loopback state, identity-provider
tenant/application identifiers, recovery stashes, and local security follow-ups
are intentionally excluded from this public handoff. In the original local
checkout, read `docs/private/handoff-epic-1-local-environment.md` when present.
The entire `docs/private/` directory is gitignored and must never be used as a
source of portable product configuration.

Do not switch a local development installation to `hosted` merely to exercise
identity. The production hosted contract requires HTTPS, remote-isolated
workspaces, managed infrastructure, external secrets, and other controls that
localhost development does not provide.

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

### Completed #11 foundation on main

[#11](https://github.com/ONE-Computer/LemmaComputer/issues/11) is closed as the
completed **organization invitations and membership lifecycle foundation**.

The integrated commits add:

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

A real Microsoft Entra External ID tenant and application were configured for
local qualification. Their environment-specific names and identifiers are kept
only in the ignored private handoff.

The real-provider preflight reached the correct discovery/signing infrastructure after fixing the External ID token issuer host.

The invitation acceptance browser test reached the configured external tenant,
but a new personal email received the Microsoft error that the account did not
exist in the organization. The sign-up user flow was missing, disabled, or not
attached in the required way. This exposed the product mismatch:

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

The real interactive signup/invitation journey is **not complete** and must not be described as passing.

## Security-sensitive operational notes

- Machine-specific credential-rotation and invitation-revocation follow-ups are
  recorded only in the ignored private handoff; no secret values belong there.
- Do not expose provider access tokens, refresh tokens, ID tokens, authorization codes, passwords, OTPs, passkey material, client secrets, session cookies, or MFA QR codes.
- Do not infer that a `#EXT#` representation changes or replaces the person's home identity; it is a directory representation.

## GitHub epic and issue graph

All listed issues are children of epic #1 where applicable. Their bodies use the standard sections `Blocked by`, `Blocks`, `Can run in parallel with`, scope, non-goals, definition of success, and done criteria. Native GitHub issue dependencies were synchronized with the text.

### Identity and authorization critical path

| Issue | State | Purpose | Native blocked by | Can run in parallel with |
|---|---|---|---|---|
| [#51](https://github.com/ONE-Computer/LemmaComputer/issues/51) | Open | Better Auth adoption, threat model, contracts, and qualification | None | #4, #5, #14, #15, #21 |
| [#52](https://github.com/ONE-Computer/LemmaComputer/issues/52) | Open | Embedded Better Auth, universal customer authentication, and in-memory/Postmark email transport | #51 | #54, #55 |
| [#53](https://github.com/ONE-Computer/LemmaComputer/issues/53) | Open | Self-service organization signup and protected owner | #52 | #12, #56 |
| [#54](https://github.com/ONE-Computer/LemmaComputer/issues/54) | Open | Separate workforce platform-operator plane | #51 | #52, #55 |
| [#55](https://github.com/ONE-Computer/LemmaComputer/issues/55) | Open | Tenant-defined roles and scoped permissions | #11, #51 | #52, #54 |
| [#56](https://github.com/ONE-Computer/LemmaComputer/issues/56) | Open | Invitation activation through Better Auth using #52's shared email transport | #11, #52 | #12, #53 |
| [#12](https://github.com/ONE-Computer/LemmaComputer/issues/12) | Open | Tenant SAML/OIDC through Better Auth SSO | #51, #52 | #53, #54, #55, #56 |
| [#13](https://github.com/ONE-Computer/LemmaComputer/issues/13) | Open | Adversarial tenant and authentication isolation | #12, #53, #54, #55, #56 | #21, #22 |

### Supporting platform and release graph

| Issue | State | Purpose | Native blocked by | Can run in parallel with |
|---|---|---|---|---|
| [#4](https://github.com/ONE-Computer/LemmaComputer/issues/4) | Open | Pluggable external secret storage | None | #5, #21, #51 |
| [#5](https://github.com/ONE-Computer/LemmaComputer/issues/5) | Open | Remote Kasm security/lifecycle parity | None | #4, #14, #15, #21, #51 |
| [#11](https://github.com/ONE-Computer/LemmaComputer/issues/11) | Closed | Invitations and member lifecycle foundation | #2, #3 are closed prerequisites | Complete |
| [#14](https://github.com/ONE-Computer/LemmaComputer/issues/14) | Open | Separate product login from Microsoft 365 connector consent | #4 | #5, #15, #52, #54, #55 |
| [#15](https://github.com/ONE-Computer/LemmaComputer/issues/15) | Open | Tenant-scoped provider connections | #4 | #5, #14, #52, #54, #55 |
| [#21](https://github.com/ONE-Computer/LemmaComputer/issues/21) | Open, P1 | Usage accounting, quotas, idle suspension | None active | #4, #5, #51, #52, #54 |
| [#22](https://github.com/ONE-Computer/LemmaComputer/issues/22) | Open | Audit, retention, export, deletion | #4 | Later identity/isolation work where worktrees do not overlap |
| [#23](https://github.com/ONE-Computer/LemmaComputer/issues/23) | Open | Customer-managed Better Auth package | #4, #13 | #22 and later #24 |
| [#24](https://github.com/ONE-Computer/LemmaComputer/issues/24) | Open | Hosted Better Auth production runtime | #4, #5, #13, #22 | #21, #23 |
| [#25](https://github.com/ONE-Computer/LemmaComputer/issues/25) | Open, P1 | Subscription entitlements and billing adapter | #21, #24 | #26 |
| [#26](https://github.com/ONE-Computer/LemmaComputer/issues/26) | Open | Final hosted/customer-managed Better Auth release gates | #12, #13, #14, #15, #22, #23, #24 | #25 |

## Recommended execution sequence

### Start next

Start [#51](https://github.com/ONE-Computer/LemmaComputer/issues/51) first.

The existing issue worktree and branch are:

```bash
cd .worktrees/issue-51-better-auth-design
npm run dev:doctor
```

If that worktree has intentionally been retired, create a new #51 worktree from
freshly fetched `origin/main` rather than reusing its branch name blindly.

Before editing, read the full #51 body and the complete normative authentication
architecture. The provider decision is settled. #51 completes the threat model,
provider/session/database contracts, migration and recovery boundaries, and
qualification gates; it does not build every login and IAM screen.

### Work that can proceed independently

If the user explicitly requests parallel implementation, these may run in separate worktrees from the current local `main`:

- #4 — external SecretStore
- #5 — remote Kasm qualification
- #21 — P1 usage/quota work if separately prioritized

Do not start #14 or #15 until #4 closes.

### After #51

The following may run in parallel:

- #52 — provider-neutral customer authentication with an in-memory test adapter
  and Postmark as the initial real email transport
- #54 — platform-operator administration plane
- #55 — tenant IAM, only after #11 also closes

### After #52

The following may run in parallel:

- #53 — self-service organization and protected owner
- #12 — tenant-configured enterprise SSO
- #56 — invitation activation using #52's shared email transport, only after
  #11 also closes

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

Continue with #51 in its isolated issue worktree (or a replacement based on the
latest fetched `origin/main` if the existing worktree is retired). Before any
implementation, read the complete mandatory
[Customer authentication architecture](../authentication-architecture.md),
complete its #51 threat model, contracts, migration/operability boundaries, and
qualification gates, and reconcile any conflicting implementation before code
changes. Preserve the membership/invitation foundation, embed Better Auth
behind the provider-neutral customer authentication contract, retain a separate
platform-operator realm, and use the accepted decision to drive #52, #54, #55,
#53, #56, and #12 in the dependency order recorded above.
