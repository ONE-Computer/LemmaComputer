# Local development workflow

**Who this is for:** a person or coding agent who will *change* the product.
Follow it in order, and do not create an alternative Compose or `.env` workflow
for development work.

To only run and evaluate LemmaComputer, you do not need any of this. Use the
Quick start in the [README](../../README.md), which creates a single evaluation
checkout with `npm run env:init -- --profile=worktree` and no git worktree.

## Local-development contract

| Question | Required answer |
| --- | --- |
| Does local development create a stack from `main`? | **No.** Keep the primary `main` checkout clean. It is only the integration checkout. |
| Where does the local stack run? | In the current task's branch and worktree. Each worktree owns its own `.env`, ports, containers, networks, images, volumes, and databases. |
| Which deployment mode is used? | `LEMMACOMPUTER_INSTALLATION_KIND=worktree`, set automatically by `npm run worktree:init`. Do not change it manually. |
| Is local testing multi-tenant? | Yes. The `worktree` profile permits multiple organizations and uses the same organization-scoped product schema and authorization boundaries in an isolated development database. |
| Should local multi-tenant testing use `hosted`? | **No.** `hosted` is a production profile requiring HTTPS, mTLS, a separate platform-operator realm, and a remote-isolated workspace provider. |
| Which Web port should the agent open? | Read `LEMMACOMPUTER_PUBLIC_WEB_URL` from the generated `.env`. A task worktree gets a deterministic unique host port; do not assume `4174` or `4147`. |
| Which Compose file is used? | The root `compose.yaml`, only through the repository's `npm run compose:*` commands. |
| Does the agent invent or copy an `.env`? | **No.** `npm run worktree:init` generates it. The human supplies only external credentials required by the task. |

`worktree` is development-only. It is suitable for testing multiple
organizations and tenant isolation, but it is not evidence that the hosted
production infrastructure has been qualified.

## Host requirement

Node.js development and non-containerized tests can be performed on macOS, but
the complete reference deployment currently requires a Linux `amd64`/`x86_64`
Docker host. The managed desktop image contains Linux x86_64 applications, and
the local workspace controller relies on Linux Docker-socket and device
semantics.

On an Intel or Apple Silicon Mac, use the Mac as the editor/client and use a
Linux x86_64 development host or VM for the full stack and workspace-runtime
checks. Docker Desktop emulation is not a qualified deployment path. Do not add
`platform: linux/amd64` overrides or weaken runtime checks merely to make the
stack start on macOS.

## Exact setup commands

Install Git, Node.js 22 or later, and npm. Install Docker only when the task
needs Compose, database qualification, or the full local stack. A full
deployment also needs Docker Compose v2.30.0 or later on Linux x86_64.

The agent runs these commands from a fresh machine. Substitute the actual
repository URL and task name:

```bash
git clone <repository-url> onecomputer
cd onecomputer
git fetch origin
mkdir -p ../onecomputer-worktrees
git worktree add ../onecomputer-worktrees/<task-name> \
  -b codex/<task-name> origin/main
cd ../onecomputer-worktrees/<task-name>
npm run worktree:init
npm run dev:doctor
```

When an issue exists, prefer `codex/<issue>-<short-name>` for the branch.
`worktree:init` refuses `main` and performs all first-pass machine setup for
that worktree:

- runs `npm ci` when dependencies are absent;
- creates `.env` with fresh internal secrets;
- sets `LEMMACOMPUTER_INSTALLATION_KIND=worktree` and
  `LEMMACOMPUTER_RUNTIME_ENVIRONMENT=development`;
- assigns a unique host Web port, Compose/container/network names, image tags,
  volumes, and databases; and
- prints the worktree's Web URL.

The Web container listens on port `4174`, but Compose maps it to the unique host
port recorded as `LEMMACOMPUTER_WEB_PORT`. The dedicated evaluation-checkout
default is also host port `4174`; `4147` is not a project default. A task
worktree normally uses a different port so that multiple worktrees can run at
the same time.

Inside a task worktree, do not run `npm run env:init` separately, copy the
primary checkout's `.env`, or start Docker Compose from `main`. `worktree:init`
owns that worktree's environment.

If dependency installation fails because an agent sandbox cannot write the npm
cache or create local IPC endpoints, rerun the same bootstrap with the minimum
host permission required. Do not treat a sandbox error as an application or
test failure.

### Human-input checkpoint

At this point the generated `.env` is sufficient for builds, automated tests,
Compose validation, stack health, and multi-tenant tests that use fixtures. The
agent does not need a human to fill arbitrary variables.

