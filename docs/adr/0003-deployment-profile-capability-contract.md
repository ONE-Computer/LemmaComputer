# ADR 0003: Deployment profile capability contract

- Status: Accepted; customer-identity clauses amended by [ADR 0004](0004-better-auth-adoption-and-qualification.md)
- Date: 2026-08-05

## Context

LemmaComputer ships one product from one codebase, schema, migration stream, and
application image. The product has two production deployment profiles:
`customer-managed` and `hosted`. Existing services read the installation kind,
but profile rules were spread across environment parsing and runtime branches.
That made it possible for a new route or worker to interpret a profile
differently from deployment preflight.

Deployment configuration is not authorization. A profile can permit hosted
identity infrastructure without deciding which organization, membership, role,
or user may perform an action. Organization-scoped RBAC remains a separate
control.

## Decision

`@lemmacomputer/deployment-profile` owns a versioned, machine-readable capability
matrix and the resolver used by deployment preflight and downstream services.
The canonical environment contract selects one profile explicitly; environment
variables cannot redefine the profile's security properties.

- `customer-managed` is customer-operated, permits exactly one organization,
  uses embedded Better Auth with an installation-local authentication database,
  supports local or remote
  workspace execution, and has no required LemmaComputer-hosted control-plane,
  billing, telemetry, or background-job dependency.
- `hosted` is LemmaComputer-operated, supports multiple organizations, permits
  embedded Better Auth customer authentication with a pooled logical
  authentication database, retains a separate workforce operator realm, requires a platform-qualified
  remote-isolated workspace provider, and permits managed billing, telemetry,
  and hosted workers.
- `worktree` is development-only. It may exercise either profile's adapters for
  testing but is never a production edition. The historical installation-kind
  value is a development-harness selector; documentation and qualification must
  not present it as a third production deployment profile.

Workforce Entra in customer-managed and External ID/enterprise Entra in hosted
are bounded transitional customer adapters. Both production profiles expose the
same provider-neutral Better Auth method contract: email/password, passkey,
Google, Microsoft, SAML, and OIDC. Profile eligibility never makes provider
claims authoritative for organizations, roles, permissions, or placement.

The profile contract selects an admissible execution boundary and required
controls, not a workspace vendor. Production providers must project tenant
context and signed policy, enforce governed egress, emit lifecycle audit
evidence, and prove verified purge. A driver-name-to-topology registry lets
preflight reject local host control-plane authority in `hosted` without making
remote Kasm the product architecture. Provider qualification remains separate:
passing the topology gate does not certify an adapter for production.
Runtime routing likewise follows the explicit workspace-node topology. A
worktree using `remote` exercises the same placement-aware controller router as
hosted; a profile-name check must not silently substitute the direct controller
client.

Profile-sensitive consumers call the typed resolver or an assertion such as
`assertSignInProviderAllowed`, `assertCustomerAuthenticationMethodAllowed`, `assertOrganizationCountAllowed`,
`assertWorkspaceDriverTopologyAllowed`, or `assertHostedCapability`. They do
not branch directly on environment variables. The assertions are capability
gates, not substitutes for request authorization or provider qualification.

Preflight rejects an implicit profile, a profile/command mismatch, hosted local
workspace execution, hosted HTTP public or administration endpoints,
customer-managed hosted MCP configuration, and an unconfigured customer
directory tenant.

## Consequences

New profile-dependent features must extend the checked-in matrix and its tests
before adding runtime behavior. Both production profiles remain buildable from
the same commit and expose the same service topology; platform overlays provide
infrastructure differences. A customer-managed installation can be tested with
network access to LemmaComputer-operated control-plane services denied.

Remote Kasm, E2B BYOC, or a future provider may satisfy the hosted topology only
after its own qualification evidence proves the required controls. Experimental
providers stay pilots and cannot be presented as production-ready merely by
registering a driver identifier.

The capability package does not create organizations, implement sign-in, assign
roles, or authorize users. Those remain owned by the identity and RBAC work.
