# Engineering commands and verification

This file is the command, tool, and test-suite index for humans and coding
agents changing LemmaComputer. It does not define another setup workflow. First
choose and initialize the correct environment using
[Evaluation, development, and remote workspace workflow](docs/guides/development-workflow.md).

## Sources of truth

| Need | Source |
| --- | --- |
| Evaluation, worktree development, remote-node/Cowork setup, and command meanings | `docs/guides/development-workflow.md` |
| Runnable repository commands | `package.json` scripts |
| Script implementation folders | [Script layout](scripts/README.md) |
| Deployment variables and per-service projections | `scripts/setup/deployment-config.mjs` |
| Canonical local topology | `compose.yaml` |
| Unit and contract tests | `tests/**/*.test.ts` |
| Browser suites | `tests/ui/` (tests, fixtures, configs, and reviewed snapshots) |
| Database change rules | `packages/workspace-store/AGENTS.md` and `docs/guides/database-migrations.md` |
| Component-specific implementation checklists | `docs/reference/extension-contracts.md` |
| Repository-wide agent safety contract | `AGENTS.md` plus any more-specific `AGENTS.md` |

Use `rg` or `rg --files` to find code and tests. Use repository-owned npm
scripts instead of inventing Compose invocations, environment generators,
migration numbers, or release commands.

## Baseline development commands

| Command | What it proves or starts |
| --- | --- |
| `npm run dev:doctor` | Current worktree, dependencies, environment ownership, Docker context, and mounted-file safety |
| `npm run env:check` | Canonical environment parity and strict selected-profile validation |
| `npm run compose:config` | Least-privilege service projections and valid resolved Compose configuration |
| `npm run build` | TypeScript/package builds across npm workspaces |
| `npm test` | Full non-database Node unit and contract suite |
| `npm run verify:quick` | Doctor, environment check, Compose validation, build, and full non-database tests |
| `npm run verify:db` | Disposable PostgreSQL product/auth migrations, compatibility, concurrency, backup/restore, and PostgreSQL feature tests |
| `npm run demo:update -- plan/apply/rollback/status --host=user@host` | Routine development-demo updates; exact source, quick/browser gates, environment continuity and application rollback; see [runbook](docs/guides/demo-release.md) |
| `npm run verify:release` | Full clean-SHA release qualification, including provider/OAuth gates, quick/DB gates, workspace image, isolated Compose health, and workspace readiness |

Run a focused Node test while iterating:

```bash
node --import tsx --test tests/<area>.test.ts
```

The final handoff still requires the applicable repository gate; a focused test
does not replace `verify:quick`.

## Select tests by what changed

Every code or contract change runs `npm run verify:quick`. Add the smallest
applicable suites below:

| Change | Required or relevant commands |
| --- | --- |
| Persistence, migrations, startup ordering, backup compatibility, or tenant scoping | `npm run verify:db` |
| Any user-visible Web behavior | Smallest relevant Playwright spec plus `verify:quick` |
| Flow spanning multiple browser surfaces | `npm run test:ui` |
| Activity panel | `npm run test:ui:activity` |
| Customer sign-in and invitations | `npm run test:ui -- customer-authentication.spec.ts customer-invitation.spec.ts` |
| Customer passkey registration and sign-in | `npm run test:ui:auth` |
| Platform operator UI | `npm run test:ui:operator` |
| Responsive layout | `npm run test:ui:responsive` |
| Internal service mTLS | `npm run test:mtls` |
| Customer-managed or hosted configuration contract | `npm run test:profiles` |
| Remote workspace node or Claude Cowork | `npm run dev:remote-workspace -- config [--cowork]`, then the manual split-node flow when required |
| Provider settings and credential custody | `npm run test:integration:providers` (includes pinned Azure/Vertex wire-format checks with mocked HTTP and cloud credential encryption checks) |
| OAuth renewal and callback behavior | `npm run test:integration:oauth` |
| Microsoft 365 owned tool contracts | `npm run test:integration:microsoft365-contracts` |
| MCP destination isolation | `npm run test:integration:mcp-egress` |
| Codex CLI/SDK transport compatibility (activate the pinned agent-chat Python environment; pass `-- --binary /path/to/codex`) | `npm run test:integration:codex-runtime` |
| Installed Hermes gateway and MCP 2 transport (activate the candidate Hermes Python environment) | `npm run test:integration:hermes-runtime` |
| Validate supplied reasoning/model promotion evidence | `npm run release:check-reasoning` |
| Workspace startup/readiness | `npm run test:integration:workspace-startup` |
| Better Auth compatibility | `npm run test:integration:auth` |
| Artifact filesystem/S3 lifecycle | `npm run test:integration:artifact-store` |
| JavaScript-to-Rust consent interoperability | `npm run test:integration:consent` |
| MCP audit hook compatibility | `npm run test:integration:mcp-audit-hooks` |
| Audit query performance on a disposable database | `npm run benchmark:tool-audit` |
| Governed routing integrations | `npm run test:integration:governed-routing` |
| Office document regressions | `npm run fixtures:office-regression` and `npm run test:integration:office` |