If the task requires a real interactive sign-in or external integration, the
agent must stop and request only the applicable values listed in
[Human-supplied values](#human-supplied-values). It must not request or print
the generated internal secrets.

### Start the complete worktree stack

After any task-specific human values are present, run:

```bash
npm run env:check
npm run compose:config
npm run image:workspace
npm run compose:up
docker compose ps
```

`image:workspace` is required before launching a managed desktop workspace and
can take substantial time and disk space. `compose:up` renders the per-service
environment, builds application services, applies the explicit migration jobs,
and waits for service health.

Show the exact host port and browser URL assigned to this worktree:

```bash
rg -n '^LEMMACOMPUTER_(WEB_PORT|PUBLIC_WEB_URL)=' .env
```

Check the Web health endpoint without printing secrets:

```bash
LEMMACOMPUTER_LOCAL_WEB_URL="$(sed -n 's/^LEMMACOMPUTER_PUBLIC_WEB_URL=//p' .env)"
curl -fsS "${LEMMACOMPUTER_LOCAL_WEB_URL}/__lemmacomputer/healthz"
```

The expected response is `{"status":"ok"}`. Open the URL printed by
`worktree:init`; it is intentionally not the primary checkout's default port.

Before handing off a change, run:

```bash
npm run verify:quick
```

Run `npm run verify:db` as well when persistence, migrations, startup ordering,
backup compatibility, or tenant scoping changes.

## Local configuration map

The multiple Compose and environment files have separate, deliberate roles:

| Path | Role | Normal developer action |
| --- | --- | --- |
| `compose.yaml` | Canonical single-host development and evaluation topology | Use through `npm run compose:*` |
| `compose.hosted.yaml` | Empty compatibility marker for older hosted commands; it does not select the hosted profile | Do not select it for local development |
| `compose.oauth-qualification.yaml` | Isolated OAuth compatibility test stack | Used by qualification tooling only |
| `compose.provider-qualification.yaml` | Isolated provider-management test stack | Used by qualification tooling only |
| `.env` | Ignored, secret, machine-and-worktree-specific deployment values | Generate; never copy or commit |
| `.env.example` | Generated reference for the canonical deployment contract | Never hand-edit |
| `.env.qualification.example` | Generated reference for isolated test stacks | Never use as the local deployment environment |
| `.runtime-env/` | Ignored, generated least-privilege per-service projections | Let `npm run compose:*` regenerate it |

`scripts/deployment-config.mjs` is the source of truth for operator settings and
the generated environment examples. In an initialized worktree, use
`npm run env:check` to detect drift and `npm run env:update` to merge new
variables without rotating existing secrets. The managed Compose commands
render `.runtime-env/` automatically.

### How the first `.env` is created

The normal developer path is `npm run worktree:init`. If `.env` is absent, it
creates one from the canonical contract, generates fresh cryptographic and
service secrets, and then replaces topology values with worktree-specific
names and ports. Do not run `env:init` before or after it, and do not copy
`.env.example` to `.env`: the example contains markers that must be replaced by
the initializer.

`npm run env:init` is the direct first-pass command for a dedicated local
evaluation checkout that is not a development worktree:

```bash
npm ci
npm run env:init -- --profile=worktree
```

`--profile` accepts `customer-managed`, `hosted`, or `worktree`, and writes that
value as `LEMMACOMPUTER_INSTALLATION_KIND`. Omitting it keeps the canonical
`customer-managed` default, whose strict preflight requires real Microsoft Entra
values before `compose:up` will render. Use `worktree` for an evaluation
checkout that should start without a Microsoft tenant.

Both paths write `.env` with mode `0600`. They refuse to overwrite an existing
file. Do not use `--force` unless invalidating the checkout's existing
sessions, encrypted records, signatures, and service trust is intentional.

### What is populated automatically

| Value class | Examples | Agent action |
| --- | --- | --- |
| Generated internal secrets | Database passwords, Better Auth secret, session and service tokens, signing/encryption keys, VAPID keys | Generated automatically; keep stable and never copy between worktrees |
| Worktree isolation | Compose project, ports, container/network names, image tags, database/volume names | Assigned automatically by `worktree:init` |
| Safe local defaults | Loopback bind address, capture email transport, copy-link invitations, local sandbox driver | Keep unless the task explicitly exercises another mode |
| Model-provider credentials | OpenAI, Anthropic, GLM/Z.ai, or Bedrock credentials | Add after startup in **AI control plane -> Models & providers**; never put them in `.env` |

Do not edit generated values merely to make them easier to share. They are
part of the worktree's persisted trust and encryption state.

### Human-supplied values

There is no universal set of human-supplied values for local development. The
required values depend on the external flow being tested:

| Test goal | Human supplies | Notes |
| --- | --- | --- |
| Build, unit tests, Compose validation, stack health, fixture-based multi-tenant tests | Nothing | Use the generated `worktree` environment as-is |
| Manual email/password signup and verification | Set `LEMMACOMPUTER_AUTH_EMAIL_TRANSPORT=postmark`, plus `LEMMACOMPUTER_POSTMARK_SERVER_TOKEN` and `LEMMACOMPUTER_POSTMARK_FROM` | The default `capture` adapter is for automated tests; it does not send human-readable email outside the process. Local invitations may keep `LEMMACOMPUTER_INVITATION_DELIVERY_MODE=copy-link`. |
| Transitional workforce Entra sign-in, or Microsoft 365 using the same app | The four `LEMMACOMPUTER_ENTRA_*` and bootstrap values below | Follow the exact app registration, callback, and Graph-scope instructions in the [local integration runbook](local-deployment.md#configure-the-transitional-workforce-entra-and-microsoft-365-app) |
| Separate Microsoft 365 connector app | `LEMMACOMPUTER_MS365_TENANT_ID`, `LEMMACOMPUTER_MS365_CLIENT_ID`, and `LEMMACOMPUTER_MS365_CLIENT_SECRET` | Supply all three or leave all three empty to reuse the Entra app |
| Google or Microsoft social login | The selected provider's client-ID and client-secret pair | Supply the complete pair only |
| Remote Kasm | The complete `LEMMACOMPUTER_KASM_*` group | Ordinary local development keeps the generated `kasm-local` driver |

The four values for the transitional Entra path are:

```text
LEMMACOMPUTER_ENTRA_TENANT_ID
LEMMACOMPUTER_ENTRA_CLIENT_ID
LEMMACOMPUTER_ENTRA_CLIENT_SECRET
LEMMACOMPUTER_BOOTSTRAP_OWNER_OBJECT_IDS
```

These are not mandatory for ordinary `worktree` development. Unresolved Entra
placeholders are expected when the task does not exercise Entra or Microsoft
365. To list only unresolved initializer markers without printing generated
secrets:

```bash
rg -n '=replace-with-' .env
```

Then validate the file and Compose projection:

```bash
npm run env:check
npm run compose:config
```

`env:check` verifies the environment contract, coupled groups, and selected
deployment-profile rules. The `worktree` profile intentionally permits Entra
placeholders for tasks that do not need live authentication, so a passing
check alone does not prove full sign-in, provider, connector, or workspace
readiness.

## Scheduling work

The user's request is the task contract. When a GitHub issue exists, its definition of success and native `blocked by` relationships add to that contract. A task with a known unresolved blocker is not runnable; otherwise it may start whenever worktree capacity is available. No artificial wave boundary is required.

One agent owns one task, one branch, and one worktree. Avoid broad shared foundation branches. When two tasks require the same contract, land the contract first and let both consumers update from `main`.

## Additional worktree

From a clean primary checkout:

```bash
git fetch origin
git worktree add <path> -b codex/<issue>-<short-name> origin/main
cd <path>
npm run worktree:init
npm run dev:doctor
```

`worktree:init` refuses `main`, creates fresh local secrets, assigns unique Compose/container/network/image names and ports, and installs or safely reuses dependencies. Request only the external authentication or integration values needed by the task. Model-provider credentials are configured in the product UI, not `.env`. Never copy the demo `.env`.

Use normal Compose commands inside the worktree. Its generated `.env` keeps volumes and databases separate. `npm run compose:down` preserves its volumes unless `-- --volumes` is intentionally supplied.

At the start of each later session, enter the task worktree and run:

```bash
git status --short
npm run dev:doctor
```

After updating the branch from `main`, run `npm run env:check`. If the canonical
environment gained variables, run `npm run env:update`, review the variable
names that it reports, and run `npm run dev:doctor` again. These commands do not
print secret values.

## Local gates

- `npm run dev:doctor`: environment, dependency, and Docker-context safety.
- `npm run verify:quick`: doctor, environment parity, Compose parsing, TypeScript builds, and the full non-database test suite.
- `npm run verify:db`: disposable PostgreSQL migration qualification.
- `npm run verify:release`: provider and OAuth qualification, quick and DB
  gates, workspace-image build, isolated Compose health, and a real Hermes
  workspace readiness smoke; writes a SHA-bound local attestation.

Run `verify:quick` before handoff or integration. Run `verify:db` whenever persistence, migration, startup ordering, backup compatibility, or tenant scoping changes. Update the task branch from current `main` when needed, resolve conflicts there, and rerun the applicable gates before merging.

## Integration

The integration owner reviews the task scope and reported checks, then merges the feature branch into `main`. `main` should remain buildable, but it is not the deployed demo and ordinary integration does not require the full release gate.

```bash
git switch main
git pull --ff-only
git merge --no-ff <feature-branch>
git push origin main
```

There is no blocking pre-push hook. This keeps the workflow visible: the operator runs the required checks and reports their result instead of relying on hidden local enforcement.

## Demo release

Usually, release directly from a clean, already-pushed `main`:

```bash
git switch main
git pull --ff-only
npm run verify:release
npm run release:tag -- --push
```

`release:tag` requires the current clean commit to match its pushed branch and a recent exact-SHA release attestation. It creates and optionally pushes `demo-YYYYMMDD-<sha>` without moving `main`.

Use a temporary `release/<name>` branch only when the demo needs a stabilization line while unrelated development continues on `main`. Run the same release commands on that branch, and merge every release fix back into `main`.

Deploy the immutable tag, not `main` or `release/*`. Each release gets a new tag; never delete, move, or reuse an existing demo tag.

## Merge conflict policy

Do not resolve migration conflicts by renumbering or editing a migration already applied anywhere. ULIDs avoid filename collisions; explicit `depends-on` metadata expresses ordering. If two parallel migrations touch the same object, add a small reconciliation issue and dependency, then regenerate or supersede only unreleased work.
