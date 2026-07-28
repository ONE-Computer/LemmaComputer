# Configuration and operations

The root `compose.yaml` is the reference deployment for a single-host
development or evaluation environment. It replaces layered infrastructure
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

The initializer reads `.env.example`, generates local cryptographic material,
writes the result with mode `0600`, and refuses to replace an existing file.
Use `--force` only when intentionally invalidating all current local sessions,
policy signatures, approvals, encrypted credentials, and service trust:

```bash
npm run env:init -- --force
```

For an alternate path:

```bash
npm run env:init -- --file=/absolute/path/to/onecomputer.env
docker compose --env-file /absolute/path/to/onecomputer.env config --quiet
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

## Environment variable groups

### Public routing

| Variable | Default | Purpose |
| --- | --- | --- |
| `ONECOMPUTER_HTTP_BIND_ADDRESS` | `127.0.0.1` | Host bind address for all published ports |
| `ONECOMPUTER_WEB_PORT` | `4174` | Product and workspace-ingress port |
| `ONECOMPUTER_LITELLM_PORT` | `4000` | LiteLLM UI and OAuth callback port |
| `ONECOMPUTER_M365_PORT` | `4311` | Microsoft connector authorization bridge |
| `ONECOMPUTER_PUBLIC_WEB_URL` | `http://localhost:4174` | Canonical product origin and Entra callback base |
| `ONECOMPUTER_LITELLM_PUBLIC_URL` | `http://localhost:4000` | Canonical gateway callback base |
| `ONECOMPUTER_M365_AUTHORIZATION_ORIGIN` | `http://localhost:4311` | Browser-facing connector origin |

The three URLs and port mappings must describe the same externally observed
origins. Changing `ONECOMPUTER_PUBLIC_WEB_URL` or
`ONECOMPUTER_LITELLM_PUBLIC_URL` requires updating the corresponding Entra
redirect URI. The Microsoft authorization origin must remain reachable by the
browser but is not itself an Entra redirect URI.

### Identity and bootstrap

| Variable | Required | Purpose |
| --- | --- | --- |
| `ONECOMPUTER_ENTRA_TENANT_ID` | Yes | Single Entra directory accepted for Web sign-in |
| `ONECOMPUTER_ENTRA_CLIENT_ID` | Yes | Web OIDC application |
| `ONECOMPUTER_ENTRA_CLIENT_SECRET` | Yes | Web OIDC confidential-client secret |
| `ONECOMPUTER_ADMINISTRATOR_EMAILS` | Yes | Comma-separated bootstrap administrators |
| `ONECOMPUTER_BOOTSTRAP_TENANT_ID` | No | Owned tenant identifier |
| `ONECOMPUTER_BOOTSTRAP_USER_ID` | No | Owned ID for a bootstrap administrator |
| `ONECOMPUTER_TENANT_DISPLAY_NAME` | No | Initial organization display name |

Administrator email matching is case-insensitive. Keep the allowlist small.
After identity records and assignments exist, changing bootstrap identifiers
does not migrate existing rows.

Every user in the configured Entra directory may sign in. Control creates their
owned user and workspace records just in time and assigns the default employee
policy on first sign-in. An administrator can later suspend or reactivate the
user, revoke their active sessions, change their policy assignment, and manage
their sandbox and egress security-group configuration. A returning user does
not automatically regain a policy that an administrator revoked.

### Microsoft 365

`ONECOMPUTER_MS365_TENANT_ID`, `ONECOMPUTER_MS365_CLIENT_ID`, and
`ONECOMPUTER_MS365_CLIENT_SECRET` are optional as a group. Empty values reuse
the Web Entra application. A separate connector application is recommended for
production because it isolates Graph scopes and credential rotation.

