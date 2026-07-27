# Development workflow

This repository optimizes for parallel issue worktrees while keeping `main` continuously demoable. GitHub Actions and paid branch protection are intentionally not required; the equivalent gates run locally.

## Scheduling work

GitHub issue relationships are the scheduling source of truth. An issue is runnable when it has a testable definition of success and every native `blocked by` issue is closed. “Waves” are planning snapshots, not barriers: after any dependency closes, rescan the `dev` project and start every newly unblocked issue that fits available worktree capacity.

One agent owns one issue, one branch, and one worktree. Avoid broad shared foundation branches. When two issues need the same new contract, make that contract a small blocking issue, land it first, and let both consumers rebase onto the verified commit.

## New worktree

From a clean primary checkout:

```bash
git fetch origin
git worktree add <path> -b codex/<issue>-<short-name> origin/main
cd <path>
npm run worktree:init
npm run dev:doctor
```

`worktree:init` refuses `main`, creates fresh local secrets, assigns unique Compose/container/network/image names and ports, installs the local pre-push hook, and installs or safely reuses dependencies. Fill only the provider and Entra placeholders needed by the issue. Never copy the demo `.env`.

Use normal Compose commands inside the worktree. Its generated `.env` keeps volumes and databases separate. `npm run compose:down` preserves its volumes unless `-- --volumes` is intentionally supplied.

## Local gates

- `npm run dev:doctor`: branch, environment, hook, dependency, and Docker-context safety.
- `npm run verify:quick`: doctor, environment parity, Compose parsing, TypeScript builds, and the full non-database test suite.
- `npm run verify:db`: disposable PostgreSQL migration qualification.
- `npm run verify:release`: quick and DB gates plus an isolated built-Compose health smoke; writes a SHA-bound local attestation.

Run `verify:quick` before handoff. Run `verify:db` whenever persistence, migration, startup ordering, backup compatibility, or tenant scoping changes. The integration owner rebases the issue branch on the current `origin/main`, reruns the applicable gates, commits, and runs `verify:release` on a clean SHA.

## Promotion without branch protection

Preview eligibility without changing GitHub:

```bash
npm run release:promote -- --sha=<verified-commit-sha>
```

Actual promotion is an explicit important action:

```bash
npm run release:promote -- --sha=<verified-commit-sha> --push
```

The promotion command requires a recent exact-SHA attestation, unchanged migration hashes, an unchanged `origin/main`, a clean worktree, and a fast-forward relationship. It acquires a local release lock and atomically pushes the SHA to `main` and an immutable `demo-YYYYMMDD-<sha>` tag. It never force-pushes.

The `.githooks/pre-push` hook rejects all other pushes to `main`. Because local hooks can be bypassed, command output and the attestation remain part of the review record.

## Merge conflict policy

Do not resolve migration conflicts by renumbering or editing a migration already applied anywhere. ULIDs avoid filename collisions; explicit `depends-on` metadata expresses ordering. If two parallel migrations touch the same object, add a small reconciliation issue and dependency, then regenerate or supersede only unreleased work.
