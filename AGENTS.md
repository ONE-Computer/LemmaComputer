# LemmaComputer agent instructions

These instructions apply to the entire repository. A more specific `AGENTS.md` may add subsystem rules but cannot weaken these safety rules.

## Product and deployment invariant

LemmaComputer has one product codebase with two supported deployment profiles:

- `customer-managed`: a customer runs a single-tenant installation in its own environment.
- `hosted`: LemmaComputer operates the service and isolates multiple customer organizations.

Do not fork a separate self-hosted codebase. Keep deployment-specific behavior behind explicit configuration and interfaces. Every persisted or cached customer-owned record must be tenant-scoped in both profiles. A separate repository requires an ADR proving that shared releases, migrations, and security fixes cannot remain safe.

## Before changing code

1. Treat the user's request as the task contract. If a GitHub issue exists, also read its definition of success and unresolved `blocked by` relationships.
2. Use one task per branch and one branch per worktree. Do not develop directly on `main`.
3. Run `npm run worktree:init` once in a new worktree, then `npm run dev:doctor` at the start of each work session.
4. Keep changes inside the task scope. Record substantial follow-up work separately instead of expanding the task silently.

Branch names should use `codex/<issue>-<short-name>` when an issue exists and `codex/<short-name>` otherwise. Parallel worktrees must never share `.env`, Compose project names, container names, ports, networks, images, volumes, or databases.

## Integration and demo releases

`main` is the integration branch. The running demo is a separate deployment pinned to an immutable `demo-*` tag, so ordinary changes to `main` do not change the demo.

- Feature work happens in isolated branches/worktrees and is merged into `main` after `npm run verify:quick`.
- Database or migration changes also require `npm run verify:db` before integration.
- The integration owner may merge and push `main`; there is no GitHub Actions, paid branch protection, or blocking local hook.
- A demo release requires a clean pushed commit on `main` or `release/*`, `npm run verify:release`, then `npm run release:tag -- --push`.
- `release:tag` pushes only a new immutable tag. It never moves a branch or reuses a tag.
- Create a temporary `release/*` branch only when demo stabilization must continue while new work lands on `main`. Merge its fixes back into `main`.
- Deploy the exact demo tag and image digest, never a moving branch or dirty checkout.

Local command output is the verification record. Do not claim a check ran when it did not.

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

Changes to user-visible behavior in `apps/web` must run the smallest relevant Playwright suite in addition to `npm run verify:quick`. Run `npm run test:activity:e2e` for Activity panel work and `npm run test:e2e` when a change spans multiple browser flows. Backend-only changes do not require Playwright unless the issue definition of success requires browser coverage.

Treat visual baselines as reviewed product artifacts. Update Playwright snapshots only when the visual change is intentional and has been inspected; never update snapshots only to make a failing comparison pass.

Do not claim completion with skipped required database tests, a dirty worktree, or a known baseline failure.
