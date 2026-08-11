# Local deployment and Microsoft integration setup

This runbook is ordered for an operator or coding agent starting from a fresh
clone. It produces a loopback-only LemmaComputer deployment with the local Docker
sandbox driver, embedded Better Auth customer sign-in, optional Microsoft
integrations, and at least one model route. The current strict
customer-managed preflight still requires the transitional workforce-Entra
application values described below; customer roles and workspace access remain
LemmaComputer organization decisions.

The root `compose.yaml` is for development and evaluation. It is not a
production security perimeter. Read
[Production considerations](operations.md#production-considerations) before
changing the bind address or publishing it behind a shared hostname.

## Completion criteria

A setup is complete when:

- `docker compose ps` reports every long-running service healthy;
- `lemmacomputer/workspace:dev`, or the configured workspace image, exists;
- `http://localhost:4174` accepts an enabled Better Auth customer sign-in
  method and, when configured, Microsoft sign-in;
- the configured administrator has the administrator role;
- **Connections → Microsoft 365** completes consent and reports connected;
- a workspace can be created and opened; and
- an assigned model responds without exposing a provider or Microsoft
  credential to the workspace.

## Prerequisites

- Linux on `amd64`/`x86_64`. The current managed workspace image is not built
  for ARM hosts.
- Docker Engine with Docker Compose v2.30.0 or later. The current user must be
  able to access the Docker socket; the local workspace controller mounts it.
- Node.js 22 or later and npm.
- A Microsoft Entra tenant in which an app registration can be created.
- An Entra administrator who can grant the requested delegated Microsoft Graph
  permissions.
- Provider keys for every dynamically managed model alias assigned by the demo
  policy. Keep them out of `.env`: after the first administrator sign-in,
  configure and test every required provider in **AI control plane → Models &
  providers** before creating a workspace.
- At least 4 GiB of memory for one running workspace, plus capacity for the
  control stack. Allow substantial disk space and time for the desktop image
  build.

Check the host without changing it:

```bash
uname -m
node --version
npm --version
docker version
docker compose version
docker info >/dev/null
```

Expected architecture output is `x86_64`. Resolve Docker daemon or socket
access errors before continuing.

## Configure the transitional workforce Entra and Microsoft 365 app

This registration currently satisfies the strict customer-managed preflight
and may also be reused for the Microsoft 365 connector. It is separate from
Better Auth Microsoft social login and from organization-managed company SSO.
Do not infer a LemmaComputer organization, role, or workspace policy from this
directory or its claims.

LemmaComputer is a confidential, single-tenant Web application. The shortest
local setup uses one Entra app registration for both product sign-in and
delegated Microsoft 365 access. A separate connector app is also supported and
is described below.

### Create the app registration

1. In the
   [Microsoft Entra admin center](https://entra.microsoft.com/), open
   **Entra ID → App registrations → New registration**.
2. Give the application a recognizable name, such as
   `LemmaComputer local`.
3. Select **Accounts in this organizational directory only (Single tenant)**.
   LemmaComputer sends authorization requests to one configured tenant and
   rejects an ID token from another tenant.
4. Register the application.
5. From **Overview**, record:
   - **Directory (tenant) ID** for `LEMMACOMPUTER_ENTRA_TENANT_ID`;
   - **Application (client) ID** for `LEMMACOMPUTER_ENTRA_CLIENT_ID`.

Microsoft's current registration guide is
[Register an application in Microsoft Entra ID](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app).

### Add the local redirect URIs

Open **Authentication → Add a platform → Web** and add these exact URIs:

```text
http://localhost:4174/api/v1/auth/callback
http://localhost:4174/oauth/mcp/callback
```

The first is the LemmaComputer sign-in callback. The second is used by the
LiteLLM/Microsoft 365 OAuth bridge. Both are server-side Web callbacks; do not
register them as SPA, mobile, or public-client callbacks.

For this flow:

- leave **Access tokens** and **ID tokens** under implicit/hybrid grants
  disabled;
- leave public client flows disabled;
- do not add a trailing slash;
- do not add a direct LiteLLM or Microsoft 365 bridge port as a redirect URI;
  both services are private and browser traffic uses the LemmaComputer origin;
  and
- remove obsolete tunnel or callback URIs when they are no longer in use.

Entra matches redirect URIs closely. If any public hostname, scheme, port, or
path changes, update both `.env` and the app registration. See Microsoft's
[redirect URI guidance](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url).

### Create the client secret

1. Open **Certificates & secrets → Client secrets → New client secret**.
2. Choose a short, operationally manageable lifetime and create the secret.
3. Copy the secret **Value** immediately. Use the value, not the secret ID, for
   `LEMMACOMPUTER_ENTRA_CLIENT_SECRET`.

The value is shown only once. Do not paste it into an issue, chat, shell
history, log, or committed file. Microsoft documents the current workflow in
[Add and manage application credentials](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials).

### Add delegated Microsoft Graph permissions

Open **API permissions → Add a permission → Microsoft Graph → Delegated
permissions** and configure this exact list:

```text
User.Read
offline_access
Mail.ReadWrite
Mail.Send
Calendars.ReadWrite
Files.ReadWrite
Chat.Read
ChatMessage.Read
ChatMessage.Send
Team.ReadBasic.All
Channel.ReadBasic.All
ChannelMessage.Read.All
ChannelMessage.Send
```

Use delegated permissions only. LemmaComputer accesses Microsoft 365 on behalf
of the signed-in user; it does not use application permissions for the
connector.

`Mail.Read`, `Calendars.Read`, and `Files.Read` are not separately required
when the corresponding `ReadWrite` permission above is present. If they were
copied from an earlier setup, remove them unless another application sharing
the registration still needs them.

Carefully review the resulting permission set, select **Grant admin consent for
<tenant>**, and verify that every row shows **Granted**. In particular,
`ChannelMessage.Read.All` delegated access requires administrator consent.
Microsoft maintains the permission semantics and consent requirements in the
[Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
and explains tenant-wide consent in
[Grant tenant-wide admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent).

### Optional: use separate Web and Microsoft 365 apps

Separating the app registrations isolates Graph consent and connector-secret
rotation from product sign-in:

- The Web sign-in app uses
  `http://localhost:4174/api/v1/auth/callback` and the
  `LEMMACOMPUTER_ENTRA_*` variables. It needs only the OpenID sign-in scopes used
  by LemmaComputer.
- The Microsoft 365 connector app uses
  `http://localhost:4174/oauth/mcp/callback`, the delegated Graph permissions above, and
  the `LEMMACOMPUTER_MS365_*` variables.

Both apps should be single-tenant. If one app is used for both roles, leave all
three `LEMMACOMPUTER_MS365_*` values empty so the canonical service projection reuses
`LEMMACOMPUTER_ENTRA_*`. If a separate connector app is used, set all three
Microsoft 365 values; do not partially configure the group.

## Initialize the environment

From the repository root:

```bash
npm ci
npm run env:init
```

The initializer renders the canonical deployment contract, generates fresh service credentials,
encryption keys, policy-signing material, an OpenVTC executor identity, and Web
Push keys, then writes `.env` with mode `0600`. It refuses to overwrite an
existing `.env`.

Do not run `npm run env:init -- --force` on an initialized deployment unless
the intent is to invalidate existing sessions, signed policies, approvals,
encrypted credentials, and service trust. Do not commit `.env`.

For an existing checkout, check whether `.env.example` introduced variables
after the environment was created:

```bash
npm run env:check
```

If the check reports missing variables, merge the current template safely:

```bash
npm run env:update
npm run env:check
```

The updater preserves existing values, maps supported renamed or previously
implicit values, generates only missing local secrets, and keeps unrecognized
variables in a clearly marked review section. It refuses duplicate variables
or a partially configured policy-signing or Web Push key pair. Review any
preserved extra variable names after the update; their values are never printed.

`npm run compose:*` and `npm run image:workspace` render per-service
`.runtime-env` files automatically. Run `npm run env:render` before a direct
`docker compose` command or before handing the service-specific environment
projection to a non-Compose deployment adapter.

### Values the operator must set

Edit `.env` without printing it to shared logs. Do not add OpenAI or Anthropic
provider keys there; replace these placeholders instead:

| Variable | Required for the reference path | Value |
| --- | --- | --- |
| `LEMMACOMPUTER_ENTRA_TENANT_ID` | Yes | Entra Directory (tenant) ID |
| `LEMMACOMPUTER_ENTRA_CLIENT_ID` | Yes | Entra Application (client) ID |
| `LEMMACOMPUTER_ENTRA_CLIENT_SECRET` | Yes | Entra client secret **Value** |
| `LEMMACOMPUTER_BOOTSTRAP_OWNER_OBJECT_IDS` | Yes | Comma-separated immutable Entra object IDs allowed to perform the one-time organization-owner bootstrap |
| `LEMMACOMPUTER_ADMINISTRATOR_EMAILS` | No | Deprecated compatibility input; email never grants a LemmaComputer role |
| `LEMMACOMPUTER_WEB_PUSH_VAPID_SUBJECT` | Recommended | A monitored `mailto:` security/contact address |

Entra object-ID comparison is case-insensitive. Keep the bootstrap list
small. Every user in the configured Entra tenant may authenticate, but only the
listed immutable object IDs can perform the one-time organization-owner bootstrap.

OpenAI, Anthropic, GLM (Z.ai), and Bedrock keys are configured only after the stack is healthy:
sign in as the bootstrapped owner, open **AI control plane → Models &
providers**, save the write-only key, choose the approved models, and run the
route test before creating a workspace. Configure Pricing, a Model routes
mapping, and the Team rollout separately; a healthy provider route alone does
not enable governed service classes. When updating an older environment, `npm
run env:check` reports retired provider variable *names* only; it preserves
their values, so remove them manually after the managed-provider cutover.

### Optional values

| Variables | Set when |
| --- | --- |
| `LEMMACOMPUTER_MS365_TENANT_ID`, `LEMMACOMPUTER_MS365_CLIENT_ID`, `LEMMACOMPUTER_MS365_CLIENT_SECRET` | A separate Microsoft 365 app registration is used |
| `LEMMACOMPUTER_GITHUB_MCP_CLIENT_ID`, `LEMMACOMPUTER_GITHUB_MCP_CLIENT_SECRET` | The built-in GitHub connector is enabled |
| `LEMMACOMPUTER_BOOTSTRAP_TENANT_ID`, `LEMMACOMPUTER_BOOTSTRAP_USER_ID`, `LEMMACOMPUTER_TENANT_DISPLAY_NAME` | The initial local organization identifiers/display name need customization |
| Public URL and port variables | The deployment is intentionally using origins other than the localhost defaults |
| `LEMMACOMPUTER_KASM_LOCAL_KVM_ENABLED=true` | Claude Cowork is enabled on a customer-managed host that exposes `/dev/kvm` and `/dev/vhost-vsock` and has memory/disk headroom |
| `LEMMACOMPUTER_KASM_*` variables | `LEMMACOMPUTER_SANDBOX_DRIVER=kasm` uses an external Kasm installation |

Leave generated secrets unchanged and stable while their dependent state
exists. See [Configuration and operations](operations.md) for the complete
variable reference, backup boundaries, and rotation constraints.

## Validate configuration

Use the quiet form because non-quiet `docker compose config` renders
interpolated secret values:

```bash
npm run env:check
npm run compose:config
```

The equivalent direct command is:

```bash
docker compose config --quiet
```

Resolve every missing-variable or interpolation error before building or
starting services.

## Build the workspace image

The normal Compose start does not build the managed desktop image. Build it
explicitly:

```bash
npm run image:workspace
```

Equivalent direct command:

```bash
docker compose --profile build build workspace-image
```

The build downloads checksum-pinned desktop applications and language
runtimes, so it can take a long time and use substantial disk space. It
produces the image named by `LEMMACOMPUTER_WORKSPACE_IMAGE`, which defaults to
`lemmacomputer/workspace:dev`.

Confirm the default image exists:

```bash
docker image inspect lemmacomputer/workspace:dev >/dev/null
```

If the image name was customized, inspect that exact value instead.

## Start Compose

Start owned images, databases, networks, and health-gated services:

```bash
npm run compose:up
```

Equivalent direct command:

```bash
docker compose up -d --build --wait --wait-timeout 300
```

Compose first runs the one-shot `db-migrate` job. `control-api` starts only
after that job succeeds and then performs a read-only exact-schema
compatibility check; application startup never applies migrations. Inspect the
migration job and service readiness:

```bash
docker compose ps
docker compose logs --since=10m db-migrate
docker compose logs --since=10m control-api
docker compose logs --since=10m workspace-controller
docker compose logs --since=10m litellm
```

Do not use `docker compose config` without `--quiet` or enable verbose gateway
request/response logging in shared output; interpolated credentials and OAuth
traffic are sensitive.

## Verify the deployment

Check the two published health endpoints:

```bash
curl --fail --silent http://localhost:4174/__lemmacomputer/healthz
curl --fail --silent http://localhost:4000/health/liveliness
```

Then:

1. Open `http://localhost:4174`.
2. Configure the signing-in account's immutable Entra `oid` in
   `LEMMACOMPUTER_BOOTSTRAP_OWNER_OBJECT_IDS`, then sign in with that identity.
3. Verify the account has administrator navigation.
4. Open **AI control plane → Models & providers**, save the key for every
   provider referenced by the policy, choose its approved models, and confirm
   its route test passes. The key must not appear again in the UI, browser
   storage, or logs.
5. In **AI control plane**, add complete Pricing, publish a Lite/Balanced/Pro
   Model routes mapping, assign the administrator a default spending Team, and
   set up that Team's rollout. Keep Auto in shadow mode until its evidence is
   reviewed.
6. Open **Connections**, connect Microsoft 365, and complete the delegated
   consent flow.
7. Create a workspace and open it.
8. Send a harmless model prompt and exercise a read-only Microsoft 365 tool
   that is allowed by the assigned policy.

A healthy process does not prove provider access, Microsoft consent, policy
assignment, or workspace-image availability; complete the browser checks.

## Stop, restart, and reset

Before stopping the control stack, stop every active workspace through the
LemmaComputer UI. The product stop action removes its sandbox, relay, and egress
containers, revokes runtime grants, and updates Control state while retaining
the workspace home volume.

Then stop Compose services while retaining databases and workspace volumes:

```bash
npm run compose:down
```

The command refuses to continue while any local workspace runtime container
still exists. Do not bypass the guard with a direct `docker compose down`;
doing so can leave workspace containers running without their control services
and can keep the control network in use.

Restart with the same `.env`:

```bash
npm run compose:up
```

Delete only the two Compose-managed database volumes:

```bash
npm run compose:down -- --volumes
```

The last command is destructive. It does not delete the separately managed
per-workspace home volumes. Purge workspaces through LemmaComputer so Control and
runtime state remain consistent. See [Persistence](operations.md#persistence)
for ownership and backup details.

## Troubleshooting

### Entra reports a redirect URI mismatch

Verify the callback exactly, including `http`, hostname, port, path, and lack of
a trailing slash:

```text
http://localhost:4174/api/v1/auth/callback
http://localhost:4174/oauth/mcp/callback
```

Remove stale tunnel callbacks once they are no longer used.

### Entra rejects the client credential

Use the client secret **Value**, not its ID. Check that the secret belongs to
the same application/client ID and has not expired.

### Sign-in succeeds but the user is not an administrator

Confirm `LEMMACOMPUTER_BOOTSTRAP_OWNER_OBJECT_IDS` contains the immutable object ID returned by
the configured tenant. If the user already exists, inspect the owned identity
and role assignment rather than changing bootstrap identifiers blindly.

### Microsoft 365 connection fails

- Confirm the `http://localhost:4174/oauth/mcp/callback` Web redirect.
- Confirm all 13 delegated Graph permissions are configured and granted.
- Confirm the client and tenant values belong to the app that holds those
  permissions.
- Confirm port `4174` is reachable from the same browser used for LemmaComputer;
  LiteLLM and the Microsoft 365 bridge remain private.
- Inspect `ms365-mcp`, `litellm`, and `control-api` logs without recording
  callback query strings or tokens.

### The stack is healthy but model calls fail

Open **AI control plane → Models & providers** as an administrator and confirm
that the assigned provider is Active and its in-product route test passes.
Then confirm Pricing coverage, the published Model routes mapping, the user's
default spending Team, and that Team's rollout state. The default demo policy
uses dynamic managed-provider routes; it does not read provider keys from
`.env`.

### Workspace creation reports image not found

Run `npm run image:workspace` and verify that
`LEMMACOMPUTER_WORKSPACE_IMAGE` matches the built image tag.

### Compose does not become healthy

```bash
docker compose ps
docker compose logs --since=10m postgres litellm-postgres
docker compose logs --since=10m openvtc-consent ms365-mcp
docker compose logs --since=10m control-api workspace-controller
```

Fix the first unhealthy dependency rather than repeatedly regenerating
`.env`. More failure modes and safe diagnostics are in
[Health and diagnostics](operations.md#health-and-diagnostics).

## Agent handoff checklist

An automation agent preparing a local instance should leave the operator with:

- the Entra app name plus tenant/client IDs, never the client secret;
- confirmation that the two exact callbacks are registered as Web redirects;
- confirmation that the 13 delegated Graph permissions show granted status;
- confirmation that `.env` exists with mode `0600`, without displaying it;
- the workspace image tag and build result;
- `docker compose ps` status;
- the product URL, `http://localhost:4174`; and
- any failing service name with a redacted error summary.

Never include `.env`, provider keys, client secrets, OAuth codes/tokens, full
callback URLs, database dumps, or employee content in the handoff.
