# Evaluation, development, and remote workspace workflow

**First time here? Follow “Evaluate a single checkout” below.** It takes you
from a clone to sign-in and a working desktop on your own machine. You need
no AWS account, model-provider key, Microsoft app registration, or existing
admin account for this first run.

If you intend to edit code, use [the task worktree setup](#develop-in-an-isolated-task-worktree)
instead. This page owns local setup; [AWS go-live](aws-go-live.md) covers the
separate production deployment work.

## Host requirements

Use Linux x86_64 (or a Linux x86_64 VM), Git, Node.js 22+, Docker Engine,
and Docker Compose v2.30.0+. Verify that your current user can reach Docker:

```bash
node --version
npm --version
docker version
docker compose version
```

Image builds need internet access, disk space, and available Docker network
address space. The desktop image downloads the bundled applications, so its
first build can take substantially longer than starting the web interface.
Node.js tests can run on macOS; the full desktop workflow below requires Linux.

## Evaluate a single checkout

### 1. Clone and start the application

Use a dedicated evaluation clone. Keep it for this evaluation; use a separate
task worktree if you later want to change code. Run only one evaluation clone
per Docker host because this setup uses the default names and ports.

```bash
git clone https://github.com/ONE-Computer/LemmaComputer.git lemmacomputer-eval
cd lemmacomputer-eval
npm ci
npm run env:init -- --profile=worktree
npm run env:check
npm run compose:up
```

`env:init` generates `.env` with fresh local secrets; run it **once**.
`worktree` here names the development configuration, even though this is a
standalone evaluation clone. Do not copy or fill out `.env.example` manually.

`compose:up` selects the root `compose.yaml`, builds the application services,
runs database migrations, and waits for service health. You do not select a
Dockerfile or a second Compose file. See [Docker files](../../docker/README.md)
only if you want to understand the images.

### 2. Open the product and create your account

Find this installation's browser URL:

```bash
grep '^LEMMACOMPUTER_PUBLIC_WEB_URL=' .env
```

Open the printed URL, choose **Create account**, and enter your name, email,
and password. Choose **Open local verification email** to complete verification
through the browser. The development configuration captures email locally;
you do not need an email delivery service. Sign in if prompted.

At this point the web application is running. A desktop still needs the
separate image built in the next step. AI features need provider configuration
and may correctly show as unavailable.

### 3. Build and open your first desktop

In the same checkout:

```bash
npm run image:workspace
```

When the build succeeds, go to **Workspace → Create workspace** in the product.
Leave optional applications and AI agents unselected for the first run, keep
the default permitted workspace access, and create it. Wait for it to become
ready, then open the desktop. This checks the base workspace without provider
keys or extra host configuration.

For AI later, configure a provider, pricing, and class mappings under
**AI control plane → Models & routing**, then the applicable Team budget and
routing policy. See [model routing](../product/model-routing.md). Chrome,
Visual Studio Code, and Obsidian need the [Electron AppArmor setup](operations.md#workspace-node-runtime)
on an enforcing host. Cowork needs the [remote-node procedure](#remote-workspace-node-and-cowork-qualification)
and usable `/dev/kvm` and `/dev/vhost-vsock`.

### 4. Stop and resume this evaluation

Stop active workspaces through the product, then stop the application:

```bash
npm run compose:down
```

To resume later, return to this **same clone** and run:

```bash
npm run env:check
npm run compose:up
```

Keep `.env` and the Docker volumes: they hold the secrets and data needed to
resume. Do not rerun `env:init`, add `-- --volumes`, or create a new clone to
resume an existing installation. If startup fails, use
[health and diagnostics](operations.md#health-and-diagnostics).

## Other workflows

| Goal | Next step |
| --- | --- |
| Read code or run unit tests | No stack needed; see [Contributing](../../CONTRIBUTING.md). |
| Change code or documentation | Use the task worktree procedure below. |
| Test remote-node routing or Cowork | Initialize a task worktree, then use the remote qualifier below. |
| Test Microsoft integration | Follow the [Microsoft runbook](local-deployment.md). |
| Deploy hosted production | Follow [AWS go-live](aws-go-live.md); local Compose is insufficient. |

The primary `main` checkout is for integration; it does not own a local
stack. Never copy an `.env`, database, generated PKI, or workspace home from
another checkout to get started.

## Develop in an isolated task worktree

From the primary checkout, create one task branch and worktree under the
literal `.worktrees/` directory (plural):

```bash
git fetch origin
mkdir -p .worktrees
git worktree add .worktrees/<task-name> -b <issue>-<short-name> origin/main
cd .worktrees/<task-name>
npm run worktree:init
npm run dev:doctor
```

Use a descriptive branch name when there is no issue. `worktree:init` runs
`npm ci` if needed and creates a fresh `.env`, unique ports, Compose project,
images, networks, and volumes. Run it once for a new worktree, not as a daily
startup command. Do not also run `env:init` or copy another checkout's `.env`.

For a fresh stack, then run:

```bash
npm run env:check
npm run compose:up
```

To resume the **same** stateful stack in a later session:

```bash
git status --short
npm run dev:doctor
npm run env:check
npm run compose:up
```

`compose:up` reuses that worktree's volumes and runs only pending explicit
migrations. Stop active workspaces in the product before
`npm run compose:down`; the command preserves volumes. Do not add
`-- --volumes` to resume or clean up a data-bearing stack.

Then follow steps 2–3 above to sign in and build/open a desktop.
Read the worktree-specific URL from `.env`; do not assume port 4174. Localhost
cookies are scoped to the host rather than the port, so use separate browser
profiles for sensitive parallel worktrees. For a basic desktop test, create a
workspace without an AI agent or model provider. Configure model keys through
**AI control plane → Models & routing** only when the chosen test needs AI.

## Configuration and commands

| Command | Effect |
| --- | --- |
| `npm run worktree:init` | Creates this worktree's local identity and `.env` once. |
| `npm run dev:doctor` | Read-only branch, configuration, and Docker ownership check. |
| `npm run env:check` | Read-only validation of existing `.env`. |
| `npm run env:update` | Adds newly required values while preserving existing secrets; run only after a contract change. |
| `npm run compose:config` | Renders per-service environment files and checks Compose without starting containers. |
| `npm run compose:up` | Builds and starts the local stack and explicit migration jobs. |
| `npm run image:workspace` | Builds the separate managed desktop image. |
| `npm run compose:down` | Stops the local stack and preserves volumes by default. |

The generated `.env.example` is the operator-variable catalog from
[`scripts/setup/deployment-config.mjs`](../../scripts/setup/deployment-config.mjs). Do not
edit it by hand. `.env` is the ignored, checkout-owned deployment input;
`.runtime-env/<service>.env` is generated for each service. Provider keys and
per-user connector OAuth tokens are entered through the product, not `.env`.
The root `compose.yaml` is the only local application stack. The commands above
select it automatically; you do not choose a Dockerfile or overlay. See the
[Docker file map](../../docker/README.md) for build recipes and test-only stacks.
Hosted production follows the [AWS go-live path](aws-go-live.md).

A normal worktree needs no external credentials for unit tests, stack health,
or a base workspace. Real Postmark delivery, Microsoft 365, or a social-login
provider needs that service's own credential and consent. Local remote-node
qualification generates disposable certificates; production needs real
private networking and workload certificates.

## Stateful local-stack handover

A new worktree starts with empty data. There is no repository command that
moves users, sessions, providers, databases, or workspace homes between
worktrees. If a long-lived stack must be handed over, make it an **exclusive,
stopped** recovery operation:

1. Capture the [complete backup set](operations.md#backup-and-restore): all
   **four** logical databases, artifacts, workspace homes, matching secrets,
   and image identities.
2. Stop all workspaces and writers in the source; keep that stack stopped.
3. Restore into target-owned database volumes and transfer workspace homes
   exclusively. Preserve the target's Compose identity; reapply database
   runtime grants after a logical restore that excludes ACLs.
4. Move the public port/callback origin only after the source listener stops.
   Run `npm run dev:doctor` and `npm run env:check` in the target, then compare
   non-sensitive user, organization, session, provider, and workspace counts.

Do not attach the same writable volumes to concurrent worktrees or copy an
entire source `.env`. Record exact backup, restore, ownership, and verification
commands before attempting a handover. The retired `oc-*` Docker namespace
also needs a stopped backup-and-restore; `npm run worktree:init --
--migrate-legacy-namespace` rewrites only eligible legacy isolation names and
**does not move database contents**. Retain old volumes until the restored
stack is verified.

## Remote workspace-node and Cowork qualification

Use this path only in an initialized, non-`main` task worktree. It tests a
split Control/node topology on one physical Docker host with disposable mTLS
certificates; it does not qualify cloud networking or multi-host recovery.
The [workspace-node contract](../architecture/workspace-node.md) defines the
node API, private relays, signed policy, storage, and purge.

### Remote workspace-node architecture

Control owns identity, policy, and databases. A private workspace controller
owns the node-local Docker socket and starts a sandbox, desktop relay, and
only the application/egress relays that the workspace needs. Control talks to
that node over mTLS; browser traffic enters through workspace ingress. The
node never receives Control's Docker socket or database credentials. See the
[workspace-node contract](../architecture/workspace-node.md) for details.

Start an ordinary worktree stack first. Stop its active workspaces, then check
the split topology without changing running containers:

```bash
npm run qualify:remote-workspace-node -- config
```

For Cowork, check the devices and add `--cowork` to `config` and `up`:

```bash
test -c /dev/kvm
test -c /dev/vhost-vsock
npm run qualify:remote-workspace-node -- config --cowork
npm run qualify:remote-workspace-node -- up --cowork
```

Without Cowork, use `npm run qualify:remote-workspace-node -- up`.
The qualifier reuses this worktree's databases and workspace homes, starts a
separate node project, and prints its stable node ID. Under `/platform`,
register that ID at `https://workspace-node:4101` with TLS server name
`workspace-node`, then assign the test tenant. Never silently backfill
placement or change tenant ownership. Inspect or restore with:

```bash
npm run qualify:remote-workspace-node -- status
npm run qualify:remote-workspace-node -- down
```

`down` removes only qualifier-owned containers, networks, and two-day test
certificates and restores the colocated stack; it preserves databases and
workspace homes. `npm run qualify:internal-mtls` separately checks the
LiteLLM administration listener. The local qualifier does not test production
certificate issuance/rotation, cloud firewalls, real cross-host DNS, managed
restore, node replacement, autoscaling, or capacity.

### Remote-node acceptance checklist

- Create, open, stop, and restart a base workspace with no AI agent. Confirm
  desktop ingress and persistent home; no model grant or gateway relay should
  be needed.
- For AI qualification, add a governed provider route and agent. Test allowed
  and denied egress, one model request, and absence of provider keys in the
  sandbox.
- For selected applications, test Chrome, VS Code, Obsidian, and their
  persistence. For Cowork, complete a real action on a node with both devices.
- Run two workspaces concurrently and verify separate IDs, networks, relays,
  and volumes. Stop one without interrupting the other.
- Inspect mTLS failures and safe audit events without exposing certificates,
  tokens, prompts, or provider secrets.

## Verification, integration, and release

[CONTRIBUTING.md](../../CONTRIBUTING.md) is the test-command index. Run
`npm run verify:quick` for changes, `npm run verify:db` for persistence or
migration changes, and relevant browser tests for Web behavior. Integration
into `main` does not deploy the demo. Use [demo releases](demo-release.md)
for that installation and the [AWS go-live path](aws-go-live.md) for a hosted
production candidate.
