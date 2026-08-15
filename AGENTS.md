# LemmaComputer agent instructions

These instructions apply to the entire repository. A more specific `AGENTS.md` may add subsystem rules but cannot weaken these safety rules.

## Product and deployment invariant

LemmaComputer has one product codebase with two supported deployment profiles:

- `customer-managed`: a customer runs a single-tenant installation in its own environment.
- `hosted`: LemmaComputer operates the service and isolates multiple customer organizations.

Do not fork a separate self-hosted codebase. Keep deployment-specific behavior behind explicit configuration and interfaces. Every persisted or cached customer-owned record must be tenant-scoped in both profiles. A separate repository requires an ADR proving that shared releases, migrations, and security fixes cannot remain safe.

## Choose the repository setup before acting

Use [Evaluation, development, and remote workspace workflow](docs/guides/development-workflow.md)
as the single setup authority. Classify the request before initializing an
environment:

| User outcome | Required setup |
| --- | --- |
| Read, explain, diagnose, or review | No stack unless evidence requires one; do not create a branch for read-only work. |
| Explore the product without changing code | Dedicated disposable evaluation clone using `npm run env:init -- --profile=worktree`; never the primary integration checkout. |
| Change code or documentation | One task branch in one Git worktree; run `npm run worktree:init` once and `npm run dev:doctor` each session. |
| Test the remote workspace boundary or Claude Cowork | An initialized task worktree, then `npm run qualify:remote-workspace-node -- up [--cowork]`; never `main` or a manually selected hosted profile. |
| Exercise customer-managed Microsoft integration | Follow `docs/guides/local-deployment.md`; code changes remain in the worktree profile, while a dedicated operator evaluation may use `customer-managed`. |
| Qualify hosted production | Use representative hosted infrastructure; local split-node Compose is not production qualification. |

If the user asks only to "set up", "run", or "test" and the missing choice
would materially change isolation, data ownership, topology, or external
requirements, ask whether they want disposable evaluation, isolated
development, local remote-node/Cowork qualification, or a production-profile
deployment. Do not ask when the request already determines the setup.

Do not invent a hybrid setup. In particular, do not develop from the evaluation
clone, run a local stack from the primary `main` checkout, copy another
checkout's `.env`, or use `compose.hosted.yaml` to approximate hosted.

## Before changing code

1. Treat the user's request as the task contract. If a GitHub issue exists, also read its definition of success and unresolved `blocked by` relationships.
2. Select the setup from the table above and follow the single workflow guide. Read `docs/guides/local-deployment.md` only when the task specifically needs the customer-managed Entra or Microsoft 365 integration flow.
3. Use one task per branch and one branch per worktree. Do not develop directly on `main`.
4. Run `npm run worktree:init` once in a new worktree, then `npm run dev:doctor` at the start of each work session.
5. Keep changes inside the task scope. Record substantial follow-up work separately instead of expanding the task silently.

Branch names should use `<issue>-<short-name>` when an issue exists and `<short-name>` otherwise, unless the user or execution environment requires a prefix. Parallel worktrees must never share `.env`, Compose project names, container names, ports, networks, images, volumes, or databases.

Local development never owns a shared stack on `main`. Each task worktree owns one `worktree`-profile stack created from its generated `.env`. Do not switch to `hosted` to test multiple organizations, choose a Compose file by name, copy another checkout's `.env`, or hand-edit `.env.example`.

## Local stack lifecycle

For the first start of a new task worktree, where fresh databases are intended,
run:

```bash
npm run worktree:init
npm run dev:doctor
npm run env:check
npm run compose:up
```

Once the worktree contains users, providers, pricing, sessions, workspaces, or
other state, resume that same stack with:

```bash
npm run dev:doctor
npm run env:check
npm run compose:up
```

`dev:doctor` is read-only and does not attach volumes. `compose:up` reuses the
Compose project name in `.env` and reattaches that worktree's existing database
volumes. For remote-node/mTLS work, use
`npm run qualify:remote-workspace-node -- up [--cowork]` instead of ordinary
`compose:up`; it retains the worktree databases and persistent volumes.

`npm run compose:down` preserves volumes. Never pass `-- --volumes` for a
data-bearing stack. Moving state to another worktree or renaming its Docker
namespace requires the exclusive
[stateful local-stack handover](docs/guides/development-workflow.md#stateful-local-stack-handover);
never attach the same writable volumes to concurrent worktrees.

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

Read `packages/workspace-store/AGENTS.md` and `docs/guides/database-migrations.md` before changing persistence.

- Application startup checks schema compatibility; it never migrates.
- Only the explicit migration command/job may change schema.
- Migrations are forward-only, immutable after application, transactional, checksummed, dependency-ordered, and advisory-lock serialized.
- Generate migrations with `npm run db:migration:new -- <name>`; never hand-allocate a sequential number.
- Prefer expand/migrate/contract across separate releases. Destructive contraction requires a backup/restore plan and a dedicated issue.
- Never point worktree tests or migrations at the demo database.

## Testing and handoff

The issue definition of success is the test contract. Use
[CONTRIBUTING.md](CONTRIBUTING.md) as the command, tool, and test-suite index;
do not infer a new test workflow from nearby files. Add the smallest automated
tests that prove the change and report:

- commands run and their outcomes;
- schema and migration impact;
- deployment-profile impact;
- any untested behavior or follow-up issue;
- the exact commit SHA eligible for integration.

Changes to user-visible behavior in `apps/web` must run the smallest relevant Playwright suite in addition to `npm run verify:quick`. Run `npm run test:activity:e2e` for Activity panel work and `npm run test:e2e` when a change spans multiple browser flows. Backend-only changes do not require Playwright unless the issue definition of success requires browser coverage.

Treat visual baselines as reviewed product artifacts. Update Playwright snapshots only when the visual change is intentional and has been inspected; never update snapshots only to make a failing comparison pass.

Do not claim completion with skipped required database tests, a dirty worktree, or a known baseline failure.
