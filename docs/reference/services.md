# Service reference

This document describes the processes that make up LemmaComputer and the
contracts between them. Ports are container ports unless explicitly described
as host bindings.

## Runtime inventory

| Process | Source/configuration | Port | State owner |
| --- | --- | --- | --- |
| Workspace ingress | `apps/workspace-ingress` | `4174` | Stateless; HMAC session authority |
| Web | `apps/web` | `4173` | Stateless |
| Control API | `apps/control-api` | `4100` | Control PostgreSQL |
| Workspace controller | `apps/workspace-controller` | `4101` | Sandbox provider plus Control records |
| Database migration job | `apps/control-api/src/migrate.ts` | None; one-shot | Control PostgreSQL migration ledger |
| Channel broker | `apps/channel-broker` | `4102` | Control PostgreSQL |
| Scheduler worker | `apps/scheduler-worker` | `4103` | Control PostgreSQL leases; no prompt access |
| Egress proxy | `apps/egress-proxy` | `3128` | Stateless; signed launch projection |
| Gateway fixture | `apps/gateway-fixture` | `4200` | In-memory, test/qualification only |
| OpenVTC consent | `apps/openvtc-consent` | `8788` | Stateless executor key |
| LiteLLM | `config/litellm` and `integrations/litellm` | `4000` | Gateway PostgreSQL |
| Microsoft 365 MCP | `docker/Dockerfile.ms365-mcp` and `integrations/ms365-mcp` | `3000` | OAuth session through gateway integration |

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
- adds the internal `x-lemmacomputer-proxy-token`;
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
- managed provider model inventory and capability projection;
- Team membership, default spend allocation, budgets, reservations, overrides,
  and projection reconciliation;
- immutable rate cards, governed routing mappings and policies, shadow reviews,
  rollout modes, decisions, observations, and deployment-health evidence;
- AI usage admission, normalized completion accounting, corrections,
  reconciliation, spend reporting, exports, and data-health baselines;
- Microsoft 365 OAuth connection orchestration;
- MCP per-call authorization;
- governed-operation creation, consent, execution leases, and receipts;
- OpenVTC enrollment, inbox, companion push, and decision handling;
- agent chat routing;
- encrypted agent scheduling and run dispatch;
- external-channel credential and route management;
- administrator egress and MCP policy APIs.

### Interfaces

Public product routes use `/v1/*` and are reached through Web at `/api/v1/*`.
The notable unauthenticated or separately authenticated endpoints are:

- `/v1/auth/customer/*` for embedded Better Auth customer signup, sign-in,
  verification, recovery, passkeys, social providers, and company SSO;
- `/v1/auth/login` and `/v1/auth/callback` for customer-managed workforce Entra;
- `/v1/auth/external-id/login` and `/v1/auth/external-id/callback` for hosted,
  invitation-bound transitional External ID;
- `/v1/openvtc/inbox` and `/trust-tasks` for OpenVTC transport-token access;
- `/healthz`.

Internal callers use:

- `POST /internal/v1/mcp/authorize` from the LiteLLM callback;
- `/internal/v1/ai-usage/routing/*` for governed route decision, binding
  verification, and observations;
- `/internal/v1/ai-usage/attempts/admit` and
  `/internal/v1/ai-usage/events` for fail-closed admission and completion;
- `POST /internal/v1/channels/routes/validate` from the channel broker;
- `POST /internal/v1/channels/turns` from the channel broker.

The internal MCP route requires `x-lemmacomputer-mcp-policy-token`. Routing and
usage routes require `x-lemmacomputer-ai-usage-token`. Channel routes require
`x-lemmacomputer-channel-token`. Product requests require both the Web proxy
boundary and an authenticated employee session, except for the explicit flows
above.

### Migration and startup contract

The one-shot `db-migrate` process holds the migration advisory lock, validates
the dependency/checksum ledger, and applies each pending migration in its own
transaction. Compose starts Control only after that job exits successfully.

Control itself never migrates. It validates all environment variables, asserts
that the database is at the exact compatible schema, registers policy
verification keys, connects to OpenVTC, constructs the signing and governance
authorities, and starts listening only after its required dependencies are
usable. Partial configuration of LiteLLM, OpenVTC, Web Push, ingress, AI usage,
routing, budgets, or the channel broker is rejected.

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

`DockerKasmVncAdapter` implements the boundary in both placements. It creates
deterministic container, network, volume, relay, and egress-sidecar resources
labeled with workspace, node, generation, and policy identities. The
controller and Docker socket remain node-local; remote Control uses the private
mTLS API. Treat the node socket as host-root-equivalent authority. See
[Workspace node deployment](workspace-node.md).

