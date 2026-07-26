# 003: ship policy-selected default agents

Status: `complete`

Priority: P1
Depends on: 002
Unblocks: 004

## Outcome

An administrator can include Claude Desktop, Hermes Claw, or both in a versioned
workspace policy. A newly provisioned sandbox contains the selected pinned
agents, already configured for their own governed ONEComputer model, tool, and
network grants, without direct provider credentials or manual installation.

## In scope

- Add an owned agent catalog and agent-profile contract rather than hard-coding
  Claude Desktop as the only workspace client.
- Qualify, pin, license-review, package, and preconfigure Hermes Claw alongside the
  existing pinned Claude Desktop client.
- Let policy select one or more approved default agents and project the
  selection into new and intentionally rebuilt workspaces.
- Give each enabled agent a distinct workload identity, scoped LiteLLM/model
  route, MCP toolset, rate/concurrency limits, egress purpose, and audit attribution.
- Expose installed, selected, starting, ready, degraded, and unavailable state
  for each agent in the workspace UI.
- Define predictable launch and resource behavior when both agents are enabled.
- Record software provenance and an inventory for every shipped agent artifact.

## Out of scope

- Arbitrary user-provided agents or images, an unreviewed marketplace, sharing
  one agent credential between clients, direct provider login, silent
  background installation, automatic execution on behalf of another user, or
  claiming all claw-style agents are interchangeable.

## Required implementation

- Versioned catalog entries with stable agent ID, pinned source/artifact and
  digest, license/provenance, launch contract, health contract, configuration
  adapter, resource requirements, and supported capabilities.
- Policy validation that rejects unknown, unpinned, incompatible, duplicate,
  or unavailable agents before workspace provisioning.
- A reproducible image/build path that includes only selected approved agents
  or a documented product decision to use a fixed multi-agent image without
  making disabled agents runnable.
- Root/management-owned configuration generation and per-agent renewable,
  revocable identity/grant delivery without provider, Microsoft, LiteLLM
  master, Docker, PostgreSQL, or Control credentials in the image.
- Agent-scoped egress and governed MCP/model routing through the Issue 002
  boundary, with distinct audit attribution for simultaneous clients.
- Safe upgrade, rollback, removal, persistence, and restart semantics.

## Required verification

- [x] Claude-only, Hermes-Claw-only, and Claude-plus-Hermes-Claw policies provision
      exactly the selected usable clients with no manual installation or
      provider login.
- [x] Each selected agent completes normal and streaming chat through only its
      assigned model aliases and discovers only its assigned governed tools.
- [x] Disabled, unknown, tampered, unpinned, or policy-removed agents cannot
      start with a valid grant or inherit another agent's identity.
- [x] Cross-user, cross-workspace, cross-agent, expired, revoked, wrong-model,
      wrong-tool, and wrong-audience credentials fail closed.
- [x] Changing either client's base URL or MCP settings cannot reach a direct
      provider, Graph, upstream MCP, private network, or an undeclared public
      destination.
- [x] Both agents can run according to declared resource limits without
      readiness races, port collisions, credential reuse, or ambiguous audit
      attribution.
- [x] Workspace stop/start, service restart, image rebuild, policy change, and
      agent removal preserve intended user data while reconciling the selected
      catalog safely.
- [x] Image and runtime inspection finds no prohibited credential, mutable
      dependency, unexpected listener, or agent traffic outside the governed
      routes.

## Evidence required

Include the agent decision/qualification record, exact Hermes Claw and Claude
Desktop source/artifact pins and licenses, SBOM or package inventory, profile
and policy samples, reproducible build evidence, per-agent identity and route
traces, single/dual-agent resource results, isolation and bypass matrix,
lifecycle/upgrade/removal results, screenshots, and secret scan.

## Stop conditions

- Hermes Claw cannot be pinned, redistributed, configured for the governed
  LiteLLM/MCP routes, isolated with a distinct identity, or run within the
  declared workspace resource budget.
- An agent requires a direct provider credential, unrestricted egress, shared
  identity, host authority, or a secret baked into the image.
- Policy selection can make an unreviewed artifact runnable or a disabled agent
  can retain a usable grant.

## Completion record

Implementation and deployed verification are complete.

- Qualification record:
  `local-plans/v2/decisions/003-hermes-agent-qualification.md`
- Automated suite: 118 tests passed.
- Image qualification covered Claude-only, Hermes-only, and dual-agent startup,
  launcher removal, distinct broker ports, Hermes tool restriction, and pinned
  package/version inspection.
- The existing workspace was stopped and rebuilt on immutable image
  `sha256:b4515ed8af5c9551004b393bda4a692caab8ade9cc09021a1a9bd5326fd715ab`
  while retaining its persistent home volume.
- Deployed Hermes normal and streaming chat returned the expected canaries
  through `onecomputer-glm`; governed discovery returned the assigned 38-tool
  Microsoft 365 surface.
- Control reports Claude Desktop and Hermes Claw plus identity, network, models,
  and tools as ready. Runtime inspection found no provider, LiteLLM master,
  database, Entra, or Microsoft client secrets.
- The real Hermes desktop command reached the 0.19.0 interactive prompt under
  `kasm-user` with the governed model and MCP server configured.
