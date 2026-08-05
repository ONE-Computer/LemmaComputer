# ADR 0003: Deployment profile capability contract

- Status: Accepted
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
  uses customer-configured workforce Entra identity, supports local or remote
  workspace execution, and has no required LemmaComputer-hosted control-plane,
  billing, telemetry, or background-job dependency.
- `hosted` is LemmaComputer-operated, supports multiple organizations, permits
  hosted External ID and enterprise Entra providers, requires remote workspace
  execution, and permits managed billing, telemetry, and hosted workers.
- `worktree` is development-only. It may exercise either profile's adapters for
  testing but is never a production edition.

Profile-sensitive consumers call the typed resolver or an assertion such as
`assertSignInProviderAllowed`, `assertOrganizationCountAllowed`,
`assertWorkspaceDriverAllowed`, or `assertHostedCapability`. They do not branch
directly on environment variables. The assertions are capability gates, not
substitutes for request authorization.

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

The capability package does not create organizations, implement sign-in, assign
roles, or authorize users. Those remain owned by the identity and RBAC work.