The connector requests only the fixed scope list in `compose.yaml`. Tenant
administrators should review those scopes against the enabled tool allowlist.
See [Configure Microsoft Entra](local-deployment.md#configure-microsoft-entra)
for the exact local redirect URIs and delegated permission list.

### Hosted MCP connectors

Notion, Linear, and Atlassian use their official hosted MCP endpoints and
dynamic OAuth client registration. GitHub requires an OAuth app because its
authorization server does not expose dynamic client registration. Configure
`ONECOMPUTER_GITHUB_MCP_CLIENT_ID` and
`ONECOMPUTER_GITHUB_MCP_CLIENT_SECRET`, with the LiteLLM callback
`${ONECOMPUTER_LITELLM_PUBLIC_URL}/callback` registered in GitHub.

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

Custom connector deletion removes the LiteLLM server and its catalog metadata.
Built-in connectors cannot be deleted through the administration API.

### Model providers

| Variable | Route |
| --- | --- |
| `ONECOMPUTER_OPENAI_API_KEY` | `onecomputer-assistant`, `onecomputer-openai` |
| `ONECOMPUTER_CLAUDE_API_KEY` | `onecomputer-claude` |
| `ONECOMPUTER_GLM_API_KEY` | `onecomputer-glm` |

Only LiteLLM receives these variables. A route can remain unconfigured until
policy assigns it, but the default bootstrap policy expects configured model
routes. Remove unlicensed routes from both policy and gateway configuration.

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

`SANDBOX_DRIVER=kasm-local` uses the host Docker Engine. Build the workspace
image first:

```bash
npm run image:workspace
```

`ONECOMPUTER_WORKSPACE_IMAGE` may be a local tag for development. Production
deployments should use an immutable digest.

For an external Kasm installation, set:

```text
SANDBOX_DRIVER=kasm
KASM_BASE_URL=https://kasm.example.com
KASM_API_KEY=...
KASM_API_SECRET=...
KASM_USER_ID=...
KASM_IMAGE_ID=...
```

Remove the Docker socket mount from the controller when using the remote
adapter.

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

The workspace build is intentionally not part of normal `up`; it is a build
profile and not a service. Rebuild it explicitly after changing its Dockerfile
or assets.

Stop every active workspace through ONEComputer before stopping the control
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
docker compose logs --since=10m control-api
docker compose logs --since=10m workspace-controller
docker compose logs --since=10m litellm
```

Expected health endpoints:

| Service | Endpoint |
| --- | --- |
| workspace ingress | `http://localhost:4174/__onecomputer/healthz` |
| Web, private | `http://web:4173/healthz` |
| Control, private | `http://control-api:4100/healthz` |
| controller, private | `http://workspace-controller:4101/healthz` |
| channel broker, private | `http://channel-broker:4102/healthz` |
| scheduler worker, private | `http://scheduler-worker:4103/healthz` |
| OpenVTC, private | `http://openvtc-consent:8788/healthz` |
| LiteLLM | `http://localhost:4000/health/liveliness` |

Health confirms process readiness, not a successful provider request,
Microsoft consent, active policy assignment, or a built workspace image.

Common failures:

- **Control stays unhealthy:** inspect required environment validation,
  database schema compatibility or migration-job failure, policy key parsing, and OpenVTC profile connection.
- **LiteLLM stays unhealthy:** inspect its database, master/salt keys, mounted
  YAML, and custom callback import.
- **Workspace creation fails with image not found:** run
  `npm run image:workspace` and verify `ONECOMPUTER_WORKSPACE_IMAGE`.
- **Workspace opens but ingress returns 502:** inspect the dynamic relay,
  `onecomputer-control` membership, and the ingress logs.
- **MCP calls return policy unavailable:** verify Control health and the shared
  controller/policy callback token.
- **Microsoft connection callback fails:** verify all three public origins,
  Entra redirect URIs, client type, tenant, and clock.

Do not enable verbose gateway request/response logging to diagnose production
traffic. Correlate safe error codes and operation IDs instead.

## Persistence

Compose manages:

- `onecomputer_control-data` for Control PostgreSQL;
- `onecomputer_gateway-data` for LiteLLM PostgreSQL.

The local sandbox adapter creates separately labeled volumes named
`onecomputer-sandbox-<workspace UUID>`. Compose does not own or delete them.

List owned workspace volumes:

```bash
docker volume ls --filter label=com.onecomputer.runtime=workspace-home
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
  pg_dump --username onecomputer --dbname onecomputer --format=custom \
  > onecomputer-control.dump

docker compose exec -T litellm-postgres \
  pg_dump --username litellm --dbname litellm --format=custom \
  > onecomputer-gateway.dump
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
- send safe audit events to an append-protected sink;
- define log retention, data residency, incident response, and key rotation;
- validate resource limits for every service and workspace;
- use immutable images, an SBOM, vulnerability scanning, and signed release
  artifacts.

The published ports default to `127.0.0.1` specifically to prevent accidental
LAN exposure. Do not change `ONECOMPUTER_HTTP_BIND_ADDRESS` to `0.0.0.0`
without the controls above.
