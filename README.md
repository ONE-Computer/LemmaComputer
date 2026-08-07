# LemmaComputer

LemmaComputer is an enterprise control plane for governed AI workspaces. It gives
employees access to frontier AI applications inside persistent sandboxes while
keeping provider credentials, enterprise OAuth tokens, policy decisions, and
high-risk actions outside the user-controlled environment.

The project addresses shadow IT without reducing AI work to a small,
centrally-built chat interface:

- **Flexible sandboxes with external gateways.** Employees use familiar AI
  applications and agents in isolated desktops. Model traffic, MCP tools, and
  approved web destinations are reached through scoped gateways, so provider
  keys and enterprise credentials are never exposed to the sandbox user.
- **Governance through OpenVTC approvals.** Policy can allow, deny, or require a
  signed approval for individual capabilities. Critical Microsoft 365 actions
  are bound to their exact arguments, approved out of band, and executed once
  with a short-lived lease.
- **Governed model choice and spend.** Employees choose stable Auto, Lite,
  Balanced, or Pro service classes instead of provider model names. The
  administrator AI control plane manages provider deployments, immutable
  pricing, Team allocation and budgets, routing rollout evidence, usage-data
  health, and ledger-backed spend reporting without storing prompts or hidden
  reasoning.

The same tenant-scoped codebase supports `customer-managed` single-tenant and
LemmaComputer-operated `hosted` deployments. Deployment profiles change
configuration and infrastructure, not the product schema or security model.

## Architecture

```mermaid
flowchart LR
  Employee["Employee browser"] --> Ingress["Workspace ingress"]
  Ingress --> Web["Web application"]
  Web --> Control["Control API"]

  Control --> Store[("Control PostgreSQL")]
  Control --> Controller["Workspace controller"]
  Controller --> Sandbox["Kasm sandbox"]
  Control --> Consent["OpenVTC consent service"]
  Control -->|"hosted mTLS administrator API"| AdminProxy["LiteLLM admin proxy"]
  AdminProxy --> Gateway["LiteLLM gateway"]
  Gateway -->|"routing, usage, and MCP policy callback"| Control
  Control --> Broker["Channel broker"]
  Scheduler["Scheduler worker"] --> Control

  Sandbox --> Loopback["Root-owned AI/MCP broker"]
  Loopback -->|"scoped virtual key"| Gateway
  Sandbox --> Control
  Sandbox --> Egress["Per-workspace egress proxy"]
  Gateway --> Models["Model providers"]
  Gateway --> M365["Microsoft 365 MCP"]
  M365 --> Graph["Microsoft Graph"]
  Broker --> Channels["External channels"]

  Gateway --> GatewayStore[("Gateway PostgreSQL")]
```

The system separates four concerns:

1. **Experience plane:** the Web application, companion approval experience,
   and managed sandbox applications.
2. **Control plane:** identity, policy, workspace lifecycle, scoped grant
   issuance, model-routing decisions, Team budgets, immutable usage accounting,
   operation state, audit receipts, and channel routing.
3. **Data plane:** LiteLLM accepts the governed `lemmacomputer-auto` transport
   alias, executes only the concrete deployment authorized by Control, and
   routes MCP traffic using revocable workspace-and-agent credentials; egress
   proxies enforce signed domain rules.
4. **Consent plane:** the isolated OpenVTC service signs requests and verifies
   enrollment and decision proofs. Control owns the operation state machine and
   one-time execution lease.

Provider keys exist only in the model gateway. Microsoft OAuth custody stays
outside workspaces. The managed sandbox process receives local broker
credentials rather than provider, gateway-administrator, Microsoft, Control, or
Docker credentials.

See [Architecture](docs/architecture.md) for trust boundaries, runtime flows,
network isolation, policy integrity, and the approval protocol. The dedicated
[LiteLLM gateway architecture](docs/litellm-gateway-architecture.md) separates
the provider, governed Auto, MCP/OAuth, scoped-grant, budget, and telemetry
paths and identifies which decisions remain authoritative in Control.

