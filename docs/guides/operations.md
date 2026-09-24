# Operating a local LemmaComputer stack

**Use this page after a local Compose installation exists.** It covers safe
start/stop, health checks, persistence, and recovery. The root `compose.yaml`
is a development and evaluation reference on one Docker host. It is not the
hosted AWS deployment procedure. For first setup use the
[development workflow](development-workflow.md); for an AWS installation use
[the go-live path](aws-go-live.md). For the separately managed EC2 demo use
[demo releases](demo-release.md), not the commands below.

## Start and stop

In the checkout that owns the stack, keep its existing `.env` and Docker
volumes. For a task worktree, run `npm run dev:doctor` at the start of the
session, then:

```bash
npm run env:check
npm run compose:up
```

`compose:up` renders each service's limited environment, runs explicit database
migration jobs, and waits for health. Application startup checks schema
compatibility but does not migrate. Build the separate desktop image with
`npm run image:workspace` before creating a managed desktop.

Stop all active workspaces through LemmaComputer first. Then run:

```bash
npm run compose:down
```

The command refuses to stop while local workspace containers remain, and it
preserves database and workspace volumes. Do not use `-- --volumes` for a stack
with data. Never copy another checkout's `.env` or attach its writable volumes.

## Configuration lifecycle

The environment contract lives in
[`scripts/setup/deployment-config.mjs`](../../scripts/setup/deployment-config.mjs). Its
generated `.env.example` lists every operator variable. `npm run worktree:init`
creates a task worktree's `.env` once. A dedicated disposable evaluation clone
uses `npm run env:init -- --profile=worktree`. After pulling a change to the
contract, run:

```bash
npm run env:check
npm run env:update   # only if the check reports missing variables
npm run env:check
```

`env:update` preserves existing values and reports extra variable names.
`env:init --force` replaces generated secrets and can invalidate sessions,
signatures, and encrypted records; it is not an update command. Repository
commands generate `.runtime-env/<service>.env` for each service. Before a
direct `docker compose` command, run `npm run env:render` and use
`docker compose config --quiet` so interpolated secrets are not printed.

The public browser origin is `LEMMACOMPUTER_PUBLIC_WEB_URL`. Its exact value
must match OAuth callbacks. The reference stack binds published ports to
`127.0.0.1` by default. Provider API keys and personal connector OAuth tokens
are configured through the product, not `.env`. Real authentication and
invitation email uses Postmark; the development `capture` transport is local
only. Keep signing, encryption, Better Auth, LiteLLM, and workspace-ingress
secrets in the recovery set for as long as their dependent state exists.

## Health and diagnostics

```bash
docker compose ps
docker compose logs --since=10m db-migrate auth-db-migrate platform-auth-db-migrate
docker compose logs --since=10m control-api workspace-controller litellm
```

Check the browser entry at
`${LEMMACOMPUTER_PUBLIC_WEB_URL}/__lemmacomputer/healthz`. A healthy stack
only proves service readiness. Sign-in, a provider request, Microsoft consent,
and workspace creation need separate checks when those flows change.

| Symptom | First check |
| --- | --- |
| Control unhealthy | Migration jobs, schema check, and Control logs. |
| LiteLLM unhealthy | Gateway database and LiteLLM logs; keep its encryption secrets stable. |
| Workspace image missing | Run `npm run image:workspace` in development; verify the exact digest on a production node. |
| Workspace starts but browser returns 502 | Workspace ingress, its desktop relay, and node connectivity. |
| Microsoft callback fails | Exact public origin and registered callback; see the [Microsoft runbook](local-deployment.md). |

Do not enable verbose request/response logging to diagnose real employee or
OAuth traffic. Use safe error codes and operation IDs.

## Persistence

The reference Compose stack has two PostgreSQL engines but **four logical
databases**: `lemmacomputer` for product state, `lemmacomputer_auth` for
customer identity, `lemmacomputer_platform_auth` for platform identity, and
`litellm` for gateway state. The platform database is initialized even when a
customer-managed profile does not expose the platform operator realm. Workspace
homes are separately managed Docker volumes; the local artifact store has its
own volume. Normal `compose:down` preserves them all.

```bash
docker volume ls --filter label=com.lemmacomputer.runtime=workspace-home
```

Purge a workspace through the product/API so its database, grants, container,
and persistent home remain consistent.

## Backup and restore

