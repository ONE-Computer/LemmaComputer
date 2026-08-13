# Configuration and operations

The root `compose.yaml` is the reference deployment for a single-host
development or evaluation environment. The checked-in deployment environment
contract in `scripts/deployment-config.mjs` is the source of truth for every
operator setting; it generates `.env.example`, validates profile-specific
requirements, and renders least-privilege service environment files for Compose
or another deployment target. Compose owns only container topology. It replaces layered infrastructure
snapshots with one validated topology, two managed database volumes, explicit
network boundaries, health-gated dependencies, and a separate build target for
the workspace image.

For a first installation, follow the ordered
[local deployment and Entra setup runbook](local-deployment.md). This page is
the ongoing configuration, recovery, and production-hardening reference.

## Configuration lifecycle

Create `.env` once:

```bash
npm ci
npm run env:init
```

The initializer renders the canonical contract, generates local cryptographic material,
writes the result with mode `0600`, and refuses to replace an existing file.
Use `--force` only when intentionally invalidating all current local sessions,
policy signatures, approvals, encrypted credentials, and service trust:

```bash
npm run env:init -- --force
```

For an alternate path:

```bash
npm run env:init -- --file=/absolute/path/to/lemmacomputer.env
npm run env:render -- --file=/absolute/path/to/lemmacomputer.env
docker compose --env-file /absolute/path/to/lemmacomputer.env config --quiet
```

Compose automatically loads only a root `.env`. Pass `--env-file` for any
other location.

After updating the checkout, compare the existing environment with the current
template before starting services:

```bash
npm run env:check
```

Safely merge newly introduced variables without rotating existing values:

```bash
npm run env:update
npm run env:check
```

The updater maps supported renamed or previously implicit variables, generates
only missing local secrets, and preserves unknown variables in a review section.
It refuses duplicate variables and incomplete coupled signing or Web Push key
groups. Review preserved extra variable names manually; the commands never
print their values.

`npm run env:render` writes `.runtime-env/<service>.env` with mode `0600`.
Each service receives only its declared inputs, so do not substitute a global
`.env` file as a service `env_file`. A non-Compose deployment adapter can
consume the same projection; it must provide the equivalent internal service
names or adapt those reference topology values for its platform.

The `npm run compose:*` and `npm run image:workspace` commands render those
files automatically. Before a direct `docker compose` command, run
`npm run env:render` for the same environment first. The reference Compose
stack requires Docker Compose v2.30.0 or later so its `env_file` entries can
use literal `raw` format for secret-manager values.

Qualification stacks use a separate generated
`.env.qualification.example` reference and create their secrets and ports at
run time. They are test-only inputs and are intentionally rejected from a
production deployment environment.

## Environment variable groups

### Public routing

| Variable | Default | Purpose |
| --- | --- | --- |
| `LEMMACOMPUTER_HTTP_BIND_ADDRESS` | `127.0.0.1` | Host bind address for all published ports |
| `LEMMACOMPUTER_WEB_PORT` | `4174` | Product and workspace-ingress port |
| `LEMMACOMPUTER_PUBLIC_WEB_URL` | `http://localhost:4174` | Canonical product origin and Entra callback base |

Workspace ingress derives the browser-facing connector routes from the one
canonical origin. It forwards only `GET /oauth/mcp/callback` to private
LiteLLM and `GET /m365/authorize` to the private Microsoft 365 bridge. LiteLLM
and the bridge do not publish host ports. Changing
`LEMMACOMPUTER_PUBLIC_WEB_URL` requires updating the corresponding Entra and
GitHub OAuth-app redirect URI.

### Identity and bootstrap

