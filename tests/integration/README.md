# Integration tests

Run from the repository root after `npm ci` and `npm run build`.
Select the command in [Contributing](../../CONTRIBUTING.md#select-tests-by-what-changed).
These are opt-in; `npm test` does not start them.

- **gateway, database, storage:** use Docker and pinned images. Runners own disposable containers. MCP egress also requires an initialized worktree `.env`.
- **microsoft365:** install the pinned tool package with `npm ci --prefix integrations/ms365-mcp`. Uses synthetic schema fixtures; no Microsoft account needed.
- **agents:** install the pinned Codex or Hermes Python environment and runtime. Read the runner's arguments before invoking it; model responses are local fixtures.
- **workspace:** needs a disposable configured stack and built workspace image. Creates and cleans up real test records and runtimes. The release runner executes it inside Control.
- **consent:** needs a separately configured test consent service, `OPENVTC_CONSENT_URL`, and `OPENVTC_CONSENT_TOKEN`. Exercises JavaScript-to-Rust signatures and enrollments with `npm run test:integration:consent`.
- **office:** needs LibreOffice and Python. Run `npm run test:integration:office -- --corpus tests/fixtures/office-regression --output /tmp/office-roundtrip`.

Passing these checks does not prove that a production deployment is ready.
