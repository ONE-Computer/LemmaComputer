# Organization RBAC and identity boundary

LemmaComputer treats authentication and authorization as separate decisions:

`identity provider -> external identity -> account user -> organization membership -> local subject -> role -> permission -> resource decision`

The identity provider proves an immutable issuer/subject (and Entra tenant/object ID). It never grants a LemmaComputer role from email, domain, groups, or directory-administrator claims.

## Records and compatibility

- `account_users` is the stable product person and is not keyed by email.
- `external_identities` links immutable provider identifiers to an account user. Its legacy `user_id` remains during the expand/migrate rollback window.
- `organization_memberships` links an account user to one organization, role, lifecycle status, and organization-local subject.
- `users` remains the organization-local subject used by existing tenant-scoped resources, policies, Teams, channels, and audit actors. One account in two organizations therefore has two local user IDs.
- `browser_sessions.membership_id` binds every new session to exactly one membership. The legacy user reference remains readable during rollout.
- `tenants` remains the physical organization/tenant key for existing resource foreign keys; `organizations` carries the explicit product organization lifecycle.

The built-in roles are `owner`, `admin`, and `member`. Permission catalog
versions 1 and 2 are immutable snapshots in
`packages/workspace-store/src/rbac.ts` and mirrored in the database; version 2
is the current catalog. Owners receive the complete current catalog;
administrators cannot transfer ownership; members can read their organization
and use assigned workspaces. Unknown roles, catalog versions, and permissions
fail closed. Version 2 deliberately limits `audit.read` to organization scope:
the current team audit records do not carry a trustworthy workspace identifier,
so the API does not claim to provide workspace-filtered audit evidence. The
version-1 snapshot remains unchanged for historical role validation.

The API temporarily projects legacy `administrator`/`employee` role names alongside the membership role so the previous web client can roll back safely. Authorization uses the membership role, not that compatibility projection or a caller-supplied permission array.

## Tenant-defined roles

Owner, Administrator, and Member remain protected membership roles. They cannot
be renamed, archived, represented by a custom role, or replaced by an identity
provider claim. A membership may additionally hold any number of tenant-defined
role assignments.

Each custom role has a stable UUID and an immutable sequence of versions. A
version records its exact permission catalog version and explicit grants. A
grant is one catalog permission plus one supported scope:

- `organization` applies to the organization and all resources of that type;
- `workspace` names one workspace that is verified to belong to the active
  organization;
- `provider` names one configured connector or model provider in the active
  organization.

Scope types are permission-specific. Arbitrary permission strings, resource
types, predicates, provider groups, and direct per-user exceptions are rejected.
The Control API derives the organization and actor from the authenticated
membership and the store recomputes both actor and target authority from the
database. It never trusts a browser permission list or authentication-provider
role claim.

The effective permission set is the union of the protected membership role and
all active assigned custom-role versions. Resource grants remain exact: a grant
for workspace A does not authorize workspace B. Any unknown catalog version,
role status/version, permission, scope type, cross-tenant role or membership,
or grant/snapshot mismatch invalidates the resolved custom authority and fails
closed. Assigned roles from different supported catalog snapshots may coexist:
each role is validated and resolved only against its recorded snapshot.

Delegation is constrained twice. The actor must possess
`organization.manage_roles` at organization scope, and every permission/resource
scope in the proposed role or assignment must be contained by the actor's own
server-resolved authority. `organization.transfer_ownership` is never delegable
through a custom role; ownership continues through the protected role and the
last-active-owner database guard.

The role-administration API projects that same boundary into the client. Its
catalog contains only permissions and scope types the current actor can
delegate; exact workspace or provider grants include only their server-resolved
resource IDs. Member administration separately returns the protected built-in
roles the actor may delegate. The browser therefore does not offer role changes
outside that set, and a workspace management control appears only for an
organization-wide or exact workspace `workspace.manage` grant. These projections
improve the interface, while write endpoints continue to recompute authority.

