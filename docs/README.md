# ONEComputer documentation

- [Architecture and trust model](architecture.md) explains the system
  boundaries, policy projection, credential custody, workspace network,
  governed routing and accounting, and the protected-operation protocol.
- [AI control plane](ai-control-plane.md) maps the administrator product
  surface to provider, routing, pricing, Team, budget, usage-health, spend, and
  emissions authorities.
- [Service reference](services.md) documents every long-running, one-shot, and
  dynamic runtime component, its interfaces, dependencies, state, and
  extension seam.
- [Development workflow](development-workflow.md) defines issue dependencies, isolated worktrees, local gates, and controlled promotion.
- [Database migrations](database-migrations.md) defines the ledger, legacy baseline, expand/migrate/contract policy, and tests.
- [Teams and cost allocation](teams-and-cost-allocation.md) defines Team membership, default spending assignment, cost-center references, and the access-control boundary.
- [AI usage and cost ledger](ai-usage-ledger.md) defines governed-attempt attribution, normalized provider units, immutable pricing snapshots, reconciliation, privacy, and callback operations.
- [Pinned provider-rate catalogue](pinned-rate-catalogue.md) defines the local, hashed pricing evidence used to materialize exact deployment rate cards without egress.
- [Team spend budgets](team-budgets.md) defines period limits, conservative reservations, hard and soft enforcement, overrides, and reconciliation.
- [AI spend observability](ai-spend-observability.md) explains administrator totals, allocation, token categories, price basis, exports, and missing-data states.
- [AI token operational-emissions estimate](ai-token-emissions.md) documents
  the disclosed token-energy proxy, regional grid factors, coverage, and
  reporting limitations.
- [Governed model routing](model-routing.md) defines stable service classes, deployment rate-card costing, decision evidence, and safe rollout operations.
- [Activity event protocol](activity-events.md) and [Activity panel](activity-panel.md)
  define the sanitized employee-visible work trace and its replay/streaming UI.
- [Demo release runbook](demo-release.md) keeps the demo environment pinned, backed up, and separate from development.
- [ADR 0001](adr/0001-local-release-gates.md) records why enforcement is local
  and hosted/customer-managed profiles share one codebase.
- [Local deployment and Entra setup](local-deployment.md) is the agent-oriented
  runbook for preparing `.env`, configuring Microsoft Entra, building the
  workspace image, starting Compose, and verifying the stack.
- [Extending ONEComputer](extending.md) is the implementation guide for adding
  model routes, MCP connectors, tools, agents, applications, sandbox drivers,
  channels, and schema migrations.
- [Configuration and operations](operations.md) covers the reference Compose
  topology, environment variables, startup, health, persistence, backup,
  rotation, and production deployment concerns.
- [Security policy](SECURITY.md) explains private vulnerability reporting and
  the highest-impact trust boundaries.

Start with the root [README](../README.md) for the shortest runnable path.
