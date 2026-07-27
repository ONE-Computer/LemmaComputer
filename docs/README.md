# ONEComputer documentation

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
