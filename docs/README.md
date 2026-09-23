# LemmaComputer documentation

Documentation is grouped by what you are trying to do. If you are new, read in
the order below: run it, understand how it is built, then go deep on a feature.

| Group | Contents |
| --- | --- |
| [Architecture](#architecture) | How the system is built, and why it is split the way it is |
| [Guides](#guides) | Running, developing, deploying, migrating, extending |
| [Product](#product) | Feature-level specifications and their authorities |
| [Agent runtimes](#agent-runtimes) | Qualifying agent and reasoning adapters |
| [Reference](#reference) | Per-process reference and legacy adapters |
| [Decisions](#decisions) | Architecture decision records |
| [Reports](#reports) | Point-in-time audits and benchmarks |

## Start here

1. The root [README](../README.md) has the shortest runnable path — a Quick
   start that brings the stack up from a clean clone.
2. [Architecture and trust model](architecture/overview.md) explains what you
   just started.
3. [Why LemmaComputer runs as many processes](architecture/service-boundaries.md)
   answers the most common question about the design.
4. [Evaluation, development, and remote workspace workflow](guides/development-workflow.md)
   is the one setup authority for evaluation, code changes, and local
   remote-node/Cowork qualification.

## Architecture

How the system is built and why. Read `overview.md` first.

- [Architecture and trust model](architecture/overview.md) — system boundaries,
  policy projection, credential custody, workspace network, governed routing and
  accounting, the protected-operation protocol, and the Compose network matrix.
- [Why LemmaComputer runs as many processes](architecture/service-boundaries.md)
  — what each process boundary buys, which are load-bearing trust boundaries,
  which are only deployment units, and the rule for adding a new one.
- [Customer authentication architecture](architecture/authentication.md) — the
  accepted Better Auth boundary, authentication database, hosted and
  customer-managed topology, enterprise SSO, product authorization handoff, and
  migration sequence.
- [LiteLLM gateway architecture](architecture/litellm-gateway.md) — the private
  administrator API, workspace data path, provider lifecycle, synthetic Auto
  routing, MCP and OAuth grants, protected execution, and budgets, separating
  gateway duties from Control authority.
- [MCP networking, egress, and OAuth callbacks](architecture/mcp-networking.md) —
  outbound model and MCP traffic versus the browser callback path, and the proxy,
  SSRF, redirect, and provider-registration boundaries.
- [Tenant isolation matrix](architecture/tenant-isolation-matrix.md) — where
  tenant scoping is enforced for every persisted and cached record.
- [Agent instance identity](architecture/agent-instance-identity.md) — how a
  running agent is identified and bound to policy.
- [Organization RBAC](architecture/organization-rbac.md) — roles, permissions,
  and the membership authorization boundary.
- [Workspace node deployment](architecture/workspace-node.md) — the normative
  remote-node network, mTLS, storage, purge, and qualification contract.
- [Authenticated Sites assets](architecture/sites-serving.md) — sandboxed
  delivery, short-lived grants, and site-level sharing authority.
- [Workspace guardrail reconciliation](architecture/workspace-guardrail-reconciliation.md)
  — the forced suspension, grant revocation, immutable publication, compatible-
  selection reconciliation, and recovery contract for organization guardrail
  updates.

## Guides

Start with the [task-based guides index](guides/README.md). The
[evaluation, development, and remote workspace workflow](guides/development-workflow.md)
is the single setup authority. For go-live planning, the
[initial customer AWS deployment candidate](guides/deployment/aws-initial-deployment.md)
links that workflow to the release and infrastructure sequence.

## Product

Feature-level specifications and the authority that owns each decision.

- [AI control plane](product/ai-control-plane.md) — the administrator surface
  mapped to provider, routing, pricing, Team, budget, usage-health, spend, and
  emissions authorities.
- [Governed model routing](product/model-routing.md) — stable service classes,
  deployment rate-card costing, decision evidence, and safe rollout operations.
- [AI usage and cost ledger](product/ai-usage-ledger.md) — governed-attempt
  attribution, normalized provider units, immutable pricing snapshots,
  reconciliation, privacy, and callback operations.
- [AI spend observability](product/ai-spend-observability.md) — administrator
  totals, allocation, token categories, price basis, exports, and missing-data
  states.
- [Team spend budgets](product/team-budgets.md) — period limits, conservative
  reservations, hard and soft enforcement, overrides, and reconciliation.
- [Teams and cost allocation](product/teams-and-cost-allocation.md) — Team
  membership, default spending assignment, cost-center references, and the
  access-control boundary.
- [Pinned provider-rate catalogue](product/pinned-rate-catalogue.md) — the local,
  hashed pricing evidence used to materialize exact rate cards without egress.
- [AI token operational-emissions estimate](product/ai-token-emissions.md) — the
  disclosed token-energy proxy, regional grid factors, coverage, and limitations.
- [Personal AI usage](product/personal-ai-usage.md) — the member-facing view of
  their own usage.
- [Activity event protocol](product/activity-events.md) and
  [Activity panel](product/activity-panel.md) — the sanitized employee-visible
  work trace and its replay and streaming UI.
- [Tool-call audit ledger](product/tool-call-audit-ledger.md) — the record of
  admitted and terminal tool operations.

## Agent runtimes

- [Reasoning adapter qualification](agents/reasoning-adapter-qualification.md) —
  discovery versus qualified runtime adapters, signed route authority, and the
  live promotion gates for Claude, Hermes, Codex, and future agents.
- [Agent model and reasoning adapter playbook](agents/agent-reasoning-adapter-playbook.md)
  — what LiteLLM translates, what LemmaComputer must still govern, the Claude and
  Hermes implementation differences, and the faster path for future agents.
- [Claude reasoning effort](agents/claude-reasoning-effort.md) — the governed
  effort control and its transport.

## Reference

- [Service reference](reference/services.md) — every long-running, one-shot, and
  dynamic runtime component, its interfaces, dependencies, state, health
  contract, and extension seam.
- [Model provider discovery](reference/model-providers.md) — supported provider
  protocols, metadata sources, credential custody, and validation limits.
- [Component extension contracts](reference/extension-contracts.md) —
  implementation checklists for models, connectors, agents, applications,
  channels, and migrations.

## Decisions

Architecture Decision Records (ADRs) preserve consequential design choices:
the context at the time, the chosen option, its tradeoffs, and whether it is
accepted, amended, or superseded. They explain **why** a durable decision was
made; the Architecture section above describes **how the current system works**,
and Guides describe **how to operate it**. ADRs remain in the repository after
supersession so future maintainers can understand the decision history.

- [ADR 0001 — local release gates](adr/0001-local-release-gates.md): why
  enforcement is local and both profiles share one codebase.
- [ADR 0002 — simplified integration and demo tags](adr/0002-simplified-integration-and-demo-tags.md)
- [ADR 0003 — deployment profile capability contract](adr/0003-deployment-profile-capability-contract.md)
- [ADR 0004 — Better Auth adoption and qualification](adr/0004-better-auth-adoption-and-qualification.md):
  provider-neutral principal and session contracts, threat model, database and
  recovery operations, exact pins, and downstream qualification evidence.
- [ADR 0005 — catalog-gated Electron sandbox profiles](adr/0005-catalog-gated-electron-sandbox.md):
  why the namespace exception is limited to release-qualified applications and
  arbitrary user-installed Electron apps do not inherit it.
- [ADR 0006 — hosted C-minus workspace-node placement and trust](adr/0006-hosted-c-minus-workspace-node-placement-and-trust.md):
  why hosted workspaces use sticky logical-node ownership and remote mTLS plus
  an internal credential, while health scheduling and failover remain deferred.

## Reports

Point-in-time evidence. These describe a state of the system on a date, not a
current contract.

- [Responsive UX and accessibility audit](reports/responsive-ux-accessibility-audit.md)
- [Workspace performance benchmark](reports/workspace-performance-benchmark.md)
- [Workspace policy design QA](reports/design-qa-workspace-policy.md)
- [Settings frame design QA](reports/design-qa-settings-frame.md)

## Security

- [Security policy](SECURITY.md) — private vulnerability reporting and the
  highest-impact trust boundaries.
