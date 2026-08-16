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
| Deployment variables and per-service projections | `scripts/deployment-config.mjs` |
| Canonical local topology | `compose.yaml` |
| Unit and contract tests | `tests/**/*.test.ts` |
| Browser suites | `tests/e2e/` and `playwright.*.config.ts` |
| Database change rules | `packages/workspace-store/AGENTS.md` and `docs/guides/database-migrations.md` |
| Component-specific implementation checklists | `docs/guides/extending.md` |
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
| Flow spanning multiple browser surfaces | `npm run test:e2e` |
| Activity panel | `npm run test:activity:e2e` |
| Customer authentication | `npm run test:customer-auth:e2e` |
| Platform-operator isolation | `npm run test:platform-operator:e2e` |
| Responsive layout | `npm run test:responsive:e2e` |
| Internal service mTLS | `npm run qualify:internal-mtls` |
| Customer-managed or hosted configuration contract | `npm run qualify:deployment-profiles` |
| Remote workspace node or Claude Cowork | `npm run qualify:remote-workspace-node -- config [--cowork]`, then the manual split-node flow when required |
| Provider settings and credential custody | `npm run qualify:providers` |
| OAuth renewal and callback behavior | `npm run qualify:oauth` |
| Microsoft 365 owned tool contracts | `npm run qualify:microsoft365-contracts` |
| MCP destination isolation | `npm run qualify:mcp-egress` |
| Reasoning/model adapter behavior | `npm run qualify:reasoning-adapter` |
| Workspace startup/readiness | `npm run qualify:workspace-startup` |
| Better Auth compatibility | `npm run qualify:better-auth` |
| Governed routing integrations | `npm run qualify:auto-routing` and/or `npm run qualify:governed-routing` |
| Office document regressions | `npm run fixtures:office-regression` and `npm run qualify:office-roundtrip` |

Qualification commands may require Docker, local sockets, external services, or
explicit credentials. Default unit tests must not require real provider keys.
Never treat a sandbox denial of Docker, Chromium, IPC, or local binding as a
product failure until the same command has been run with the required scoped
host capability.

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
Do not choose Compose files manually for ordinary work and do not use
`compose.hosted.yaml` to select a deployment profile.

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

Edit `scripts/deployment-config.mjs`, not `.env.example` or
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
[Component extension contracts](docs/guides/extending.md). That guide describes
which catalogs, policy contracts, transports, and negative tests must move
together; it is not a second repository setup guide.

Treat visual baselines as reviewed product artifacts. Update Playwright
snapshots only after inspecting and accepting the intended visual change.

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