Catalog snapshots are append-only. When the product adds a permission it creates
a later catalog snapshot; existing role versions retain their earlier catalog
and explicit grant rows. New product permissions therefore grant nothing to a
role on an earlier snapshot until an authorized tenant administrator
intentionally saves a new role version. An organization may consequently have
active version-1 and version-2 role assignments at the same time.

The Control API enforces resource-scoped grants against the concrete workspace
or provider named by the request. Usage queries may select an exact workspace
or provider and are filtered before reading records. The authenticated session
exposes both organization-scoped `capabilities` and exact
`resourceCapabilities`. The browser uses them to hide member, role, workspace,
provider, connector, usage, and policy surfaces it cannot open. A provider grant
for `openai` does not reveal or administer `anthropic`; a connector grant for
`linear` does not reveal or administer `slack`; and workspace administration
resolves the target user's concrete workspace ID before checking an exact
workspace grant. Server authorization remains authoritative for every request.

Each administrative route checks the permission for its actual function:
`organization.manage_settings` is not an administrator shortcut. Team reads use
`usage.read`, team and budget changes use `usage.manage`, provider and connector
administration uses `provider.manage`, routing and workspace firewall changes
use `policy.manage`, workspace settings use `workspace.manage`, and audit reads
use `audit.read`. Collection endpoints filter resources to the caller's exact
grants instead of turning any one resource grant into organization-wide access.

Role create, update, archive, assign, and unassign operations append tenant-local
audit evidence. Updates advance the immutable version and move every assignment
to it in one transaction. Assignment changes, custom-role changes, and changes
to a protected membership role revoke affected product sessions in that same
transaction and append `session.revoked` evidence with reason
`ROLE_AUTHORITY_CHANGED`. A request already executing may finish, but the next
request must reauthenticate and resolve the new authority; there is no cache or
token-permission convergence window.

## Admission profiles

- `customer-managed` uses explicit directory JIT admission into the single configured organization. JIT creates only a `member` unless the immutable Entra object ID matches the one-time bootstrap-owner configuration.
- `hosted` uses invitation-bound admission. Only a valid pending invitation may create the first active membership, and it supplies the exact organization and role. A provider account or provider claim alone grants no product access.
- `worktree` uses the customer-managed JIT behavior only as an explicit development mode.

Email and display-name changes update contact/display data only. They never link identities, choose an organization, or elevate a role.

## Migration and rollback

The schema migration is expand-only: it adds organization/account/membership/catalog tables plus nullable compatibility columns. It does not backfill the full user or session tables inside the schema transaction.

After `npm run db:migrate`, run the explicit resumable job before deploying the new Control version:

```bash
npm run db:backfill:organization-rbac
```

`ORGANIZATION_RBAC_BACKFILL_BATCH_SIZE` defaults to 100 and accepts 1–1000. The job holds one application advisory lock, processes bounded transactions, is idempotent, links existing identities/sessions, maps administrators to owners and employees to members, and refuses success while any legacy user, identity, or session is unlinked. Running it a second time must report zero users backfilled.

The backfill adds row-level writes and short locks on each user batch. It does not rewrite customer resource tables or drop legacy columns. The previous application version continues reading `users`, `user_roles`, and session `user_id`; new code dual-writes the legacy employee/administrator projection for newly admitted users. A later dedicated contraction may require the new foreign keys and remove legacy reads only after the rollback window expires.

Suspending or revoking one membership revokes only sessions for that membership. Every role/status mutation serializes on the organization, the database rejects removal of the last active owner, and audit events retain the actor's organization-local subject.

The tenant-role migration is also expand-only. It adds custom role, version,
grant, assignment, and audit tables without rewriting memberships or changing
the built-in role column. The previous application version ignores these new
tables, so rollback consists of returning to the previous application SHA; the
new data remains inert and recoverable. Both hosted and customer-managed
profiles run the identical migration and retain organization keys. There is no
role backfill because existing memberships keep their protected built-in role.
