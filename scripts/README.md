# Script index

Run `npm run …` from the repository root. **For first setup, follow the
[setup guide](../docs/guides/development-workflow.md)**; this page explains the
files, not a sequence of steps to run. Entries marked **Helper** are called by
other tools and have no standalone command.

## Setup: environment configuration

| Script | What it does | Command / caller |
| --- | --- | --- |
| [initialize-env.mjs](setup/initialize-env.mjs) | Creates one compact `.env` with installation settings, fresh local secrets, and blank optional external-integration fields. Run once per installation. | `npm run env:init` |
| [update-env.mjs](setup/update-env.mjs) | Checks or compacts `.env`, retaining blank integration fields and preserving configured values, secrets, and resource identity. | `npm run env:check` / `npm run env:update` |
| [render-service-env.mjs](setup/render-service-env.mjs) | Validates `.env` and writes each service's configuration files. Also called by Compose commands. | `npm run env:render` |
| [render-env-example.mjs](setup/render-env-example.mjs) | Checks the generated `.env.example` reference; append `-- --write` to regenerate it. | `npm run env:example` |
| [deployment-config.mjs](setup/deployment-config.mjs) | Defines supported settings, defaults, profile validation, and which values each service receives. | **Helper:** configuration source of truth for setup tools. |
| [environment-files.mjs](setup/environment-files.mjs) | Parses and reads a single `.env` with defaults; compacts it while preserving secrets and explicit overrides. | **Helper:** setup and operator commands. |
| [environment-template.mjs](setup/environment-template.mjs) | Parses and merges environment files and generates initial secrets. | **Helper:** initialization and update tools. |

GitHub and Google Workspace MCP credentials are configured through the product
UI. Their optional deployment-wide `.env` fallbacks are omitted when empty;
`env:update` preserves existing nonempty overrides.

## Development: worktrees and local services

| Script | What it does | Command / caller |
| --- | --- | --- |
| [worktree-init.mjs](development/worktree-init.mjs) | Prepares dependencies, one `.env`, unique ports, and a persistent installation ID for derived Docker names and image tags. | `npm run worktree:init` |
| [dev-doctor.mjs](development/dev-doctor.mjs) | Checks branch, environment, and local resource isolation without changing the stack. | `npm run dev:doctor` |
| [verify-quick.mjs](development/verify-quick.mjs) | Runs local safety/configuration checks, builds, and the default tests before integration. | `npm run verify:quick` |
| [compose-down.mjs](development/compose-down.mjs) | Stops the worktree's stack after checking for active workspace runtimes. Preserves volumes by default. | `npm run compose:down` |
| [remote-workspace-node.mjs](development/remote-workspace-node.mjs) | Configures and manages a separate local workspace node for mTLS and Cowork development. | `npm run dev:remote-workspace -- config\|up\|status\|down`; see the [workflow](../docs/guides/development-workflow.md#remote-workspace-node-and-cowork-qualification). |
| [install-electron-apparmor.mjs](development/install-electron-apparmor.mjs) | Checks the Electron AppArmor profile; its `install` mode installs and loads it on the host with root privileges. | `npm run apparmor:electron:check`; installation is covered in the [operations guide](../docs/guides/operations.md). |
| [worktree-names.mjs](development/worktree-names.mjs) | Derives worktree-specific Docker resource names. | **Helper:** worktree initialization. |
| [dev-doctor-lib.mjs](development/dev-doctor-lib.mjs) | Checks that required bind-mounted configuration files exist and are readable. | **Helper:** development doctor. |
| [remote-workspace-node-tls-forwarder.mjs](development/remote-workspace-node-tls-forwarder.mjs) | Authenticates mTLS connections and forwards remote-node traffic to local services. | **Helper:** started by the generated remote workspace Compose configuration. |

## Database: explicit maintenance

See [database migrations](../docs/guides/database-migrations.md) before using these.

| Script | What it does | Command / caller |
| --- | --- | --- |
| [migration-new.mjs](database/migration-new.mjs) | Allocates the next migration and creates its starter SQL file. | `npm run db:migration:new -- <name>` |
| [backfill-organization-rbac.ts](database/backfill-organization-rbac.ts) | Backfills organization authorization records for an existing installation using `DATABASE_URL`. Writes to that database. | `npm run db:backfill:organization-rbac` |

## Release: demo updates and promotion

Follow [demo updates](../docs/guides/demo-release.md) for the running demo.

| Script | What it does | Command / caller |
| --- | --- | --- |
| [demo-update.mjs](release/demo-update.mjs) | Packages a committed candidate, runs required checks, and invokes the demo host over SSH for planning, updates, status, or rollback. | `npm run demo:update -- <operation>`; use the demo guide for arguments. |
| [demo-update-host.py](release/demo-update-host.py) | Performs guarded update and rollback operations on the demo host while preserving its environment and data. | **Helper:** invoked remotely by `demo-update.mjs`. |
| [verify-release.mjs](release/verify-release.mjs) | Runs the full release gate, including integration tests, image builds, and workspace readiness; writes an attestation for the commit. | `npm run verify:release` |
| [release-tag.mjs](release/release-tag.mjs) | Checks release evidence and creates an immutable release tag; `--push` publishes it. | `npm run release:tag -- --push` |
| [validate-reasoning-evidence.mts](release/validate-reasoning-evidence.mts) | Validates supplied reasoning-adapter evidence against the runtime catalog and commit. Does not run model experiments. | `npm run release:check-reasoning -- --evidence=<file>` |
| [release-gates.mjs](release/release-gates.mjs) | Defines the required release checks and attestation schema version. | **Helper:** release verification and tagging. |

[`release/demo-target.json`](release/demo-target.json) records the fixed identity of the managed demo installation. Update it only as part of a planned state handover.

## Where did the test scripts go?

- [Integration tests](../tests/integration/README.md): repeatable service/runtime checks and their prerequisites; includes `npm run verify:db`.
- [Performance tools](../tests/performance/README.md): workspace/browser measurements and the audit-volume benchmark.
- [Contributing](../CONTRIBUTING.md#select-tests-by-what-changed): choose which checks your change needs.
