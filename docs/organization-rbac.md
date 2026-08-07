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

The built-in roles are `owner`, `admin`, and `member`. Permission catalog version 1 is fixed in `packages/workspace-store/src/rbac.ts` and mirrored in the database. Owners receive the complete catalog; administrators cannot transfer ownership; members can read their organization and use assigned workspaces. Unknown roles and permissions fail closed.

The API temporarily projects legacy `administrator`/`employee` role names alongside the membership role so the previous web client can roll back safely. Authorization uses the membership role, not that compatibility projection or a caller-supplied permission array.

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
