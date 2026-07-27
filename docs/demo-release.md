# Demo release runbook

The demo is a protected operational profile even without GitHub branch protection. Its database, Docker context, `.env`, volumes, and running containers are never used by a development worktree.

## Topology

- Reserve Docker context `onecomputer-demo` for the demo host/stack.
- Keep its secrets outside the repository and never copy them into a worktree.
- Deploy an immutable `demo-*` Git tag and image digest. Do not run the demo from a dirty checkout, issue branch, or moving `main` filesystem.
- Back up the Control PostgreSQL database, LiteLLM database, workspace volumes, secret versions, and image digests as one restore set.

## Candidate qualification

On a clean candidate commit:

```bash
npm run verify:release
npm run release:promote -- --sha=<candidate-sha>
npm run release:promote -- --sha=<candidate-sha> --push
```

The first command performs the local equivalent of required CI and records `.artifacts/release-verification/<sha>.json`. The preview command proves eligibility without external changes. The final command is the explicit promotion action and atomically advances `main` plus an immutable demo tag.

## Database promotion

1. Confirm the candidate migration manifest and review every new migration for locks, runtime, tenant scope, and rollback compatibility.
2. Capture and restore-test a coordinated backup before any destructive or data-rewriting migration.
3. Run the one-shot migration job once. Do not start new application containers until it succeeds.
4. Confirm the ledger count/checksums and application schema compatibility.
5. Start containers pinned to the promoted tag/digests and run health plus the demo-critical sign-in, workspace, chat, approval, and connector smoke tests.

Application startup never performs a migration. If the migration job fails, retain the previous application deployment, inspect the transaction error, and restore only if an external/nontransactional operation changed state.

## Rollback

Application rollback is permitted only while the previous version is compatible with the expanded schema. Roll back images by immutable digest/tag; do not reverse migration files. After a contract migration crosses the documented irreversible point, recovery is restore plus forward repair, not an ad-hoc down migration.