| Variable | Required | Purpose |
| --- | --- | --- |
| `LEMMACOMPUTER_BETTER_AUTH_SECRET` | Yes | Versioned Better Auth signing and encryption secret; generated locally and stored in a production secret manager |
| `LEMMACOMPUTER_AUTH_EMAIL_TRANSPORT` | Yes | `capture` for non-production tests or `postmark` for real transactional delivery |
| `LEMMACOMPUTER_INVITATION_DELIVERY_MODE` | Yes | `email`, or explicit `copy-link` only where the profile permits it |
| `LEMMACOMPUTER_GOOGLE_AUTH_CLIENT_ID` and secret | Optional pair | Google customer social login |
| `LEMMACOMPUTER_MICROSOFT_AUTH_CLIENT_ID` and secret | Optional pair | Microsoft customer social login |
| `LEMMACOMPUTER_CUSTOMER_SSO_TRUSTED_IDP_ORIGINS` | Tenant OIDC only | Comma-separated exact HTTPS IdP origins permitted for server-side discovery; never use wildcards |
| `LEMMACOMPUTER_ENTRA_TENANT_ID` | Current customer-managed preflight | Transitional workforce directory; not the product role authority |
| `LEMMACOMPUTER_ENTRA_CLIENT_ID` | Current customer-managed preflight | Transitional workforce Web OIDC application |
| `LEMMACOMPUTER_ENTRA_CLIENT_SECRET` | Current customer-managed preflight | Transitional workforce confidential-client secret |
| `LEMMACOMPUTER_EXTERNAL_ID_TENANT_ID` | Current hosted preflight | Transitional external tenant directory ID |
| `LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN` | Current hosted preflight | Label before `.ciamlogin.com` |
| `LEMMACOMPUTER_EXTERNAL_ID_CLIENT_ID` | Current hosted preflight | Transitional external tenant Web OIDC application |
| `LEMMACOMPUTER_EXTERNAL_ID_CLIENT_SECRET` | Current hosted preflight | Transitional external tenant confidential-client secret |
| `LEMMACOMPUTER_BOOTSTRAP_OWNER_OBJECT_IDS` | Transitional Entra bootstrap | Comma-separated immutable Entra object IDs allowed to perform the compatibility owner bootstrap |
| `LEMMACOMPUTER_ADMINISTRATOR_EMAILS` | No | Deprecated compatibility input; email never grants a LemmaComputer role |
| `LEMMACOMPUTER_BOOTSTRAP_TENANT_ID` | No | Owned tenant identifier |
| `LEMMACOMPUTER_BOOTSTRAP_USER_ID` | No | Owned ID for a bootstrap administrator |
| `LEMMACOMPUTER_TENANT_DISPLAY_NAME` | No | Initial organization display name |

Object-ID matching is case-insensitive. Keep the one-time bootstrap allowlist small.
After identity records and memberships exist, changing bootstrap identifiers
does not migrate existing rows.

In both profiles, Better Auth proves customer authentication and LemmaComputer
resolves the active organization membership and permissions. Self-service
organization creation establishes protected ownership; invitations activate
only their predetermined organization and role. Social-login, company-SSO,
workforce-Entra, and External-ID claims cannot select or elevate a product
membership. The latter two remain transitional adapters subject to their own
profile preflight. An organization administrator can later suspend or
reactivate a membership, revoke its active sessions, change its policy
assignment, and manage sandbox and egress security-group configuration.
A returning user does not automatically regain a policy that an administrator
revoked.

#### Company SSO lifecycle

Company SSO uses `@better-auth/sso` in the local authentication database for
both deployment profiles. LemmaComputer remains the only organization,
membership, and role authority. Provider groups, administrator claims, and
email domains never create product access.

Before configuring OIDC, add every exact HTTPS origin used by its discovery,
authorization, token, user-info, and JWKS endpoints to
`LEMMACOMPUTER_CUSTOMER_SSO_TRUSTED_IDP_ORIGINS`, then restart Control. Do not
use wildcards. SAML configuration does not require this discovery allowlist.

1. The protected organization owner opens **Settings → People and access →
   Company SSO**, adds OIDC client credentials or a SAML sign-in URL and
   signing certificate, and records the generated callback URL.
2. Add the displayed DNS TXT proof and use **Verify DNS**. An invitation for
   the verified email domain may then use the pending provider, but ordinary
   domain sign-in remains disabled.
3. Invite a standards-provider account as Administrator. The invitee chooses
   **Continue with company SSO**, completes any Better Auth email-verification
   step, accepts the predetermined membership, and uses **Test provider**.
4. The owner proves a non-SSO recovery method with recent MFA, chooses
   **Confirm recovery**, then **Enforce SSO**. Only now may public company login
   route the verified domain. Existing memberships still decide access.