Integration commands may require Docker, local sockets, external services, or
explicit credentials. Default unit tests must not require real provider keys.
Never treat a sandbox denial of Docker, Chromium, IPC, or local binding as a
product failure until the same command has been run with the required scoped
host capability.

## UI browser tests

`tests/ui/` contains Playwright tests, configs, fixture servers, and reviewed
screenshot baselines. No running Docker stack or account is needed: the main
suite starts the real Web frontend and a backend with example data. The passkey
suite starts its own authentication fixture; the operator suite renders HTML
directly. These checks cover browser behavior, not deployed infrastructure.

Run `npm run test:ui` for the main suite and `npm run test:ui:auth` for passkeys.
The Activity, responsive, and operator commands select tests already covered by
the main suite; they are shortcuts, not additional coverage. For one file, use
`npm run test:ui -- model-routing.spec.ts`.

Generated HTML reports live in `tests/ui/reports/<suite>/`; traces and screenshots
live in `tests/ui/results/<suite>/`. Both are ignored by Git. Open the main report
with `npx playwright show-report tests/ui/reports/web`. Keep reviewed `*-snapshots/`
baselines tracked. Use a separate walkthrough of a running stack to validate
real sign-in, persistence, workspaces, and external integrations.

## Local processes and runtime tools

| Command | Use |
| --- | --- |
| `npm run dev:web` | Run the Web package development process |
| `npm run dev:control` | Run Control API development process |
| `npm run dev:controller` | Run workspace-controller development process |
| `npm run dev:ui-fixture` | Serve UI fixtures used by focused browser work |
| `npm run image:workspace` | Build the managed desktop image |
| `npm run benchmark:workspace` | Collect workspace lifecycle measurements |
| `npm run benchmark:kasm-browser` | Collect Kasm browser runtime measurements |

The complete product uses repository-managed `npm run compose:*` commands.
These use the root `compose.yaml`; no overlay selection is needed. The
[Docker file map](docker/README.md) explains the image recipes and test stacks.

## Database and generated-contract tools

Generate a migration; never hand-allocate its identifier:

```bash
npm run db:migration:new -- <short-name>
```

Application startup checks schema compatibility but does not migrate. The
explicit migration jobs own schema changes. Applied migrations are immutable,
forward-only, checksummed, dependency ordered, transactional, and advisory-lock
serialized.

Generated deployment references are checked with:

```bash
npm run env:example
npm run env:qualification:example
```

Edit `scripts/setup/deployment-config.mjs`, not `.env.example` or
`.env.qualification.example`, then use the script's explicit `--write` mode
when the generated files intentionally change.

## Test design and security boundaries

For security-boundary changes, cover the applicable negative paths:

- missing authentication;
- cross-tenant or cross-workspace access;
- altered or expired signed data;
- replay;
- malformed schemas;
- dependency outage and closed failure;
- secret-safe logs and public errors.

Keep HTTP handlers thin, derive identity from authenticated server state, and
put stable wire identifiers in `packages/contracts`. For provider, connector,
application, agent, sandbox-adapter, egress, channel, or OpenVTC additions, use
the concrete subsystem checklist in
[Component extension contracts](docs/reference/extension-contracts.md). That guide describes
which catalogs, policy contracts, transports, and negative tests must move
together; it is not a second repository setup guide.

Prefer tests of observable behavior over assertions about source text, exact
CSS declarations, or retired labels. Use failure screenshots and traces
automatically captured by Playwright; avoid screenshots on successful runs
unless they are compared with a reviewed baseline. Keep representative desktop/mobile visual
baselines and test responsive behavior at intermediate widths. Update snapshots
only after inspecting and accepting the intended visual change.

## Handoff and pull-request evidence

Report:

- the user or operator problem;
- services and trust boundaries affected;
- new credentials, routes, scopes, or persisted data;
- migration and deployment-profile impact;
- commands run and their actual outcomes;
- untested behavior or follow-up work; and
- the exact commit SHA eligible for integration.

Keep generated credentials, provider keys, OAuth tokens, database dumps, logs,
and workspace home data out of commits. Do not claim completion with a dirty
worktree, skipped required database tests, or a known baseline failure.

For suspected vulnerabilities, do not open a public issue; follow
[the security policy](docs/SECURITY.md).
