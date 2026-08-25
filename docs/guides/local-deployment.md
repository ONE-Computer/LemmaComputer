# Local deployment and Microsoft integration setup

**Who this is for:** someone wiring up Microsoft social login, company SSO, or
the Microsoft 365 connector. This is an integration-specific supplement, not a
starting point.

To simply run LemmaComputer, use the Quick start in the [README](../../README.md).
To change the product, follow the
[evaluation, development, and remote workspace workflow](development-workflow.md) first, keep the stack in
its task worktree, and retain `LEMMACOMPUTER_INSTALLATION_KIND=worktree`.

This page uses the dedicated evaluation checkout's default URL in a few
examples. In a task worktree, use the exact
`LEMMACOMPUTER_PUBLIC_WEB_URL` generated in that worktree's `.env` for every
browser URL and OAuth callback. Do not change the worktree port to `4174`.

The runbook produces a loopback-only LemmaComputer deployment with the local
Docker sandbox driver, embedded Better Auth customer sign-in, optional
Microsoft integrations, and at least one model route. Customer sign-in uses
Better Auth; customer roles and workspace access remain LemmaComputer
organization decisions.

The root `compose.yaml` is for development and evaluation. It is not a
production security perimeter. Read
[Production considerations](operations.md#production-considerations) before
changing the bind address or publishing it behind a shared hostname.

## Completion criteria

A setup is complete when:

- `docker compose ps` reports every long-running service healthy;
- `lemmacomputer/workspace:dev`, or the configured workspace image, exists;
- the worktree's `LEMMACOMPUTER_PUBLIC_WEB_URL` accepts an enabled Better Auth
  customer sign-in method and, when configured, Microsoft sign-in;
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

This full-stack runbook is not currently supported directly on macOS,
including Apple Silicon with Docker Desktop emulation. A Mac contributor may
use macOS for editing and non-containerized development, but must use a Linux
x86_64 host or VM for the reference stack and workspace-runtime validation.
Do not force an architecture override: starting some Compose services would not
prove that the Docker-socket, managed desktop, device, and sandbox boundaries
work correctly.

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

## Configure a dedicated Microsoft 365 connector app

This registration is only for the Microsoft 365 connector. It is separate from
Better Auth Microsoft social login and from organization-managed company SSO.
Do not infer a LemmaComputer organization, role, or workspace policy from this
directory or its claims.

Use a confidential, single-tenant Web application dedicated to delegated
Microsoft 365 access.

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
   - **Directory (tenant) ID** for `LEMMACOMPUTER_MS365_TENANT_ID`;
   - **Application (client) ID** for `LEMMACOMPUTER_MS365_CLIENT_ID`.

Microsoft's current registration guide is
[Register an application in Microsoft Entra ID](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app).

### Add the local redirect URIs

Open **Authentication → Add a platform → Web** and add these exact URIs:

Append this path to the exact `LEMMACOMPUTER_PUBLIC_WEB_URL` in the current
`.env` and register the resulting absolute URL:

```text
/oauth/mcp/callback
/api/v1/connections/microsoft-365/admin-consent/callback
```

The first is the LiteLLM/Microsoft 365 OAuth bridge callback. The second is
where Entra returns a directory administrator after they approve the connector
for their organization; without it that administrator lands on a Microsoft
error instead of a confirmation, and LemmaComputer never records the approval.
Register both as server-side Web callbacks, not SPA, mobile, or public-client.

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
   `LEMMACOMPUTER_MS365_CLIENT_SECRET`.

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
Sites.Selected
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

`Sites.Selected` does not grant access to every SharePoint site. A SharePoint
administrator must separately grant this Entra application read access to each
approved site. After that provider-side grant is in place:

1. Open **Connections → Microsoft 365 → SharePoint sites** as a LemmaComputer administrator.
2. Add a friendly name and the exact site URL, such as `https://contoso.sharepoint.com/sites/Finance`.
3. Connect or reconnect the administrator's Microsoft 365 account after adding the new delegated permission.
4. Select **Verify access**. Verification resolves the non-secret Graph site and drive identifiers through the existing user connection; the OAuth token remains in LiteLLM.

Both gates remain active. Removing the site from LemmaComputer immediately
blocks agent calls to that site, but does not remove the provider-side
SharePoint grant. Remove that grant separately in the customer's normal
SharePoint or Microsoft Graph administration workflow when access is retired.

Carefully review the resulting permission set, select **Grant admin consent for
<tenant>**, and verify that every row shows **Granted**. In particular,
`ChannelMessage.Read.All` delegated access requires administrator consent.
Microsoft maintains the permission semantics and consent requirements in the
[Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
and explains tenant-wide consent in
[Grant tenant-wide admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent).

### Administrator approval for the Microsoft 365 connector

The connector requests `Team.ReadBasic.All`, `Channel.ReadBasic.All`, and
`ChannelMessage.Read.All`. These are tenant-wide, so no ordinary user can
consent to them for themselves. In a single-tenant installation the person who
registered the application usually grants consent once in the Entra portal
under **API permissions → Grant admin consent**, and nothing else is needed.

Where the connector is used by a directory the operator does not administer,
the Connections screen offers an approval link that a member can send to their
own directory administrator. That link points at Microsoft's
`/organizations/v2.0/adminconsent` endpoint and returns the administrator to
the redirect URI above, where LemmaComputer records the grant for that
organization. It requires:

- `LEMMACOMPUTER_MS365_CLIENT_ID`, so Control knows which application to name;
  and
- the admin-consent redirect URI registered on that application.

The recorded grant is LemmaComputer's own note that approval happened. It does
not itself grant anything, and clearing it does not revoke anything: only a
directory administrator can revoke consent, from their own Entra portal.

Before putting this in front of a customer, complete Microsoft
[publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview)
for the application. Many directories leave user consent restricted to apps
from verified publishers, and an unverified application asking an administrator
to approve mailbox access is a conversation that ends badly.

Set all three `LEMMACOMPUTER_MS365_*` values together. The connector does not
fall back to a product-sign-in application, which keeps Graph consent and
connector-secret rotation isolated from customer authentication.

## Initialize the environment

For development, first complete the [fresh-clone worktree
setup](development-workflow.md#develop-in-an-isolated-task-worktree). `npm run worktree:init` installs the
dependencies and creates that worktree's isolated `.env`, so do not run
`env:init` again. Continue with the required values below.

For a dedicated evaluation checkout that will not be used for development or
share state with another checkout, initialize it once from the repository
root:

```bash
npm ci
npm run env:init
```

The initializer renders the canonical deployment contract, generates fresh service credentials,
encryption keys, policy-signing material, an OpenVTC executor identity, and Web
Push keys, then writes `.env` with mode `0600`. It refuses to overwrite an
existing `.env`.

The generated file is a usable first pass, not a blank form. It already
contains the internal passwords, bearer tokens, signing and encryption keys,
local topology, safe development defaults, and every optional variable name.
The operator should edit only the external values required for the selected
flow. Never replace generated secrets with shared sample values.

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
provider keys there. Supply Microsoft 365 values only when testing that connector:

| Variable | Required for the reference path | Value |
| --- | --- | --- |
| `LEMMACOMPUTER_MS365_TENANT_ID` | Microsoft 365 only | Connector Directory (tenant) ID |
| `LEMMACOMPUTER_MS365_CLIENT_ID` | Microsoft 365 only | Connector Application (client) ID |
| `LEMMACOMPUTER_MS365_CLIENT_SECRET` | Microsoft 365 only | Connector client secret **Value** |
| `LEMMACOMPUTER_WEB_PUSH_VAPID_SUBJECT` | Recommended | A monitored `mailto:` security/contact address |

Customer accounts and organization ownership are created through Better Auth
and LemmaComputer product flows; Microsoft directory claims never bootstrap a
product role. A worktree needs no external identity credentials unless the
specific integration under test requires them.

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
| Remote node, ingress, and application-relay mTLS values | The Docker/KasmVNC runtime is placed on a private remote node; see the [remote workspace-node architecture](development-workflow.md#remote-workspace-node-architecture) and the normative [workspace node contract](../architecture/workspace-node.md) |

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
runtimes, so it can take a long time and use substantial disk space. In an
isolated worktree it produces the local tag named by
`LEMMACOMPUTER_WORKSPACE_IMAGE`. A production customer-managed deployment must
instead consume the promoted immutable digest recorded for the release; its
preflight rejects this development tag.

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

Check the published worktree endpoint and LiteLLM's private container endpoint:

```bash
LEMMACOMPUTER_LOCAL_WEB_URL="$(sed -n 's/^LEMMACOMPUTER_PUBLIC_WEB_URL=//p' .env)"
curl --fail --silent "${LEMMACOMPUTER_LOCAL_WEB_URL}/__lemmacomputer/healthz"
docker compose exec -T litellm python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4000/health/liveliness', timeout=2)"
```

Then:

1. Open the exact `LEMMACOMPUTER_PUBLIC_WEB_URL` from the current `.env`.
2. Create or sign into the Better Auth customer account and create the initial
   organization through the product flow.
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

### Microsoft 365 reports a redirect URI mismatch

Verify the callback exactly, including `http`, hostname, port, path, and lack of
a trailing slash:

Use the exact generated public origin plus these paths:

```text
/oauth/mcp/callback
```

Remove stale tunnel callbacks once they are no longer used.

### Microsoft 365 rejects the client credential

Use the client secret **Value**, not its ID. Check that the secret belongs to
the same application/client ID and has not expired.

### Microsoft 365 connection fails

- Confirm the `${LEMMACOMPUTER_PUBLIC_WEB_URL}/oauth/mcp/callback` Web redirect.
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

In a worktree, run `npm run image:workspace` and verify that
`LEMMACOMPUTER_WORKSPACE_IMAGE` matches the built image tag. In a
production customer-managed deployment, verify that the configured repository
digest was promoted and is readable by the workspace node; do not replace it
with a mutable tag.

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

- the Microsoft 365 app name plus tenant/client IDs, never the client secret;
- confirmation that the exact `/oauth/mcp/callback` is registered as a Web redirect;
- confirmation that the 13 delegated Graph permissions show granted status;
- confirmation that `.env` exists with mode `0600`, without displaying it;
- the workspace image tag and build result;
- `docker compose ps` status;
- the exact product URL from `LEMMACOMPUTER_PUBLIC_WEB_URL`; and
- any failing service name with a redacted error summary.

Never include `.env`, provider keys, client secrets, OAuth codes/tokens, full
callback URLs, database dumps, or employee content in the handoff.
