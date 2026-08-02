# Development workflow

This repository uses isolated worktrees for concurrent development and immutable tags for demo deployments. The running demo is not tied to `main`. GitHub Actions and paid branch protection are intentionally not required; checks run explicitly on the machine doing the work.

## Scheduling work

The user's request is the task contract. When a GitHub issue exists, its definition of success and native `blocked by` relationships add to that contract. A task with a known unresolved blocker is not runnable; otherwise it may start whenever worktree capacity is available. No artificial wave boundary is required.

One agent owns one task, one branch, and one worktree. Avoid broad shared foundation branches. When two tasks require the same contract, land the contract first and let both consumers update from `main`.

## New worktree

From a clean primary checkout:

```bash
git fetch origin
git worktree add <path> -b codex/<issue>-<short-name> origin/main
cd <path>
npm run worktree:init
npm run dev:doctor
```

`worktree:init` refuses `main`, creates fresh local secrets, assigns unique Compose/container/network/image names and ports, and installs or safely reuses dependencies. Fill only the provider and Entra placeholders needed by the task. Never copy the demo `.env`.

Use normal Compose commands inside the worktree. Its generated `.env` keeps volumes and databases separate. `npm run compose:down` preserves its volumes unless `-- --volumes` is intentionally supplied.

## Local gates

- `npm run dev:doctor`: environment, dependency, and Docker-context safety.
- `npm run verify:quick`: doctor, environment parity, Compose parsing, TypeScript builds, and the full non-database test suite.
- `npm run verify:db`: disposable PostgreSQL migration qualification.
- `npm run verify:release`: provider and OAuth qualification, quick and DB
  gates, workspace-image build, isolated Compose health, and a real Hermes
  workspace readiness smoke; writes a SHA-bound local attestation.

Run `verify:quick` before handoff or integration. Run `verify:db` whenever persistence, migration, startup ordering, backup compatibility, or tenant scoping changes. Update the task branch from current `main` when needed, resolve conflicts there, and rerun the applicable gates before merging.

## Integration

The integration owner reviews the task scope and reported checks, then merges the feature branch into `main`. `main` should remain buildable, but it is not the deployed demo and ordinary integration does not require the full release gate.

```bash
git switch main
git pull --ff-only
git merge --no-ff <feature-branch>
git push origin main
```

There is no blocking pre-push hook. This keeps the workflow visible: the operator runs the required checks and reports their result instead of relying on hidden local enforcement.

## Demo release

Usually, release directly from a clean, already-pushed `main`:

```bash
git switch main
git pull --ff-only
npm run verify:release
npm run release:tag -- --push
```

`release:tag` requires the current clean commit to match its pushed branch and a recent exact-SHA release attestation. It creates and optionally pushes `demo-YYYYMMDD-<sha>` without moving `main`.

Use a temporary `release/<name>` branch only when the demo needs a stabilization line while unrelated development continues on `main`. Run the same release commands on that branch, and merge every release fix back into `main`.

Deploy the immutable tag, not `main` or `release/*`. Each release gets a new tag; never delete, move, or reuse an existing demo tag.

## Merge conflict policy

Do not resolve migration conflicts by renumbering or editing a migration already applied anywhere. ULIDs avoid filename collisions; explicit `depends-on` metadata expresses ordering. If two parallel migrations touch the same object, add a small reconciliation issue and dependency, then regenerate or supersede only unreleased work.