Credential rotation and metadata refresh fence routing first: the connection
becomes `pending`, its configuration version increments, and prior test,
recovery, and enforcement timestamps are cleared before Better Auth is
changed. OIDC refresh re-fetches discovery; SAML refresh requires bounded IdP
metadata XML. Retest, reconfirm owner recovery, and enforce again. If refresh
or rotation fails, leave the connection pending and use another sign-in method
while correcting it; never force the old route active.

**Suspend** immediately disables company routing without deleting provider
configuration. **Roll back** returns a suspended connection to active but does
not enforce it. **Disconnect** first removes product routing and then deletes
the Better Auth provider. Disconnect before transferring organization
ownership so Better Auth provider administration cannot remain bound to the
former owner.

Release evidence must include Microsoft Entra and one non-Microsoft SAML/OIDC
provider. For each, capture setup, DNS verification, invitation admission,
successful provider test, enforcement, failed unknown/uninvited admission,
metadata refresh or credential rotation, suspension/recovery, rollback, and
disconnect without recording credentials, codes, assertions, or tokens.

### Microsoft 365

`LEMMACOMPUTER_MS365_TENANT_ID`, `LEMMACOMPUTER_MS365_CLIENT_ID`, and
`LEMMACOMPUTER_MS365_CLIENT_SECRET` are optional as a group. Empty values reuse
the Web Entra application. A separate connector application is recommended for
production because it isolates Graph scopes and credential rotation.

