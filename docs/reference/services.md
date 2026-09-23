# Service reference

**Use this to find the process that owns a behavior.** The current service
list, network attachments, health checks, and environment projection are in
`compose.yaml` and `scripts/deployment-config.mjs`; those files are the
runtime authority. Ports below are container ports, not public endpoints.
The [architecture overview](../architecture/overview.md) explains the trust
boundaries, and [operations](../guides/operations.md) has local commands.

## Long-running services

| Process | Source | Port | Owns |
| --- | --- | --- | --- |
| Workspace ingress | `apps/workspace-ingress` | 4174 | Only published product origin, exact OAuth relays, desktop launch/session access |
| Web | `apps/web` | 4173 | Static UI and private `/api` forwarding; no user authorization |
| Control API | `apps/control-api` | 4100 | Better Auth integration, product authorization, policy, placement, routing, usage, approvals, audit |
| Workspace controller | `apps/workspace-controller`, `packages/kasm-adapter` | 4101 | Node-local Docker/KasmVNC lifecycle and signed-policy verification |
| Channel broker | `apps/channel-broker` | 4102 | External-channel credentials, delivery, sender routing |
| Scheduler worker | `apps/scheduler-worker` | 4103 | Due-run leases; execution returns to Control |
| OpenVTC consent | `apps/openvtc-consent` | 8788 | Approval protocol and executor signing key |
| LiteLLM | `config/litellm`, `integrations/litellm` | 4000 | Encrypted provider/OAuth credentials, scoped keys, authorized model/MCP execution |
| Microsoft 365 MCP | `integrations/ms365-mcp` | 3000 | Private Graph tool execution and connector consent |
| Egress proxies | `apps/egress-proxy` | 3128 | Separate model, remote-MCP, and per-workspace destination policy |
| LiteLLM admin proxy | `apps/litellm-admin-proxy` | private | Hosted mTLS boundary on the gateway administrator API |
| PostgreSQL services | `compose.yaml` or managed DB | 5432 | Product, customer-auth, platform-auth, and gateway logical databases |

Dynamic workspace containers and relays are created by the controller, not
listed as fixed Compose services. `workspace-image` is a build profile, not a
running service. `apps/gateway-fixture` is test-only.

## One-shot jobs

`db-migrate`, `auth-db-migrate`, and `platform-auth-db-migrate` apply separate
forward-only schema streams. `platform-auth-db-init` and `artifact-data-init`
prepare local state. Control starts only after required jobs succeed and then
checks schema compatibility; it never runs migrations on startup. See
[Database migrations](../guides/database-migrations.md).

## Request paths

- **Browser:** workspace ingress → Web → Control. Web adds an internal proxy
  token; Control validates the customer's Better Auth session and active
  product membership. The proxy token is not a user identity.
- **Workspace:** Control signs policy and calls the workspace controller.
  Remote nodes use mTLS and an internal credential. The controller alone
  accesses its Docker socket.
- **Model:** root-owned workspace broker → scoped LiteLLM key → callback to
  Control for exact routing and usage admission → selected provider. LiteLLM
  has no direct internet route.
- **Connector tool:** LiteLLM enforces projected server/tool permissions;
  Control authorizes each call and supplies an exact approval lease for
  protected actions.
- **External channel:** channel broker authenticates the sender and asks
  Control to validate the current tenant/workspace/agent route.

## State and extension points

| Change | Start in | Keep outside |
| --- | --- | --- |
| Product rule or route | `packages/contracts`, focused Control module, store, thin route | Browser-provided tenant or permission authority |
| Workspace runtime | `packages/kasm-adapter`, signed policy, controller | Docker socket in Control |
| Model provider | Provider settings and tenant route lifecycle | Provider key in `.env`, static LiteLLM model list, user workspace |
| MCP connector/tool | Contract catalog, Control policy, LiteLLM callback | Token in Control/Web/workspace; tool without per-call authorization |
| Egress rule | `packages/egress-policy`, then proxy enforcement | UI-only checks or post-connection DNS decisions |
| External channel | Channel broker and Control-owned route | Decrypted channel credential in Control/workspace |

See [Extension contracts](extension-contracts.md) for the change checklist.
