# ONEComputer agent instructions

These instructions apply to the entire repository. A more specific `AGENTS.md` may add subsystem rules but cannot weaken these safety rules.

## Product and deployment invariant

ONEComputer has one product codebase with two supported deployment profiles:

- `customer-managed`: a customer runs a single-tenant installation in its own environment.
- `hosted`: ONEComputer operates the service and isolates multiple customer organizations.

Do not fork a separate self-hosted codebase. Keep deployment-specific behavior behind explicit configuration and interfaces. Every persisted or cached customer-owned record must be tenant-scoped in both profiles. A separate repository requires an ADR proving that shared releases, migrations, and security fixes cannot remain safe.

## Before changing code

1. Read the GitHub issue, its definition of success, and its native `blocked by` relationships.
2. Work only when every blocker is closed. Recheck the `dev` project after each merged dependency; start any newly unblocked issue without waiting for an artificial wave boundary.
3. Use one issue per branch and one branch per worktree. Never develop on `main`.
4. Run `npm run worktree:init` once in a new worktree, then `npm run dev:doctor` at the start of each work session.
5. Keep changes inside the issue scope. Record newly discovered work as a separate issue with explicit dependencies.

Branch names should use `codex/<issue>-<short-name>` for agent work. Parallel worktrees must never share `.env`, Compose project names, container names, ports, networks, images, volumes, or databases.

## Main and demo safety

`main` is the demo-candidate branch. It must remain runnable at all times.

- Never edit, merge into, or push `main` directly.
- There is deliberately no GitHub Actions or paid branch-protection dependency. Local gates and the pre-push hook are the enforcement mechanism.
- Before handoff, run `npm run verify:quick`.
- Database or migration changes also require `npm run verify:db`.
- Only a clean committed SHA that passed `npm run verify:release` may be promoted.
- `npm run release:promote -- --sha=<sha> --push` is the only supported main push. It performs a non-force, atomic fast-forward and immutable demo tag.
- The demo deployment follows an immutable `demo-*` tag, never a moving worktree or unverified `main` checkout.

A hook is accident prevention, not a security boundary. Do not bypass it.

## Database rules

Read `packages/workspace-store/AGENTS.md` and `docs/database-migrations.md` before changing persistence.

- Application startup checks schema compatibility; it never migrates.
- Only the explicit migration command/job may change schema.
- Migrations are forward-only, immutable after application, transactional, checksummed, dependency-ordered, and advisory-lock serialized.
- Generate migrations with `npm run db:migration:new -- <name>`; never hand-allocate a sequential number.
- Prefer expand/migrate/contract across separate releases. Destructive contraction requires a backup/restore plan and a dedicated issue.
- Never point worktree tests or migrations at the demo database.

## Testing and handoff

The issue definition of success is the test contract. Add the smallest automated tests that prove it and report:

- commands run and their outcomes;
- schema and migration impact;
- deployment-profile impact;
- any untested behavior or follow-up issue;
- the exact commit SHA eligible for integration.

Do not claim completion with skipped required database tests, a dirty worktree, or a known baseline failure.
