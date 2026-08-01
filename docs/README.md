# ONEComputer documentation
- [Development workflow](development-workflow.md) defines issue dependencies, isolated worktrees, local gates, and controlled promotion.
- [Database migrations](database-migrations.md) defines the ledger, legacy baseline, expand/migrate/contract policy, and tests.
- [Demo release runbook](demo-release.md) keeps the demo environment pinned, backed up, and separate from development.
- [ADR 0001](adr/0001-local-release-gates.md) records why enforcement is local and hosted/self-hosted share one codebase.


- [ONEVibe-MonoRepo (Cowork) migration and acceptance](ONEVIBE_MONOREPO.md)
- [Cowork E2B + ACP canonical architecture and delivery plan](COWORK_E2B_ACP_PLAN.md)
- [Manus UX benchmark and ONEVibe-MonoRepo implementation plan](MANUS_UX_BENCHMARK.md)
- [E2B + ACP final execution plan](ONEVIBE_E2B_ACP_FINAL_PLAN.md)
  defines the additive product boundary, vertical-slice acceptance criteria,
  and where durable changes belong. It does not replace this monorepo's
  security, service, or deployment documentation.
- [Local deployment and Entra setup](local-deployment.md) is the agent-oriented
  runbook for preparing `.env`, configuring Microsoft Entra, building the
  workspace image, starting Compose, and verifying the stack.
- [Architecture and trust model](architecture.md) explains the system
  boundaries, policy projection, credential custody, workspace network, and
  governed-operation protocol.
- [Service reference](services.md) documents every long-running and dynamic
  runtime component, its interfaces, dependencies, state, and extension seam.
- [Extending ONEComputer](extending.md) is the implementation guide for adding
  model routes, MCP connectors, tools, agents, applications, sandbox drivers,
  channels, and schema migrations.
- [Configuration and operations](operations.md) covers the reference Compose
  topology, environment variables, startup, health, persistence, backup,
  rotation, and production deployment concerns.
- [Security policy](SECURITY.md) explains private vulnerability reporting and
  the highest-impact trust boundaries.

Start with the root [README](../README.md) for the shortest runnable path.
