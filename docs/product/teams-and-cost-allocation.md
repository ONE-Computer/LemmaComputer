# Teams and cost allocation

LemmaComputer uses **Team** as the human-facing boundary for allocating AI usage. A Team is an internal organization group such as Finance, Engineering, or Customer Success. The optional `cost_center_code` is only an external accounting reference attached to that Team; it is not the Team's identity and it does not need to be present.

## Access-control boundary

Team membership controls cost attribution only. It never grants or revokes:

- administrator or employee roles;
- workspace access or policy assignments;
- model, connector, or tool permissions;
- network security groups or protected-action authority.

Continue to manage those capabilities through their existing policy and administration surfaces. Do not infer authorization from Team ownership or membership.

## Membership and defaults

A user may belong to several active Teams, but has exactly one active default spending Team. The default is the allocation destination used by later usage-ledger work. Changing the default ends the previous default assignment interval and creates a new one, preserving history.

The P0 administration surface applies membership and default changes immediately. Future-dated effective times are rejected rather than being shown as active before their start time. Scheduled allocation changes require a later, explicit interval-scheduling design.

During rollout, asking LemmaComputer to resolve a default for an active user with no valid assignment creates or uses the tenant-owned **Unallocated** fallback. Administrators should move users out of Unallocated as ownership becomes known. Spend must never be silently discarded because membership data is incomplete.

Removing a membership does not delete its interval. A default membership must be transferred before it can be removed. Archiving a Team preserves all Team, membership, default-assignment, and audit history; active defaults on the archived Team move to Unallocated.

## Administration

Administrators manage Teams from **AI control plane → Teams & budgets**:

1. Create a Team with a name, owner/budget manager, optional description, and optional cost-center code.
2. Assign active organization users as members.
3. Choose the default spending Team for each user.
4. Archive Teams that should no longer receive new allocations.

Team changes emit tenant-scoped administrator audit events containing IDs and changed-field names rather than copied descriptions, names, email addresses, or cost-center values.

## Deployment profiles

The identical tenant-scoped schema and migration stream is used by both `customer-managed` and `hosted` profiles. A customer-managed installation is still required to persist tenant IDs so backups, support tooling, later hosted migration, and security checks use the same contracts.

The migration adds the composite unique index `users(tenant_id, id)` required by tenant-safe foreign keys. PostgreSQL builds it transactionally, so operators with a large hosted `users` table should assess its scan and lock window and schedule the migration during an appropriate maintenance period. Application startup never creates this index.
