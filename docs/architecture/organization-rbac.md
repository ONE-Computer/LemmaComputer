# Organization roles and permissions

Authentication identifies an account. LemmaComputer separately resolves its
active organization membership, product role, resource scope, and permission
for each protected action. Email, domain, provider groups, and directory roles
do not grant product access. See [Authentication](authentication.md) for sign-in
and admission.

## Records

`account_users` is the stable product person and is not keyed by email.
`organization_memberships` joins an account to an organization and its
organization-local subject. The `users` row remains that local subject for
workspaces, policies, Teams, channels, and audit. One account in two
organizations has two local subject IDs. A product session binds one active
membership. `tenants` remains the tenant key on customer-owned records.

The built-in roles are `owner`, `admin`, and `member`. Owners receive the
current permission catalog; administrators cannot transfer ownership. The
last active owner is protected by a database guard. Unknown roles,
permissions, catalog versions, scopes, and cross-tenant references deny.

## Custom roles

A membership may also have tenant-defined role assignments. Each custom role
has a stable ID and immutable versions. A version records its permission
catalog snapshot and explicit grants at supported scopes:

| Scope | Meaning |
| --- | --- |
| Organization | The whole active organization |
| Workspace | One verified workspace in that organization |
| Provider | One verified connector or model provider in that organization |

Permission-specific scope rules reject arbitrary resource types, predicates,
provider claims, and per-user exceptions. Effective authority is the union of
the protected membership role and active custom-role versions. An old catalog
snapshot grants no newly added permission until an authorized administrator
saves a new role version.

A role administrator needs `organization.manage_roles` and can delegate only
permissions and resource scopes already contained in their own server-resolved
authority. `organization.transfer_ownership` is never delegable through a
custom role. Collection APIs filter to exact grants; one workspace or provider
grant does not reveal every resource of that type. Browser capability hints
improve navigation, but every write and read rechecks authority on the server.

Role, assignment, and membership changes append tenant-local audit events and
revoke affected product sessions in the same transaction. A request already
in flight may complete; the next protected request must resolve the changed
authority. Unknown or mismatched role snapshots fail closed.

## Admission and deployment profiles

Customer-managed installations allow one organization. Hosted accounts can
belong to multiple organizations but must select an active membership.
Invitation acceptance, owner bootstrap, and tenant SSO follow the current
[authentication contract](authentication.md#customer-sign-in-and-admission).
The old direct workforce-Entra JIT admission and role projection are not
current sign-in paths.

Both profiles use the same tenant keys and permission checks. A dedicated
database or workspace node never grants a role by itself. Current schema and
backfill procedures are in [Database migrations](../guides/database-migrations.md)
and source migration code; this page is the authorization contract, not a
one-time migration runbook.
