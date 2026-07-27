# Workspace store and migration instructions

These rules apply to `packages/workspace-store`.

- Treat migration SQL already recorded by a released installation as immutable. Never edit, rename, reorder, or reuse its ID.
- Create a migration with `npm run db:migration:new -- <name>`. The generated ULID prevents parallel worktree collisions and declares its dependency explicitly.
- Use additive expand/migrate/contract changes. New readers must tolerate the old shape during rollout; old readers must tolerate the expanded shape until contraction.
- Keep each migration bounded and transactional. Avoid long table rewrites and unindexed backfills in schema transactions; put resumable data backfills behind explicit jobs.
- State lock and runtime risk in the issue. Any column/table drop, type narrowing, new `NOT NULL`, or large index build needs a restore plan and explicit review.
- Update the legacy-baseline verifier only when a released final schema changes. It must prove required objects, rejected obsolete objects, and critical constraints before writing ledger rows.
- Run `npm run verify:db`. Success requires fresh install, second-run no-op, concurrent migrators, verified legacy baseline, incompatible baseline refusal without mutation, and checksum-drift refusal.
- Never use the demo connection string for development or tests. The database gate creates and removes its own disposable PostgreSQL container.
