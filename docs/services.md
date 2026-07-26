# Service reference

This document describes the processes that make up ONEComputer and the
contracts between them. Ports are container ports unless explicitly described
as host bindings.

## Runtime inventory

| Process | Source/configuration | Port | State owner |
| --- | --- | --- | --- |
| Workspace ingress | `apps/workspace-ingress` | `4174` | Stateless; HMAC session authority |
| Web | `apps/web` | `4173` | Stateless |
| Control API | `apps/control-api` | `4100` | Control PostgreSQL |
| Workspace controller | `apps/workspace-controller` | `4101` | Sandbox provider plus Control records |
| Channel broker | `apps/channel-broker` | `4102` | Control PostgreSQL |
| Egress proxy | `apps/egress-proxy` | `3128` | Stateless; signed launch projection |
| Gateway fixture | `apps/gateway-fixture` | `4200` | In-memory, test/qualification only |
| OpenVTC consent | `apps/openvtc-consent` | `8788` | Stateless executor key |
| LiteLLM | `config/litellm` and `integrations/litellm` | `4000` | Gateway PostgreSQL |
| Microsoft 365 MCP | pinned Softeria image | `3000` | OAuth session through gateway integration |

## Workspace ingress

**Source:** `apps/workspace-ingress/src/server.ts` and
`packages/workspace-ingress-auth`

Workspace ingress is the only product-origin port published by the reference
stack. Requests outside `/workspaces/:workspaceId/` proxy to the Web service.
Workspace routes proxy HTTP and WebSocket traffic to a Kasm relay.

Control replaces a raw controller launch URL with an HMAC-signed, short-lived
launch token. Ingress:

1. validates the token and workspace path;
2. exchanges it for an HttpOnly, workspace-path-scoped session cookie;
3. redirects to remove the launch token from the URL;
4. verifies the session on every HTTP and WebSocket request;
5. routes only to the host/protocol/port embedded in the signed claims.

Important configuration:

- `WORKSPACE_INGRESS_PUBLIC_URL`
- `WORKSPACE_INGRESS_WEB_UPSTREAM`
- `WORKSPACE_INGRESS_SECRET`
- launch and session TTLs
- `WORKSPACE_INGRESS_VERIFY_UPSTREAM_TLS`

The reference local relay has a self-signed certificate, so Compose disables
upstream verification. A production relay should use a trusted private CA and
enable verification.

**Extension seam:** extend claim fields in
`packages/workspace-ingress-auth` first, version the token format, update both
issuer and verifier, then add negative tests for path, target, expiry, and
cross-workspace replay. Do not accept an arbitrary upstream from a request.

## Web

**Source:** `apps/web`

The React application is built by `docker/Dockerfile.node`. The production
container runs `apps/web/server.mjs`, a small static server that:

- serves the compiled single-page application;
- proxies `/api/*` to Control after removing the `/api` prefix;
- adds the internal `x-onecomputer-proxy-token`;
- streams Control responses without buffering;
- does not expose the proxy token to browser JavaScript.

Vite remains the development server. Its proxy implements the same prefix and
header behavior.

**Extension seam:** browser API calls belong in `apps/web/src/workspace-api.js`
and should consume schemas returned by Control. Do not call internal services,
LiteLLM data APIs, the Docker daemon, or MCP servers directly from the browser.
New top-level product routes must continue to work behind workspace ingress and
the single product origin.

## Control API

**Source:** `apps/control-api`

Control is the policy authority and orchestrator. Its main responsibilities
are:

- Entra authentication, owned identity mapping, and session management;
- immutable policy versions and assignments;
- sandbox settings constrained by effective policy;
- signed effective-policy bundle issuance;
- workspace lifecycle and readiness;
- scoped LiteLLM grant creation and revocation;
- Microsoft 365 OAuth connection orchestration;
- MCP per-call authorization;
- governed-operation creation, consent, execution leases, and receipts;
- OpenVTC enrollment, inbox, companion push, and decision handling;
- agent chat routing;
- external-channel credential and route management;
- administrator egress and MCP policy APIs.

### Interfaces

Public product routes use `/v1/*` and are reached through Web at `/api/v1/*`.
The notable unauthenticated or separately authenticated endpoints are:

- `/v1/auth/login` and `/v1/auth/callback` for Entra;
- `/v1/openvtc/inbox` and `/trust-tasks` for OpenVTC transport-token access;
- `/healthz`.

Internal callers use:

- `POST /internal/v1/mcp/authorize` from the LiteLLM callback;
- `POST /internal/v1/channels/routes/validate` from the channel broker;
- `POST /internal/v1/channels/turns` from the channel broker.