A recoverable set contains **all four logical databases**, workspace homes,
Control artifacts (local volume or hosted S3 bucket), matching secret versions,
and exact first-party image digests. For a local Compose stack, these examples
create logical database dumps in the current directory:

```bash
docker compose exec -T postgres pg_dump -U lemmacomputer -d lemmacomputer -Fc > lemmacomputer-control.dump
docker compose exec -T postgres pg_dump -U lemmacomputer -d lemmacomputer_auth -Fc > lemmacomputer-auth.dump
docker compose exec -T postgres pg_dump -U lemmacomputer -d lemmacomputer_platform_auth -Fc > lemmacomputer-platform-auth.dump
docker compose exec -T litellm-postgres pg_dump -U litellm -d litellm -Fc > lemmacomputer-gateway.dump
```

These commands do **not** back up Docker workspace/artifact volumes or secrets.
Protect the dumps as credentials. Restore and test the *whole* set in an
isolated environment before relying on it; restoring product rows without
matching authentication and gateway state can break access. Hosted RDS and S3
need their own coordinated backup and restore procedure before go-live.

## Workspace node runtime

The workspace controller owns the node-local Docker socket. Control does not.
Build the desktop image locally with `npm run image:workspace`; production
nodes use promoted `repository@sha256:<digest>` images. For Chrome, Visual
Studio Code, or Obsidian on an AppArmor-enforcing Linux node, check and install
the fixed Electron profile before enabling those applications:

```bash
npm run apparmor:electron:check
sudo "$(command -v node)" scripts/development/install-electron-apparmor.mjs install
```

Then set `LEMMACOMPUTER_KASM_LOCAL_ELECTRON_SANDBOX_ENABLED=true`. The profile
allows Chromium's user namespace inside the selected workspace container; it
does not make the container unconfined. Claude Cowork additionally needs usable
`/dev/kvm` and `/dev/vhost-vsock` on the workspace node. Hosted workspaces and
these devices belong on private remote nodes, never on the Control host. The
[workspace-node contract](../architecture/workspace-node.md) defines mTLS,
networking, storage, and purge; the
[local remote-node qualifier](development-workflow.md#remote-workspace-node-and-cowork-qualification)
tests the application boundary.

## Changing organization workspace guardrails

Publishing a guardrail version stops affected running workspaces, revokes their
current access, then restarts compatible ones under the new version. Warn users
and use a maintenance window for active work. Review **Affected workspaces**
before saving; afterward check **Ready**, **Needs attention**, and any restart
failures in the administration inventory. A failed transition can leave some
workspaces stopped without publishing the new version. Resolve the node or
controller failure and retry through the product; do not edit policy rows or
reuse an old launch URL. The exact reconciliation rules are in
[Workspace guardrail reconciliation](../architecture/workspace-guardrail-reconciliation.md).

## Hosted LiteLLM administration transport

Hosted configuration requires a private HTTPS LiteLLM admin listener with
mutual TLS, a Control client identity, and distinct customer, platform,
gateway, and ingress secrets. The hosted
[profile preflight](deployment-profiles.md#operator-preflight) validates the
configuration contract. `npm run test:mtls` checks the listener
boundary locally. Neither command provisions or qualifies an AWS network.
Inject certificate material through production secret custody, using the exact
variable names and validation rules in
[`scripts/setup/deployment-config.mjs`](../../scripts/setup/deployment-config.mjs).

## Production considerations

A local Compose health check does not approve internet exposure. A production
operator must provide the canonical HTTPS origin, restricted private services,
separate model and MCP egress, workload certificates, managed backups and
restore tests, logging, capacity, and immutable images. Keep LiteLLM and the
workspace controller off the public network. Do not change
`LEMMACOMPUTER_HTTP_BIND_ADDRESS` to `0.0.0.0` without that reviewed perimeter.
The [AWS go-live path](aws-go-live.md) lists what remains to be built and
qualified for that environment.

Product-specific operating rules live with their owners:

- Customer authentication and company SSO:
  [authentication architecture](../architecture/authentication.md).
- Model credentials, connector OAuth custody, and private gateway routes:
  [LiteLLM gateway architecture](../architecture/litellm-gateway.md) and
  [MCP networking](../architecture/mcp-networking.md).
- Control-owned artifacts and staged uploads:
  [durable chat and artifacts](../product/durable-chat-and-artifacts.md).
- Workspace placement, recovery, and storage:
  [workspace-node deployment](../architecture/workspace-node.md).
