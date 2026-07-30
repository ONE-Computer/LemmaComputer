# Local deployment and Microsoft Entra setup

This runbook is ordered for an operator or coding agent starting from a fresh
clone. It produces a loopback-only ONEComputer deployment with the local Docker
sandbox driver, Microsoft Entra sign-in, the Microsoft 365 connector, and at
least one model route.

The root `compose.yaml` is for development and evaluation. It is not a
production security perimeter. Read
[Production considerations](operations.md#production-considerations) before
changing the bind address or publishing it behind a shared hostname.

## Completion criteria

A setup is complete when:

- `docker compose ps` reports every long-running service healthy;
- `onecomputer/workspace:dev`, or the configured workspace image, exists;
- `http://localhost:4174` accepts Microsoft sign-in;
- the configured administrator has the administrator role;
- **Connections → Microsoft 365** completes consent and reports connected;
- a workspace can be created and opened; and
- an assigned model responds without exposing a provider or Microsoft
  credential to the workspace.

## Prerequisites

- Linux on `amd64`/`x86_64`. The current managed workspace image is not built
  for ARM hosts.
- Docker Engine with the Docker Compose v2 plugin. The current user must be
  able to access the Docker socket; the local workspace controller mounts it.
- Node.js 22 or later and npm.
- A Microsoft Entra tenant in which an app registration can be created.
- An Entra administrator who can grant the requested delegated Microsoft Graph
  permissions.
- Provider keys for every dynamically managed model alias assigned by the demo
  policy. Keep them out of `.env`: after the first administrator sign-in,
  configure and test both Anthropic and OpenAI in **Settings → Provider
  settings** before creating a workspace.
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

## Configure Microsoft Entra

ONEComputer is a confidential, single-tenant Web application. The shortest
local setup uses one Entra app registration for both product sign-in and
delegated Microsoft 365 access. A separate connector app is also supported and
is described below.

### Create the app registration

1. In the
   [Microsoft Entra admin center](https://entra.microsoft.com/), open
   **Entra ID → App registrations → New registration**.
2. Give the application a recognizable name, such as
   `ONEComputer local`.
3. Select **Accounts in this organizational directory only (Single tenant)**.
   ONEComputer sends authorization requests to one configured tenant and
   rejects an ID token from another tenant.
4. Register the application.
5. From **Overview**, record:
   - **Directory (tenant) ID** for `ONECOMPUTER_ENTRA_TENANT_ID`;
   - **Application (client) ID** for `ONECOMPUTER_ENTRA_CLIENT_ID`.

Microsoft's current registration guide is
[Register an application in Microsoft Entra ID](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app).

### Add the local redirect URIs

Open **Authentication → Add a platform → Web** and add these exact URIs:

```text
http://localhost:4174/api/v1/auth/callback
http://localhost:4000/callback
```

The first is the ONEComputer sign-in callback. The second is used by the
LiteLLM/Microsoft 365 OAuth bridge. Both are server-side Web callbacks; do not
register them as SPA, mobile, or public-client callbacks.

For this flow:

- leave **Access tokens** and **ID tokens** under implicit/hybrid grants
  disabled;
- leave public client flows disabled;
- do not add a trailing slash;
- do not add `http://localhost:4311` as a redirect URI; port `4311` is the
  browser-facing Microsoft connector authorization bridge, not an Entra
  callback; and
- remove obsolete tunnel or callback URIs when they are no longer in use.

Entra matches redirect URIs closely. If any public hostname, scheme, port, or
path changes, update both `.env` and the app registration. See Microsoft's
[redirect URI guidance](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url).

### Create the client secret

1. Open **Certificates & secrets → Client secrets → New client secret**.
2. Choose a short, operationally manageable lifetime and create the secret.
3. Copy the secret **Value** immediately. Use the value, not the secret ID, for
   `ONECOMPUTER_ENTRA_CLIENT_SECRET`.

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

Use delegated permissions only. ONEComputer accesses Microsoft 365 on behalf
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
  `ONECOMPUTER_ENTRA_*` variables. It needs only the OpenID sign-in scopes used
  by ONEComputer.
- The Microsoft 365 connector app uses
  `http://localhost:4000/callback`, the delegated Graph permissions above, and
  the `ONECOMPUTER_MS365_*` variables.

Both apps should be single-tenant. If one app is used for both roles, leave all
three `ONECOMPUTER_MS365_*` values empty so Compose reuses
`ONECOMPUTER_ENTRA_*`. If a separate connector app is used, set all three
Microsoft 365 values; do not partially configure the group.

## Initialize the environment

From the repository root:

```bash
npm ci
npm run env:init
```

The initializer copies `.env.example`, generates fresh service credentials,
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

### Values the operator must set

Edit `.env` without printing it to shared logs. Do not add OpenAI or Anthropic
provider keys there; replace these placeholders instead:

| Variable | Required for the reference path | Value |
| --- | --- | --- |
| `ONECOMPUTER_ENTRA_TENANT_ID` | Yes | Entra Directory (tenant) ID |
| `ONECOMPUTER_ENTRA_CLIENT_ID` | Yes | Entra Application (client) ID |
| `ONECOMPUTER_ENTRA_CLIENT_SECRET` | Yes | Entra client secret **Value** |
| `ONECOMPUTER_ADMINISTRATOR_EMAILS` | Yes | Comma-separated Entra email addresses that bootstrap as administrators |
| `ONECOMPUTER_WEB_PUSH_VAPID_SUBJECT` | Recommended | A monitored `mailto:` security/contact address |

Administrator email comparison is case-insensitive. Keep the bootstrap list
small. Every user in the configured Entra tenant may authenticate, but only the
listed addresses bootstrap as administrators.

OpenAI, Anthropic, GLM (Z.ai), and Bedrock keys are configured only after the stack is healthy:
sign in as a listed administrator, open **Settings → Provider settings**, save the
write-only key, and run the route test before creating a workspace. When
updating an older environment, `npm run env:check` reports retired provider
variable *names* only; it preserves their values, so remove them manually after
the managed-provider cutover.

### Optional values

| Variables | Set when |
| --- | --- |
| `ONECOMPUTER_MS365_TENANT_ID`, `ONECOMPUTER_MS365_CLIENT_ID`, `ONECOMPUTER_MS365_CLIENT_SECRET` | A separate Microsoft 365 app registration is used |
| `ONECOMPUTER_GITHUB_MCP_CLIENT_ID`, `ONECOMPUTER_GITHUB_MCP_CLIENT_SECRET` | The built-in GitHub connector is enabled |
| `ONECOMPUTER_BOOTSTRAP_TENANT_ID`, `ONECOMPUTER_BOOTSTRAP_USER_ID`, `ONECOMPUTER_TENANT_DISPLAY_NAME` | The initial local organization identifiers/display name need customization |
| Public URL and port variables | The deployment is intentionally using origins other than the localhost defaults |
| `KASM_LOCAL_KVM_ENABLED=true` | Claude Cowork is enabled on a customer-managed host that exposes `/dev/kvm` and `/dev/vhost-vsock` and has memory/disk headroom |
| `KASM_*` variables | `SANDBOX_DRIVER=kasm` uses an external Kasm installation |

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
produces the image named by `ONECOMPUTER_WORKSPACE_IMAGE`, which defaults to
`onecomputer/workspace:dev`.

Confirm the default image exists:

```bash
docker image inspect onecomputer/workspace:dev >/dev/null
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

Control runs database migrations during startup. Inspect readiness:

```bash
docker compose ps
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
curl --fail --silent http://localhost:4174/__onecomputer/healthz
curl --fail --silent http://localhost:4000/health/liveliness
```

Then:

1. Open `http://localhost:4174`.
2. Sign in with an address listed in
   `ONECOMPUTER_ADMINISTRATOR_EMAILS`.
3. Verify the account has administrator navigation.
4. Open **Settings → Provider settings**, save the key for every provider
   referenced by the policy, and confirm its route test passes. The key must not
   appear again in the UI, browser storage, or logs.
5. Open **Connections**, connect Microsoft 365, and complete the delegated
   consent flow.
6. Create a workspace and open it.
7. Send a harmless model prompt and exercise a read-only Microsoft 365 tool
   that is allowed by the assigned policy.

A healthy process does not prove provider access, Microsoft consent, policy
assignment, or workspace-image availability; complete the browser checks.

## Stop, restart, and reset

Before stopping the control stack, stop every active workspace through the
ONEComputer UI. The product stop action removes its sandbox, relay, and egress
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
per-workspace home volumes. Purge workspaces through ONEComputer so Control and
runtime state remain consistent. See [Persistence](operations.md#persistence)
for ownership and backup details.

## Troubleshooting

### Entra reports a redirect URI mismatch

Verify the callback exactly, including `http`, hostname, port, path, and lack of
a trailing slash:

```text
http://localhost:4174/api/v1/auth/callback
http://localhost:4000/callback
```

Remove stale tunnel callbacks once they are no longer used.

### Entra rejects the client credential

Use the client secret **Value**, not its ID. Check that the secret belongs to
the same application/client ID and has not expired.

### Sign-in succeeds but the user is not an administrator

Confirm `ONECOMPUTER_ADMINISTRATOR_EMAILS` contains the email claim returned by
the configured tenant. If the user already exists, inspect the owned identity
and role assignment rather than changing bootstrap identifiers blindly.

### Microsoft 365 connection fails

- Confirm the `http://localhost:4000/callback` Web redirect.
- Confirm all 13 delegated Graph permissions are configured and granted.
- Confirm the client and tenant values belong to the app that holds those
  permissions.
- Confirm ports `4000` and `4311` are reachable from the same browser used for
  ONEComputer.
- Inspect `ms365-mcp`, `litellm`, and `control-api` logs without recording
  callback query strings or tokens.

### The stack is healthy but model calls fail

Open **Settings → Provider settings** as an administrator and confirm that the
assigned provider is Active and its in-product route test passes. The default
demo policy uses dynamic Anthropic and OpenAI routes; it does not read provider
keys from `.env`.

### Workspace creation reports image not found

Run `npm run image:workspace` and verify that
`ONECOMPUTER_WORKSPACE_IMAGE` matches the built image tag.

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