The internal MCP route requires `x-onecomputer-mcp-policy-token`. Channel routes
require `x-onecomputer-channel-token`. Product requests require both the Web
proxy boundary and an authenticated employee session, except for the explicit
flows above.

### Startup contract

Control validates all environment variables, migrates the database, registers
policy verification keys, connects to OpenVTC, constructs the signing
authority, and starts listening only after its required dependencies are
usable. Partial configuration of LiteLLM, OpenVTC, Web Push, ingress, or the
channel broker is rejected.

### Logging

Fastify redacts authorization headers, internal tokens, request bodies, MCP
arguments, policy signatures, and launch URLs. OAuth callback request logging
is disabled because the URL contains a one-time code.

**Extension seam:** add schemas to `packages/contracts`, domain logic to a
focused Control module, persistence to the store interface and PostgreSQL
implementation, and a thin route in `server.ts`. Identity must come from the
authenticated request, never a user-supplied tenant or subject field. New
side-effecting capabilities must pass through the MCP policy and governed
operation path.

## Workspace controller

**Source:** `apps/workspace-controller` and `packages/kasm-adapter`

The controller exposes a token-authenticated internal lifecycle API:

- create a sandbox from a signed policy projection;
- inspect status;
- produce a launch target;
- destroy the runtime;
- purge persistent workspace storage.

It verifies the Ed25519 policy bundle and checks that gateway, agent, chat,
application, and egress grants match the verified projection before invoking an
adapter.

Two adapters implement the `SandboxAdapter` boundary:

- `kasm-local` uses the Docker Engine API for a self-contained deployment;
- `kasm` uses the Kasm Developer API for an external Kasm installation.

The local adapter creates deterministic container, network, volume, relay, and
egress-sidecar resources labeled with workspace and policy identities. The
controller requires the Docker socket only in this mode. Treat that socket as
host-root-equivalent authority.

**Extension seam:** implement `SandboxAdapter`, preserve the public sandbox
state and launch contracts, verify signed policy before provisioning, and keep
provider-specific identifiers internal. A remote adapter should return a
private ingress target separately from the public launch URL.

## Managed workspace runtime

**Definition:** `docker/Dockerfile.workspace` and the runtime assets copied by
that image

The image contains KasmVNC, Firefox, Chrome, Claude Desktop, Claude CLI, Codex
CLI, Hermes Agent CLI, and Hermes Desktop. Software and source archives are
version- and checksum-pinned.

At launch, the root-owned entrypoint:

- verifies the signed runtime policy;
- materializes only the selected desktop entries;
- writes managed browser and AI-client policy;
- starts one loopback credential broker per selected agent;
- starts the agent-neutral chat bridge for supported CLI agents;
- configures Kasm clipboard direction and size;
- writes a readiness marker only after the projected runtime is ready.

The user's persistent home is mounted from a dedicated volume. Credentials and
signed policy material are injected as runtime environment, consumed by
root-owned processes, and not written into the user profile.

