# ADR 0002: One product, explicit deployment profiles

- Status: accepted; original sign-in-provider plan superseded by [ADR 0006](0006-better-auth-only-customer-and-platform-authentication.md)
- Date: 2026-08-05

## Context

LemmaComputer needs one release stream for customer-operated single-tenant
installations and LemmaComputer-operated multi-organization hosting. If each
service interprets environment variables independently, a new route can
silently disagree with preflight about its security boundary.

## Decision

`@lemmacomputer/deployment-profile` owns the checked-in capability matrix,
resolver, and assertions. A deployment selects one profile explicitly:

| Profile | Meaning |
| --- | --- |
| `customer-managed` | Customer-operated, exactly one organization, no required LemmaComputer-hosted control plane |
| `hosted` | LemmaComputer-operated, multi-organization, remote-isolated workspace execution and separate platform-operator realm |
| `worktree` | Isolated development harness, never a production edition |

All profiles use one product codebase, tenant-scoped records, and forward
migration streams. Better Auth customer methods are shared by the two
production profiles. Authentication method eligibility does not grant an
organization, role, permission, or placement; product RBAC is separate.

Runtime consumers use the typed resolver and assertions such as
`assertCustomerAuthenticationMethodAllowed`,
`assertOrganizationCountAllowed`, `assertWorkspaceNodeTopologyAllowed`, and
`assertHostedCapability`. Workspace execution topology is an explicit
boundary: hosted cannot use a colocated Docker controller, while a worktree
may exercise remote routing for qualification. A provider name alone does not
prove production isolation or readiness.

Preflight rejects missing or inconsistent profile settings, unsupported
workspace topology, and missing hosted security controls. Passing preflight
checks configuration shape; it does not qualify an external provider or a
live deployment.

## Consequences

New profile-dependent features update the matrix and its tests before
runtime branching. Customer-managed operation can be tested without a
LemmaComputer-hosted service dependency. Any new workspace provider must
separately prove policy projection, credential isolation, egress, lifecycle
audit, and verified purge before production use.