**Extension seam:** implement `SandboxAdapter`, preserve the public sandbox
state and launch contracts, verify signed policy before provisioning, and keep
provider-specific identifiers internal. A remote adapter should return a
private ingress target separately from the public launch URL.

## Managed workspace runtime

**Definition:** `docker/Dockerfile.workspace` and `docker/workspace`

The image contains KasmVNC, Firefox, Chrome, Claude Desktop, Claude CLI, Codex
CLI, Hermes Agent CLI, and Hermes Desktop. Software and source archives are
version- and checksum-pinned.

The Hermes payload also contains checksum-pinned copies of the official DOCX,
PDF, PowerPoint, XLSX, and OCR/document skills and their native, Python, Node,
and font dependencies. Telegram-originated deliverables written to the dedicated
`LemmaComputer/Outbox` are snapshotted into immutable, hash-verified runtime
artifacts; arbitrary workspace paths are never exported. When either Hermes client
is selected, the entrypoint
uses Hermes' bundled-skill manifest sync to seed its persistent profile.
Managed/restricted Hermes exposes the workspace-local file, terminal, skill,
and vision tools required by these workflows while keeping public-web and
unrelated native toolsets disabled. Disposable-open Hermes exposes its normal
CLI/API toolset. The optional multi-gigabyte `marker-pdf` OCR stack is not part
of the default image; PyMuPDF/PyMuPDF4LLM and Tesseract are.

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
catalog, and tests. See [Adding a sandbox application or agent](../guides/extending.md#add-a-sandbox-application-or-agent).

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

The Compose gateway runs two separate service-authenticated instances for
LiteLLM. The model proxy accepts only its static exact-host model-provider
allowlist. The remote-MCP proxy starts with an empty default-deny policy and
may ask Control about a normalized public MCP/OAuth destination. Strict remote
MCP clients explicitly use that second proxy with environment proxy bypasses
disabled, including for redirects; the private Microsoft connector stays on
its internal route. Neither gateway mode accepts workspace grants or a
full-web policy, both bound tunnel lifetime/idle time, and LiteLLM has no
direct internet-routed network attachment.

## LiteLLM gateway

**Configuration:** `config/litellm/config.yaml`

**LemmaComputer callback:** `integrations/litellm/lemmacomputer_policy_callback.py`

LiteLLM is the model and MCP data plane. Control uses its administrator API to
create deterministic virtual credentials with:

- tenant/user/workspace/agent metadata;
- exactly one governed transport alias for current service-class workspaces
  (`lemmacomputer-auto`), or one explicit compatibility route for a legacy
  direct-alias policy;
- one or more explicitly projected MCP servers with per-server tool allowlists;
- expiry;
- RPM and parallel-request limits, with token usage metered but not capped;
- effective policy identifier and hash.

For governed model calls, the custom callback accepts only
`lemmacomputer-auto`, derives bounded privacy-safe task signals, asks Control for
a concrete deployment, verifies the returned signed binding immediately before
execution, and admits the attempt to the ledger and Team budget. It strips
LemmaComputer authentication and governance metadata before provider dispatch,
normalizes provider usage after completion, and reports routing observations.
An admission or binding failure denies provider execution; completion
telemetry failure does not replace an already successful provider response and
instead leaves a visible reconciliation gap.

The same callback checks image support on model calls. Before every resolved
Microsoft 365 tool dispatch, it requires the exact expected MCP server binding
and asks Control for an allow, deny, or approval-required decision. If Control
is unavailable or returns malformed data, the callback fails closed.

Raw prompt/response logging is disabled. Uvicorn access logging is suppressed
for OAuth callback safety.

OpenAI, Anthropic, GLM (Z.ai), and Amazon Bedrock are managed providers. An administrator supplies a key
write-only through Control; LiteLLM encrypts it in its credential store and
holds tenant-scoped model records that reference only the credential name.
Control stores no raw key, checks a candidate route before activation, and
issues workspace keys only for that tenant's stable aliases and access groups.
Provider configuration exposes a reviewed model list and explicit capability
metadata to Control; route mappings consume that inventory rather than
guessing capabilities from display names. The static YAML contains gateway and
MCP policy but no managed provider models.

The gateway's administrator, workspace data, browser OAuth, and callback
interfaces use different credentials and trust boundaries. Control is the
routing, policy, approval, budget, and accounting authority; LiteLLM is the
credential custodian and execution point. See [LiteLLM gateway
architecture](../architecture/litellm-gateway.md) for the complete topology,
state-ownership table, grant lifecycles, sequences, and failure behavior.

**Extension seam:** adding a managed provider requires the contract model
catalog, Provider settings lifecycle, tenant-safe LiteLLM route projection,
Control display catalog, bootstrap policy, and possibly a managed-client
transport alias. Do not reintroduce a managed-provider key in Compose or
static YAML. Adding an MCP server requires a callback binding and Control
capability policy; a LiteLLM configuration entry alone is not sufficient.

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

The connector is reachable by LiteLLM on `gateway-private`. Browser
authorization enters through the canonical LemmaComputer origin at
`/m365/authorize`; the ingress relay forwards it over the private network and
the connector port is not published directly. Token exchange remains private.

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
typing indicators, safe failures, and bounded generated files through Telegram
`sendDocument`. Artifact downloads are re-authorized against the tenant, workspace,
sender, and assigned agent route, while the broker remains the only holder of the
Telegram credential. Incoming Telegram files are bounded by the hosted Bot API's
20 MB download ceiling (80 MB across a four-file turn). Generated files use
Telegram's 50 MB `sendDocument` ceiling and a 100 MB aggregate response limit.
The browser chat retains its separate 8 MB per-file and 16 MB aggregate limits.
Text and file delivery progress are retried durably without rerunning a completed
agent turn.

The broker has a dedicated egress network; workspaces never receive the bot
token or direct Telegram reachability.

Telegram credential setup is broker-only. Control authenticates the user and
issues a signed, single-use grant bound to the tenant, user, create-or-rotate
action, credential ID, idempotency key, and a 30–600 second expiry. The browser
encrypts the token to the broker's public key and sends the resulting envelope
through the Web edge directly to the broker. Control, the Web service, and the
workspace ingress do not receive a usable bot token; Control receives only the
safe credential status returned after broker validation.

The grant-signing private key is injected only into Control; the envelope
decryption private key is injected only into the broker. Existing encrypted
credentials remain usable. Before upgrading an existing deployment, run
`npm run env:update`, run the one-shot database migration, and deploy the
services together. Hosted deployments reject the deprecated raw-token routes
by default. Customer-managed deployments retain `legacy` raw input only as a
measured migration bridge; set `LEMMACOMPUTER_TELEGRAM_RAW_TOKEN_INPUT_MODE=reject`
after affected API clients have moved to the grant flow.

**Extension seam:** implement a provider client and credential envelope inside
the broker, add owned connection schemas and migrations, require Control route
validation for every inbound identity, and persist provider delivery IDs for
idempotency. Provider webhooks need signature verification before parsing
content.

## Scheduler worker

**Source:** `apps/scheduler-worker`

The scheduler polls Control PostgreSQL for due occurrences, claims each with a
bounded lease, and asks Control to dispatch the run through the existing
agent-chat path. It receives schedule and run identifiers plus opaque lease
tokens; encrypted prompt content is decrypted only inside Control.

The worker has no model-provider credentials, prompt-encryption secret, Docker
socket, or workspace-network access. Retries use persisted claim state so a
worker restart does not silently duplicate a completed occurrence.

**Extension seam:** keep scheduling state and lease transitions in the shared
store, keep prompt decryption and authorization in Control, and add concurrency
tests for duplicate claims, expired leases, disabled schedules, and policy
changes.

## PostgreSQL services

The control and gateway databases are deliberately separate.

`postgres` stores owned product and governance state. Migrations in
`packages/workspace-store/migrations` are dependency-ordered, checksummed, and
recorded in `lemmacomputer_schema_migrations` by the explicit one-shot migration job.
Control startup is read-only with respect to schema and fails closed when the ledger
is missing, behind, unknown, or changed.

`litellm-postgres` is owned by LiteLLM. Control accesses gateway state only
through LiteLLM APIs and must not join directly against its schema.

**Extension seam:** generate an append-only ULID SQL migration with `npm run db:migration:new -- <name>`. Update both the
PostgreSQL store and its in-memory test implementation where an interface
changes. Migrations must be restart-safe and must not rewrite signed or hashed
historical records without an explicit compatibility design.

## Shared packages

| Package | Role |
| --- | --- |
| `@lemmacomputer/contracts` | Zod wire schemas, catalogs, error types, and shared domain types |
| `@lemmacomputer/workspace-store` | Store interfaces, PostgreSQL implementations, migrations, and policy derivation |
| `@lemmacomputer/policy-integrity` | Canonical policy signing and verification |
| `@lemmacomputer/litellm-adapter` | Gateway grants, OAuth orchestration, readiness, and governed execution |
| `@lemmacomputer/model-router` | Deterministic service-class selection, candidate filtering, session affinity, and signed decision bindings |
| `@lemmacomputer/kasm-adapter` | Lemma-owned Docker/KasmVNC workspace runtime for colocated and remote nodes |
| `@lemmacomputer/egress-policy` | Host normalization, grant signing, policy compilation, and decisions |
| `@lemmacomputer/workspace-ingress-auth` | Launch/session claim issuance and verification |

Contracts should remain dependency-light and transport-oriented. Service
packages may depend on contracts; contracts must not depend on a runtime
service.
