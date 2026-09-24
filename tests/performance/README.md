# Performance measurements

Run from the repository root; these are opt-in and do not run with `npm test`.

- `npm run benchmark:workspace -- --help`: summarize collected workspace observations.
- `npm run benchmark:kasm-browser -- --help`: collect browser and Docker measurements from an existing workspace.
- `npm run benchmark:tool-audit`: load and query audit data in a **disposable migrated database** selected by `WORKSPACE_SETTINGS_TEST_DATABASE_URL`. Defaults to five million rows and rolls back; `TOOL_AUDIT_VOLUME_COMMIT=1` retains the generated data.

See the [workspace performance reference](../../docs/reference/workspace-performance.md)
for collection inputs and interpretation. Keep generated output out of Git.
