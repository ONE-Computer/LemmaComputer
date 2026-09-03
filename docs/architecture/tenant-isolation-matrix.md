# Tenant and authentication isolation matrix

This matrix is the reviewed contract for authentication and product-authorization data. Its machine-readable companion is [`config/tenant-isolation-manifest.json`](../../config/tenant-isolation-manifest.json). The manifest names every persisted authentication and control-plane table created by the complete migration streams.

## Authority boundary

Better Auth proves who authenticated. LemmaComputer decides which organization and resources that identity may access.

Those authorities are intentionally stored separately:

- the authentication database owns credentials, provider accounts, MFA material, passkeys, verification challenges, rate limits, and Better Auth sessions;
- the control database owns organizations, memberships, roles, invitations, product sessions, tenant SSO lifecycle, and platform-operator authority;
- there are no cross-database foreign keys and no authentication-provider claim may create or expand product access;
- a Better Auth session identifies an account only. A server-verified, active membership selects an organization for a product session.

## Operation review

Every declared resource classifies the same operation surface in this order: **read, create, update, delete, list, search, export, stream, privileged**. An operation is either `covered` by server-side scoping and test evidence or `not-applicable`; omission is not allowed.

| Profile | Scope rule | Important denial rule |
| --- | --- | --- |
| Private authentication | Account-owned row or an explicitly bound organization ID | Never expose credentials, tokens, challenges, or provider configuration through product APIs. |
| Ephemeral authentication | Account, attempt, or rate-limit key | Reject expired, replayed, or state-mismatched challenges without revealing whether another tenant owns one. |
| Organization control | Explicit `organization_id`/`tenant_id`, or a documented membership join | Resolve the caller's active membership server-side; never accept a client claim as authority. |
| Append-only audit | Organization or platform-operator scope recorded with the event | No mutation or deletion path; exports remain scope-filtered and privileged. |
| Global catalog | Deliberately non-customer-owned static catalog | Read-only; a catalog row cannot grant a tenant assignment. |
| Platform-operator control | Separate operator identity and elevation authority | Customer identities and organization roles never imply operator access. |
| Background job | Organization recorded on the job and rechecked at execution time | Revoked or closing tenants fail before work or side effects begin. |

## Deployment profiles

In the `hosted` profile, pooled infrastructure may contain records for multiple organizations. Every query, command, export, stream, callback, background job, and privileged action must derive its organization scope from current server-side authority. Cross-tenant identifiers receive the same not-found or forbidden response shape as nonexistent identifiers.

In the `customer-managed` profile, the installation supports exactly one organization. Attempts to create, select, invite into, or operate on a second organization fail closed even though the deployment is physically dedicated.

Dedicated placement is an infrastructure property, not an authorization shortcut. The same organization predicates and session checks apply to pooled and dedicated placement.

Hosted workspace-node registration is global platform-operator state, while a
tenant's default node assignment is explicitly organization-scoped. The
assignment is copied into each workspace at creation so changing a default
cannot redirect an existing workspace to another node. Customer sessions and
organization roles have no read or mutation path to the node registry.

Chat conversations, normalized messages, agent runs, vendor session bindings,
artifact metadata, and artifact revisions are Control-owned organization data.
Every lookup derives `tenant_id`, `subject_id`, and `workspace_id` from current
server authority; an object-store key is an opaque locator, never authorization.
Hosted artifact ingestion additionally matches the workspace's persisted owning
node and generation before Control promotes staged bytes to a durable revision.

Microsoft 365 selected-site configuration is organization-scoped by
`microsoft365_sharepoint_sites.tenant_id`. Control returns only verified sites
from the same tenant to an active workspace agent, and the stored record holds
only canonical URLs plus non-secret Graph site, drive, and permission
identifiers. User OAuth tokens remain in the gateway credential boundary. The
shared multi-tenant connector and site-administration registrations create
separate service principals in each consenting customer directory. Control
binds both signed consent callbacks to the LemmaComputer organization and
requires their provider directory IDs to match before changing a site grant.
The separate site-administration credential is projected only to Control and is
used to obtain a short-lived application token for explicit grant/revoke
operations; it is never projected to a workspace or the MCP connector.

## Revocation and replay rules

- Membership suspension, removal, organization closure, product-session revocation, and operator elevation expiry take effect at the next protected operation.
- A stale browser session, socket, grant, callback state, invitation context, or queued job cannot retain authority after its backing membership or generation is invalidated.
- OAuth/OIDC state is single-purpose, short-lived, and bound to the initiating browser and intended flow. A provider callback proves authentication but cannot select an organization or role.
- Invitation acceptance is bound to the invitation's normalized email, organization, role, expiry, and one-time context. Replaying it from another identity must not reveal whether the target organization or membership exists.

## Evidence policy

Each manifest resource links to focused automated evidence. Static coverage catches new identity/IAM tables that have no declared scope. PostgreSQL integration tests prove database constraints and transaction behavior. API and service tests exercise cross-tenant identifiers, stale authority, and indistinguishable denials. Hosted two-organization and customer-managed negative flows are release gates for this issue.

The manifest covers the complete persisted schema, including product resources, caches, audit records, grants, callbacks, and background-job state. Non-table runtime state such as live sockets and external execution runtimes is covered by behavioral revocation and replay tests rather than by a schema declaration.
