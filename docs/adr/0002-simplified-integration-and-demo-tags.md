# ADR 0002: Separate integration from immutable demo releases

- Status: accepted
- Date: 2026-07-29
- Supersedes: [ADR 0001](0001-local-release-gates.md) for main-branch promotion and pre-push enforcement

## Context

The demo now runs as a separate hosted deployment pinned to an immutable Git tag and image digest. Advancing `main` therefore cannot change the running demo. The previous workflow treated `main` as both the integration target and the demo candidate, coupling every main update to full release qualification and an opaque local pre-push hook.

Parallel worktree isolation, explicit database migration checks, and immutable deployments remain useful. Coupling ordinary integration to demo promotion does not.

## Decision

Use `main` as the normal integration branch. Develop each task on its own branch and isolated worktree, run the applicable local gates, then merge and push `main` explicitly.

Do not use a blocking pre-push hook. The integration operator runs and reports `verify:quick`; persistence changes additionally require `verify:db`.

Create demo releases from a clean, pushed commit on `main` or a temporary `release/*` stabilization branch. Run `verify:release`, then use `release:tag` to create and push a new immutable tag. `release:tag` defaults to a
`demo-<date>-<sha>` name; `--tag=` accepts any other immutable name, such as a `v<semver>`
milestone. Tagging never updates a branch. The deployment consumes the tag and pinned image digests.

Release branches are optional and temporary. Use one only when demo stabilization and new development must proceed simultaneously. Merge release fixes back into `main`.

## Consequences

Ordinary integration is faster and easier to understand. The running demo remains stable because it changes only after an explicit tag-based deployment. Concurrent feature work keeps its worktree, environment, port, volume, and database isolation.

Without hosted branch protection or a blocking hook, the integration operator is responsible for running the documented checks. Release qualification remains strict because it is the point where code, migrations, and the hosted demo meet.