**Extension seam:** adding an application or agent requires coordinated changes
to the contract catalog, image, entrypoint allowlist, policy projection, UI
catalog, and tests. See [Adding a sandbox application or agent](extending.md#add-a-sandbox-application-or-agent).

## Egress proxy

**Source:** `apps/egress-proxy` and `packages/egress-policy`

The controller starts this process as a per-workspace sidecar only when an
egress security group is assigned. It supports HTTP proxy requests and HTTPS
`CONNECT`, reads TLS SNI before tunneling, and evaluates normalized host,
protocol, port, and resolved IP addresses.

Runtime inputs are:

- `EGRESS_POLICY_JSON`, an immutable security-group version;
- `EGRESS_EXPECTED_GRANT_JSON`, the bound tenant/workspace/agent/policy claims;
- `EGRESS_GRANT_SECRET`;
- `EGRESS_PROXY_PORT`.

Proxy authentication carries the signed grant. The sidecar joins the internal
workspace network and a dedicated internet-routed network; the sandbox joins
only the internal side.

**Extension seam:** protocol or rule changes belong in
`packages/egress-policy` as pure normalization/decision logic, followed by
transport enforcement in `apps/egress-proxy`. Add tests for DNS rebinding,
private ranges, IPv4/IPv6, malformed hosts, SNI mismatch, and deny-by-default
behavior.

## LiteLLM gateway

**Configuration:** `config/litellm/config.yaml`

**ONEComputer callback:** `integrations/litellm/onecomputer_policy_callback.py`

LiteLLM is the model and MCP data plane. Control uses its administrator API to
create deterministic virtual credentials with:

- tenant/user/workspace/agent metadata;
- exactly one model alias;
- exactly one MCP server and explicit tool allowlist;
- expiry;
- budget, RPM, TPM, and parallel-request limits;
- effective policy identifier and hash.

The custom callback checks image support on model calls. Before every resolved
Microsoft 365 tool dispatch, it requires the exact expected MCP server binding
and asks Control for an allow, deny, or approval-required decision. If Control
is unavailable or returns malformed data, the callback fails closed.

Raw prompt/response logging is disabled. Uvicorn access logging is suppressed
for OAuth callback safety.

**Extension seam:** stable policy aliases belong in the model list. Adding a
provider also requires the contract model catalog, Control display catalog,
bootstrap policy, and possibly a managed-client transport alias. Adding an MCP
server requires a callback binding and Control capability policy; a LiteLLM
configuration entry alone is not sufficient.

## Microsoft 365 MCP

**Image definition:** `docker/Dockerfile.ms365-mcp`

The connector is a pinned build of `@softeria/ms-365-mcp-server`. Compose starts
it in organization mode with:

- a fixed regex allowlist of Mail, Calendar, OneDrive, and Teams tools;
- a fixed OAuth scope list;
- dynamic client registration disabled;
- bounded pagination and item counts;
- PII redaction enabled;
- connector confirmation required for writes;
- a read-only filesystem and capability drop.

The connector is reachable by LiteLLM on `gateway-private`. Its browser
authorization endpoint is published on loopback for the reference deployment;
token exchange remains private.

**Extension seam:** pin and review connector upgrades, update the Compose tool
allowlist, LiteLLM `allowed_tools`, `m365ToolCatalog`, canonical tool schemas,
policy defaults, and tests together. Tool names and argument schemas are
security identifiers, not display metadata.

## OpenVTC consent

**Source:** `apps/openvtc-consent`

This Rust service isolates the OpenVTC executor key and protocol implementation
from the main Control process. Its authenticated API:

- exposes the executor profile;
- signs task-consent requests;
- verifies approver enrollment documents;
- verifies task-consent decision documents.

`/healthz` is unauthenticated. All other routes require the internal consent
token. The executor seed is a 32-byte Ed25519 seed and must remain stable across
restarts or existing trust relationships become invalid.

Control, not the consent service, owns operation persistence, approver records,
delivery, execution leases, and receipts. This keeps the cryptographic protocol
boundary small and stateless.

**Extension seam:** protocol changes should be implemented against the OpenVTC
library in the Rust crate, with strict request/response schemas and interop
tests. Never make Control accept a decision solely because the document parses;
the consent service must verify proof, signer, audience, challenge, time, and
operation bindings.

## Channel broker

**Source:** `apps/channel-broker`

The broker is the only service with plaintext access to external-channel
credentials. A separate encryption secret protects stored credentials. An
internal token authenticates management calls from Control and route/turn calls
back to Control.

The current adapter polls Telegram, deduplicates update IDs in PostgreSQL,
checks sender/workspace routing with Control, supports per-sender agent and
session selection, forwards turns to the agent-neutral chat API, and returns
typing indicators or safe failures.

The broker has a dedicated egress network; workspaces never receive the bot
token or direct Telegram reachability.

**Extension seam:** implement a provider client and credential envelope inside
the broker, add owned connection schemas and migrations, require Control route
validation for every inbound identity, and persist provider delivery IDs for
idempotency. Provider webhooks need signature verification before parsing
content.

## PostgreSQL services

The control and gateway databases are deliberately separate.

`postgres` stores owned product and governance state. Migrations in
`packages/workspace-store/migrations` are run in numeric order by Control and
recorded in `onecomputer_schema_migrations`.

`litellm-postgres` is owned by LiteLLM. Control accesses gateway state only
through LiteLLM APIs and must not join directly against its schema.

**Extension seam:** add append-only numbered SQL migrations. Update both the
PostgreSQL store and its in-memory test implementation where an interface
changes. Migrations must be restart-safe and must not rewrite signed or hashed
historical records without an explicit compatibility design.

## Shared packages

| Package | Role |
| --- | --- |
| `@onecomputer/contracts` | Zod wire schemas, catalogs, error types, and shared domain types |
| `@onecomputer/workspace-store` | Store interfaces, PostgreSQL implementations, migrations, and policy derivation |
| `@onecomputer/policy-integrity` | Canonical policy signing and verification |
| `@onecomputer/litellm-adapter` | Gateway grants, OAuth orchestration, readiness, and governed execution |
| `@onecomputer/kasm-adapter` | Local Docker and Kasm Developer API sandbox adapters |
| `@onecomputer/egress-policy` | Host normalization, grant signing, policy compilation, and decisions |
| `@onecomputer/workspace-ingress-auth` | Launch/session claim issuance and verification |

Contracts should remain dependency-light and transport-oriented. Service
packages may depend on contracts; contracts must not depend on a runtime
service.