The connector requests only the fixed scope list in `compose.yaml`. Tenant
administrators should review those scopes against the enabled tool allowlist.
See [Configure Microsoft Entra](local-deployment.md#configure-microsoft-entra)
for the exact local redirect URIs and delegated permission list.

### Hosted MCP connectors

The unified **Connections** screen includes a built-in catalog of official,
provider-hosted remote MCP servers. Listing a card without an existing
connection marker only seeds non-secret metadata; it does not register the
server with LiteLLM, refresh a workspace grant, or expose its tools to an
agent. On a later Connections entry, Control can revalidate only that person's
explicit markers and reconciles the workspace grant only when a marker's
resolved state changes or remains expired. Selecting **Connect** registers and
checks only that selected connector, then starts its per-user OAuth flow.

Notion, Linear, and Atlassian use their official hosted MCP endpoints and
dynamic OAuth client registration. GitHub requires an OAuth app because its
authorization server does not expose dynamic client registration. Configure
`LEMMACOMPUTER_GITHUB_MCP_CLIENT_ID` and
`LEMMACOMPUTER_GITHUB_MCP_CLIENT_SECRET`, with the LiteLLM callback
`${LEMMACOMPUTER_PUBLIC_WEB_URL}/oauth/mcp/callback` registered in GitHub. Other
providers can impose their own OAuth-app approval or allow-list requirements;
an unsuccessful registration or authorization leaves the catalog card
disconnected and contributes no tools.

After a person successfully connects a service, Control discovers that
person's available tools and projects only those explicitly connected tools
into that person's workspace grant. Cards that are visible but disconnected,
disabled, or unavailable are never injected into the agent tool set.

Administrators can add another OAuth-capable remote connector from
**Connections → Add connector** without changing application code:

1. Enter the public HTTPS MCP endpoint, catalog copy, provider scopes, and any
   provider app client ID/secret.
2. **Check server** creates a short-lived LiteLLM discovery session and verifies
   that the endpoint exposes a compatible OAuth authorization flow.
3. **Add connector** consumes that one-time check and creates the persistent
   LiteLLM MCP server. Only non-secret catalog metadata is persisted in
   `connector_registry`; client settings and per-user OAuth credentials stay in
   LiteLLM.
4. When a person connects the service, Control discovers that user's exact
   server tools and refreshes every workspace grant they own. The aggregate
   workspace MCP bridge then advertises the newly granted tools to all assigned
   workspace agents without rebuilding the workspace.

Custom endpoints are admitted only after public-HTTPS parsing and resolution
of every A and AAAA answer. IP literals, private/link-local/ULA answers,
mixed public-and-private DNS answers, credentials, and fragments are rejected.
That admission check is defense in depth: LiteLLM has no direct internet route.
Model requests use the static-provider `gateway-egress-proxy`; public MCP and
OAuth requests use the separate `remote-mcp-egress-proxy`. The strict MCP
client cannot inherit `NO_PROXY`, and the remote proxy resolves and validates
every connection again, pins the approved IP, checks TLS SNI, and independently
authorizes redirected destinations. See [MCP networking, egress, and OAuth
callbacks](mcp-networking.md) for the complete path.

For a hosted deployment, the platform/network owner must put every exact HTTPS
origin used by the MCP and OAuth flow—endpoint, protected-resource and
authorization-server metadata, authorization, token, and dynamic-client-
registration origins—in
`LEMMACOMPUTER_HOSTED_MCP_EGRESS_ORIGINS` before a tenant administrator can add
the connector. This is deliberately deployment-owned rather than tenant-local:
a shared LiteLLM gateway must not let one tenant create a new gateway-wide
egress destination. Customer-managed installations can use their own
connector-registry approval path. The check result shows the discovered
authorization origin; adding the connector is the administrator's explicit
confirmation of that origin.

Disconnecting a service invalidates its connection projection and refreshes the
same grants. If a grant cannot be refreshed, Control revokes it so an agent
cannot keep stale connector access. Grant renewal also recomputes the projection
periodically. Identically named tools from different connectors are exposed
with connector-qualified names and routed back to their original server.

#### OAuth credential renewal and recovery

Connection-status checks do not invoke a connector tool or perform a provider
business action. When LiteLLM reports a person's OAuth connection as expired,
Control can make one serialized, scoped **safe discovery** request: it asks
LiteLLM only for that person's enabled tool list for that connector. LiteLLM
may use its stored refresh credential and rotate it during this discovery;
Control then reads the connection status again. OAuth access and refresh tokens
are never returned to Control, included in the tool projection, or suitable for
operator log inspection.

The pinned qualification fixture returns a renewed token lasting 65 seconds:
LiteLLM treats tokens within its 60-second expiry skew as stale, and a shorter
fixture lifetime can cause its compatibility and v2 resolver paths to refresh
the same connection twice. The release qualifier therefore asserts exactly one
successful refresh request and one Control safe discovery. A denied renewal may
be retried by LiteLLM's resolver, but it must never reach a connector tool.

If the second status is connected, the connector's explicitly allowed tools
remain eligible for workspace grants. If renewal fails or the status remains
expired, Control fails closed: it drops the cached connector projection and
recomputes affected workspace grants without that connector. Agents therefore
cannot receive stale tools while the Web UI directs the person to reconnect.

To recover, the affected person should reconnect the service from
**Connections** and complete the provider's browser OAuth flow again. Do not
export, copy, paste, or manually replace tokens in LiteLLM or application
configuration. After reconnecting, confirm the connection is shown as connected
and that only its policy-approved tools reappear in a newly refreshed workspace
grant. If it does not, an administrator should verify that the connector is
enabled and its configured scopes and provider client settings still match the
provider registration.

For a suspected renewal regression, first disable the affected connector or
its access policy to keep it out of new workspace grants. Roll back application
and gateway images only to the preceding verified immutable release, following
[the demo release rollback procedure](demo-release.md#rollback). Do not edit
LiteLLM OAuth records, reverse migrations, or try to restore individual
credentials; after a compatible rollback, invalidate/recompute connector grants
and have affected people reconnect.

Run `npm run qualify:oauth` before accepting a LiteLLM version or OAuth gateway
configuration change. It starts an isolated pinned LiteLLM, PostgreSQL, and
fixture stack to qualify renewal, restart persistence, identity isolation, and
fail-closed recovery without printing token material. `npm run verify:release`
includes this qualification as a required release gate.

Each connector also has an organization-owned access policy. Administrators can
disable the connector for everyone or prevent members from changing their
personal connection. Tool decisions remain `allow`, `approval_required`, or
`deny`; denied tools are removed from workspace grants. These checks are
enforced by Control and the runtime grant projection, not only by the Web UI.

Remote tool reviews are tied to the provider's current descriptor, not just its
name. An added tool or a same-name definition change is `deny` until an
administrator reviews it. The review screen reports added, changed, and removed
tools, and saving is conditional on the displayed tool-set digest; a provider
change during review is rejected and must be reviewed again. Control repeats
the descriptor check while authorizing a call and while refreshing the short
projection cache, so a previously issued grant cannot retain a silently changed
tool.

Custom connector deletion removes the LiteLLM server and its catalog metadata.
Built-in connectors cannot be deleted through the administration API.

### Managed model providers

For the boundary between Control's provider lifecycle, LiteLLM's encrypted
credential and dynamic route records, workspace virtual keys, governed Auto,
and MCP grants, see [LiteLLM gateway
architecture](litellm-gateway-architecture.md).

OpenAI, Anthropic, GLM (Z.ai), and Amazon Bedrock are configured by an organization administrator in
**AI control plane → Models & providers**, not in `.env`. Control passes the
submitted write-only key directly to LiteLLM's private credential API. LiteLLM
encrypts the credential in its own database; LemmaComputer stores only
tenant-scoped route IDs, selected model IDs, lifecycle state, timestamps, and a
safe HMAC fingerprint.

OpenAI, Anthropic, and Z.ai allow the administrator to choose one or more models
from a reviewed product inventory. Bedrock uses a reviewed region and inference
profile pair. Each inventory item declares vision, tool, and streaming support;
the Model routes editor inherits those provider-sourced flags and combines them
with reviewed route context/output limits and residency metadata instead of
guessing capabilities from display names.

The dynamic routes retain compatibility aliases required by signed policy and
managed clients, while governed service-class workspaces receive only the
synthetic `lemmacomputer-auto` transport alias. Every concrete model deployment
is bound to a tenant-specific LiteLLM access group, so a virtual workspace key
cannot select another organization's deployment. The current reviewed model
and alias inventory in
`packages/litellm-adapter/src/provider-settings.ts` is the source of truth; do
not duplicate it in operator configuration.

Provider health is necessary but not sufficient for governed routing. Pricing,
an immutable Lite/Balanced/Pro mapping, a Team policy, and a rollout mode are
separate Control records managed in the adjacent AI control-plane tabs.

The static OpenAI, Anthropic, and GLM YAML routes and provider environment variables are
retired. During the cutover, keep the LiteLLM salt and credential secret stable,
back up both databases, deploy the new configuration, then sign in as an
administrator to configure and test each provider. A stale static route makes
Control fail closed with `PROVIDER_STATIC_CUTOVER_REQUIRED`; remove it and
restart LiteLLM rather than attempting to mix static and managed routes.

A candidate key is tested through temporary LiteLLM credentials and routes
before the stable route changes. Rotation validates the current tenant route
before replacing the encrypted credential. Disabling or deleting a provider
removes its routes, revokes affected workspace grants, and requires affected
workspaces to restart.

For rollback, restore the Control database, LiteLLM database, and the matching
LiteLLM encryption secrets as one set. Rolling back only an image can leave
dynamic model records or encrypted credentials incompatible with the old static
configuration.

### Hosted LiteLLM administration transport

The production-profile capability matrix and matching customer-managed
preflight are documented in [Deployment profiles](deployment-profiles.md). The
matrix is configuration policy, not user authorization; hosted routes and
workers still require organization-scoped RBAC.

Hosted deployments must use the dedicated mutual-TLS administration listener,
not the gateway's workspace-facing endpoint:

```bash
npm run env:check -- --profile=hosted
npm run env:render -- --profile=hosted
docker compose config --quiet
docker compose up -d --wait
```

Set `LEMMACOMPUTER_INSTALLATION_KIND=hosted` and
`LEMMACOMPUTER_LITELLM_ADMIN_URL=https://litellm-admin-listener:8443` in the
deployment environment. `compose.hosted.yaml` remains a compatibility marker
only; it deliberately does not select a profile or override a security value.
The listener is bound only to the
internal `litellm-admin-private` network alias, and its proxy can reach the
LiteLLM upstream without exposing the listener to workspace traffic. It accepts
only a client certificate issued to the `lemmacomputer-control` workload identity.

Inject the following as base64-encoded PEM from the deployment secret manager:

- `LEMMACOMPUTER_LITELLM_ADMIN_TLS_CA_B64`
- `LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_CERT_B64` and
  `LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_KEY_B64`
- `LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_CERT_B64` and
  `LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_KEY_B64`

The server certificate must verify for
`LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_NAME` (normally
`litellm-admin-listener`), and the client certificate subject CN must match
`LEMMACOMPUTER_LITELLM_ADMIN_CLIENT_COMMON_NAME` (normally
`lemmacomputer-control`). Hosted startup refuses HTTP, missing or malformed mTLS
material, and any reuse of `LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET` as a session
or workspace-ingress secret. The proxy rejects missing client certificates at
the TLS handshake and rejects a certificate for a different workload identity.

For an upgrade from an older installation, run `npm run env:update`, put three
independent values in `LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET`,
`LEMMACOMPUTER_SESSION_SECRET`, and
`LEMMACOMPUTER_WORKSPACE_INGRESS_SECRET`, then run the hosted profile preflight. Do not
rotate the credential-derivation secret merely to rotate sessions or ingress;
those values are intentionally separate now.

### Stable cryptographic material

These values must remain stable while their dependent state exists:

- policy signing private key and verification-key set;
- OpenVTC executor seed;
- session and workspace-ingress secrets;
- LiteLLM salt and credential-derivation secret;
- channel credential encryption secret;
- schedule-prompt encryption secret;
- egress grant and agent-chat derivation secrets;
- Web Push subscription encryption secret.

Loss or blind replacement can invalidate signed bundles, enrolled approvers,
sessions, OAuth custody, stored channel credentials, or running workspaces.
Back these values up through an approved secret manager.

### Sandbox driver

`LEMMACOMPUTER_SANDBOX_DRIVER=kasm-local` uses the host Docker Engine. Build the workspace
image first:

```bash
npm run image:workspace
```

`LEMMACOMPUTER_WORKSPACE_IMAGE` may be a local tag for development. Production
deployments should use an immutable digest.

Claude Cowork local execution requires hardware virtualization. On every Docker
or Kasm Agent host, verify that `/dev/kvm` and `/dev/vhost-vsock` are character
devices and that the host has at least 8 GB of RAM and approximately 25 GB of
free disk space. The local driver gives Cowork workspaces an 8 GiB memory limit;
allow additional host memory for Docker and the LemmaComputer services. Opt in
with:

```text
LEMMACOMPUTER_KASM_LOCAL_KVM_ENABLED=true
```

The local driver accepts this setting for customer-managed installations and
isolated development worktrees. Hosted multi-tenant installations fail closed
with `COWORK_HOST_ISOLATION_REQUIRED`. The adapter
maps only `/dev/kvm` and `/dev/vhost-vsock` into workspaces that include Claude
Desktop; it does not make the container privileged or restore dropped
capabilities. Cowork containers use the pinned Moby `seccomp/v0.2.1` default
allowlist with one additional rule permitting only `socket(AF_VSOCK)`, which
Claude's local execution VM requires. The base profile SHA-256 is
`536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`.
AF_ALG and the other address families excluded by Moby remain blocked;
AppArmor, `no-new-privileges`, capability drops, scoped device access, PID
limits, and memory limits also remain active. At startup, the image adds
`kasm-user` to the numeric groups that own the mapped devices and verifies
AF_VSOCK socket creation before launching the desktop, so host and image group
IDs do not need to match. Changing this setting recreates the workspace
container on its next launch while preserving its workspace volume.

For an external Kasm installation, configure the LemmaComputer Workspace image's
Docker Run Config Override in Kasm:

```json
{
  "user": "root",
  "devices": [
    "/dev/kvm:/dev/kvm:rwm",
    "/dev/vhost-vsock:/dev/vhost-vsock:rwm"
  ],
  "memory": 8589934592,
  "environment": {"LEMMACOMPUTER_COWORK_ENABLED": "true"}
}
```

The local adapter sends the scoped profile to Docker directly. External Kasm
operators must configure an equivalent custom seccomp profile on eligible
agents that adds only AF_VSOCK to the default allowlist; do not disable seccomp
for the Workspace. The image startup preflight rejects a session when the
required socket is still blocked.

Every Kasm Agent eligible to run this Workspace must expose both devices.
Mapping KVM and vhost-vsock gives the workspace access to host virtualization
interfaces, so keep the override limited to the Claude Desktop Workspace image.
Use dedicated, single-tenant Kasm Agents and enforce that placement in the Kasm
scheduler; do not place this override on a shared multi-tenant agent.

For an external Kasm installation, set:

```text
LEMMACOMPUTER_SANDBOX_DRIVER=kasm
LEMMACOMPUTER_KASM_BASE_URL=https://kasm.example.com
LEMMACOMPUTER_KASM_API_KEY=...
LEMMACOMPUTER_KASM_API_SECRET=...
LEMMACOMPUTER_KASM_USER_ID=...
LEMMACOMPUTER_KASM_IMAGE_ID=...
```

Remove the Docker socket mount from the controller when using the remote
adapter.

`LEMMACOMPUTER_KASM_LOCAL_STARTUP_TIMEOUT_MS` controls how long the local adapter waits for
the managed runtime readiness marker. The default is 60 seconds and the
accepted range is 5–300 seconds. Increase it only when measured image/host
startup needs more time; do not use it to hide an entrypoint, resource, policy,
or device preflight failure. Release verification performs a real Hermes
workspace create/readiness/destroy smoke against the built image.

## Start and stop

Validate interpolation and schema before any mutation:

```bash
npm run env:check
npm run compose:config
```

Start and wait for health:

```bash
npm run compose:up
```

Compose runs the one-shot `db-migrate` job after PostgreSQL becomes healthy and
starts `control-api` only after the job succeeds. Control performs a read-only
schema compatibility check and never migrates during application startup.

The workspace build is intentionally not part of normal `up`; it is a build
profile and not a service. Rebuild it explicitly after changing its Dockerfile
or assets.

Stop every active workspace through LemmaComputer before stopping the control
stack. Then stop Compose containers while retaining state:

```bash
npm run compose:down
```

The npm command checks for sandbox, relay, and egress runtime containers and
refuses shutdown if any remain. This prevents Compose from disappearing while a
workspace still depends on the control network and ensures workspace state and
runtime grants are updated through the product lifecycle.

Pull pinned upstream images and rebuild owned images:

```bash
docker compose pull --ignore-buildable
docker compose build --pull
docker compose up -d --wait --wait-timeout 300
```

Review upstream version and digest changes before updating pins.

## Health and diagnostics

```bash
docker compose ps
docker compose logs --since=10m db-migrate
docker compose logs --since=10m control-api
docker compose logs --since=10m workspace-controller
docker compose logs --since=10m litellm
```

Expected health endpoints:

| Service | Endpoint |
| --- | --- |
| workspace ingress | `${LEMMACOMPUTER_PUBLIC_WEB_URL}/__lemmacomputer/healthz` |
| Web, private | `http://web:4173/healthz` |
| Control, private | `http://control-api:4100/healthz` |
| controller, private | `http://workspace-controller:4101/healthz` |
| channel broker, private | `http://channel-broker:4102/healthz` |
| scheduler worker, private | `http://scheduler-worker:4103/healthz` |
| OpenVTC, private | `http://openvtc-consent:8788/healthz` |
| LiteLLM, private | `http://litellm:4000/health/liveliness` |

Health confirms process readiness, not a successful provider request,
Microsoft consent, active policy assignment, or a built workspace image.

Common failures:

- **Control stays unhealthy:** inspect required environment validation,
  database schema compatibility or migration-job failure, policy key parsing, and OpenVTC profile connection.
- **Workspace startup times out:** inspect the sandbox container and its
  readiness marker, image architecture, host capacity, signed policy, selected
  agent initialization, and any Cowork device/seccomp preflight before changing
  `LEMMACOMPUTER_KASM_LOCAL_STARTUP_TIMEOUT_MS`.
- **LiteLLM stays unhealthy:** inspect its database, master/salt keys, mounted
  YAML, and custom callback import.
- **Workspace creation fails with image not found:** run
  `npm run image:workspace` and verify `LEMMACOMPUTER_WORKSPACE_IMAGE`.
- **Workspace opens but ingress returns 502:** inspect the dynamic relay,
  `lemmacomputer-control` membership, and the ingress logs.
- **MCP calls return policy unavailable:** verify Control health and the shared
  controller/policy callback token.
- **Microsoft connection callback fails:** verify the canonical public origin,
  exact `/oauth/mcp/callback` Entra redirect URI, `/m365/authorize` ingress
  route, Web client type, tenant, and clock. Do not expose LiteLLM or the M365
  bridge as a workaround.

Do not enable verbose gateway request/response logging to diagnose production
traffic. Correlate safe error codes and operation IDs instead.

## Persistence

Compose manages:

- `lemmacomputer_control-data` for Control PostgreSQL;
- `lemmacomputer_gateway-data` for LiteLLM PostgreSQL.

The local sandbox adapter creates separately labeled volumes named
`lemmacomputer-sandbox-<workspace UUID>`. Compose does not own or delete them.

List owned workspace volumes:

```bash
docker volume ls --filter label=com.lemmacomputer.runtime=workspace-home
```

Normal `npm run compose:down` retains all state.
`npm run compose:down -- --volumes` deletes both database volumes but still
leaves workspace home volumes. Both commands require all workspaces to be
stopped first. Purge a workspace through the product/API so Control and provider
state remain consistent.

## Backup and restore

Back up these as one recovery set:

1. Control PostgreSQL;
2. LiteLLM PostgreSQL;
3. per-workspace persistent volumes;
4. the exact secret-manager versions active at backup time;
5. immutable control and workspace image digests.

Example logical database backups:

```bash
docker compose exec -T postgres \
  pg_dump --username lemmacomputer --dbname lemmacomputer --format=custom \
  > lemmacomputer-control.dump

docker compose exec -T litellm-postgres \
  pg_dump --username litellm --dbname litellm --format=custom \
  > lemmacomputer-gateway.dump
```

Protect backups as credentials: they contain identity, governance, operation,
OAuth, and audit state. Test restore in an isolated environment. Restore
databases and matching cryptographic material before starting Control or
LiteLLM.

## Rotation

Rotation is not equivalent to regenerating `.env`.

- Rotate provider keys in LiteLLM and revoke the prior provider credential
  after route verification.
- Rotate Entra client secrets with an overlap window.
- Rotate service tokens by deploying consumers and producers with a
  dual-acceptance window where supported.
- Rotate policy signing keys by publishing the new public key alongside the old
  verification key, switching the active signer, waiting for the maximum bundle
  TTL, and only then retiring the old key.
- Rotating the OpenVTC executor seed changes executor identity and requires a
  trust re-enrollment design.
- Rotating encryption keys requires decrypt-and-reencrypt migration; replacing
  them directly makes stored credentials unreadable.

## Production considerations

The reference Compose stack is not a production security perimeter by itself.
Before network exposure:

- terminate TLS at an authenticated reverse proxy;
- publish only the product origin and intentionally designed OAuth routes;
- protect or disable the LiteLLM administrator UI;
- replace loopback callback URLs with reviewed HTTPS origins;
- use an external secret manager rather than environment files;
- use managed PostgreSQL with encryption, backup, monitoring, and restricted
  roles;
- use the remote Kasm adapter and remove the Docker socket;
- configure trusted TLS between ingress and workspace relays;
- isolate egress networks with host/cloud firewall policy;
- give LiteLLM no direct NAT/Internet route; use separate model and remote-MCP
  proxies, and make the remote-MCP client ignore environment proxy bypasses
  for discovery, OAuth, tool calls, and redirects;
- restrict the model proxy to exact model-provider hosts and the remote-MCP
  proxy to Control-approved public origins; cloud security groups/NACLs and a
  controlled egress firewall must deny VPC, metadata, loopback, link-local,
  ULA, and other private destinations even if application code regresses;
- in hosted mode, populate `LEMMACOMPUTER_HOSTED_MCP_EGRESS_ORIGINS` from an
  IT-reviewed inventory before rollout, including every existing custom
  endpoint plus every OAuth/metadata/token/registration origin; do not use a
  tenant administrator's connector record as a cloud egress allowlist;
- restrict the proxy-to-Control authorization endpoint to its private network,
  use its dedicated secret (and workload mTLS/service-mesh identity in cloud),
  and alert on denied proxy decisions;
- send safe audit events to an append-protected sink;
- define log retention, data residency, incident response, and key rotation;
- validate resource limits for every service and workspace;
- use immutable images, an SBOM, vulnerability scanning, and signed release
  artifacts.

The published ports default to `127.0.0.1` specifically to prevent accidental
LAN exposure. Do not change `LEMMACOMPUTER_HTTP_BIND_ADDRESS` to `0.0.0.0`
without the controls above.

For a concrete AWS mapping of these requirements, see [AWS deployment
architecture](deployment/aws-deployment.md).
