# ADR 0001: Separate integration from immutable demo releases

- Status: accepted
- Date: 2026-07-29
- Supersedes: the original coupling of `main` integration to demo promotion

## Context

The demo is a separate, persistent development installation. Advancing `main` does not change it. The original workflow coupled every `main` update to full release qualification and a local pre-push hook.

Parallel worktree isolation, explicit database migration checks, and immutable deployments remain useful. Coupling ordinary integration to demo promotion does not.

## Decision

Use `main` as the normal integration branch. Develop each task on its own branch and isolated worktree, run the applicable local gates, then merge and push `main` explicitly.

Do not use a blocking pre-push hook. The integration operator runs and reports `verify:quick`; persistence changes additionally require `verify:db`.

For a full release, start from a clean, pushed commit on `main` or a temporary `release/*` stabilization branch. Run `verify:release`, then use `release:tag` to create and push a new immutable tag. `release:tag` defaults to a
`demo-<date>-<sha>` name; `--tag=` accepts any other immutable name, such as a `v<semver>`
milestone. Tagging never updates a branch. A production deployment consumes the tag and pinned image digests. Routine demo-only changes may instead use the guarded `demo:update` procedure from a clean committed task worktree; it retains the previous application image and does not change schema, dependencies, authentication, or workspace runtime. See [Demo updates](../guides/demo-release.md) for the current commands and gates.

Release branches are optional and temporary. Use one only when demo stabilization and new development must proceed simultaneously. Merge release fixes back into `main`.

## Consequences

Ordinary integration is faster and easier to understand. The running demo remains stable because it changes only after an explicit tag-based deployment. Concurrent feature work keeps its worktree, environment, port, volume, and database isolation.

Without hosted branch protection or a blocking hook, the integration operator is responsible for running the documented checks. Full release qualification remains strict where code, migrations, and a production deployment meet.