## Services

| Service | Responsibility | Exposure |
| --- | --- | --- |
| `workspace-ingress` | Serves the product origin and exchanges short-lived workspace launch links for scoped sessions | `127.0.0.1:4174` |
| `web` | Static React application and authenticated reverse proxy to Control | Private |
| `control-api` | Identity, policy, lifecycle orchestration, grants, governance, audit, and connection APIs | Private |
| `db-migrate` | One-shot, checksummed Control-database migration job that must complete before Control starts | Private/job |
| `workspace-controller` | Provisions Kasm workspaces through local Docker or the Kasm Developer API | Private |
| `litellm` | Model routing, per-user OAuth custody, scoped virtual keys, and MCP dispatch | `127.0.0.1:4000` |
| `litellm-admin-proxy` | Dedicated Control-to-LiteLLM administration transport; requires mTLS in hosted deployments | Private |
| `ms365-mcp` | Pinned Microsoft 365 MCP connector for Mail, Calendar, OneDrive, and Teams | OAuth bridge on `127.0.0.1:4311` |
| `openvtc-consent` | OpenVTC executor identity, request signing, and proof verification | Private |
| `channel-broker` | Encrypted external-channel credentials and policy-checked message routing | Private |
| `scheduler-worker` | Claims due schedules and dispatches them through Control without decrypting prompts | Private |
| `postgres` | LemmaComputer identity, policy, workspace, routing, usage-ledger, budget, operation, and audit state | Private |
| `litellm-postgres` | Gateway configuration, virtual keys, and encrypted OAuth state | Private |
| workspace sidecars | Credential brokers, Kasm relay, and default-deny egress enforcement created per workspace | Dynamic/private |

The technical [Service reference](docs/services.md) describes each process,
interface, state owner, health contract, and extension seam.

## Run locally

The reference deployment requires Linux on `amd64`, Docker Engine with Docker Compose v2.30.0 or later,
Node.js 22 or later, a Microsoft Entra tenant, and a model-provider API key. It
binds browser-facing ports to loopback and is intended for development or
evaluation.

```bash
npm ci
npm run env:init
# Edit the generated .env with the Entra and administrator values.
npm run env:check
npm run image:workspace
npm run compose:config
npm run compose:up
```

After the stack is healthy, sign in as an administrator and open **AI control
plane → Models & providers** to add and test each write-only model-provider
key. Then configure Pricing, publish a Model routes mapping, and set up a Team
rollout before expecting governed Auto, Lite, Balanced, or Pro requests to run.
Do not put provider keys in `.env`.

Before editing `.env`, configure the two exact Web redirect URIs and delegated
Graph permissions in Entra. The
[local deployment runbook](docs/local-deployment.md) lists every prerequisite,
environment value, Entra setting, command, and readiness check in setup order.
Open [http://localhost:4174](http://localhost:4174) after the stack is healthy.

## Development

```bash
npm ci
npm run build
npm test
```

Useful focused processes:

```bash
npm run dev:control
npm run dev:controller
npm run dev:web
```

The monorepo uses npm workspaces. Shared schemas and security invariants live in
`packages/`; runnable processes live in `apps/`; provider and gateway policy
configuration lives in `config/` and `integrations/`.

## Documentation

- [Architecture and trust model](docs/architecture.md)
- [LiteLLM gateway architecture](docs/litellm-gateway-architecture.md)
- [AI control plane](docs/ai-control-plane.md)
- [Service reference](docs/services.md)
- [Governed model routing](docs/model-routing.md)
- [Local deployment and Entra setup](docs/local-deployment.md)
- [Hosted Microsoft Entra External ID](docs/hosted-external-id.md)
- [Extending LemmaComputer](docs/extending.md)
- [Configuration and operations](docs/operations.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](docs/SECURITY.md)

LemmaComputer is security-sensitive infrastructure. Changes to identity,
credentials, signed policy, approval binding, egress, or execution leases
should include negative tests that demonstrate the relevant boundary fails
closed.
