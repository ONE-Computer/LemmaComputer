# LemmaComputer documentation

Choose the task first:

- **Run or develop locally:** [Evaluation and development workflow](guides/development-workflow.md).
- **Plan an AWS deployment:** [AWS go-live path](guides/aws-go-live.md). The
  diagram is a proposal; the repo does not contain a production AWS deploy
  command.
- **Understand the system:** [Architecture and trust model](architecture/overview.md).

## What each folder is for

| Folder | Use it for | Start with |
| --- | --- | --- |
| [`guides/`](guides/README.md) | Steps an operator or developer performs | Task-based guide list |
| [`architecture/`](architecture/overview.md) | Current trust boundaries and data flows | Architecture overview |
| [`product/`](product/ai-control-plane.md) | Feature behavior and policy contracts | Relevant feature only |
| [`agents/`](agents/reasoning-adapter-qualification.md) | Adding or upgrading an agent's reasoning adapter | Qualification procedure |
| [`reference/`](reference/services.md) | Process ownership and extension checklists | Service reference |
| [`adr/`](adr/0001-simplified-integration-and-demo-tags.md) | Historical reasons for durable decisions | The decision relevant to your change |

An **ADR** is an architecture decision record. It explains *why* a choice was
made at a point in time. It is neither a deployment instruction nor an issue
catalog. A later ADR may supersede part of an earlier one; current behavior
belongs in architecture, product, and source code. The active decisions are:

- [0001: integration and release separation](adr/0001-simplified-integration-and-demo-tags.md)
- [0002: deployment profiles](adr/0002-deployment-profile-capability-contract.md)
- [0003: Better Auth adoption](adr/0003-better-auth-adoption-and-qualification.md)
- [0004: Electron sandbox gate](adr/0004-catalog-gated-electron-sandbox.md)
- [0005: hosted workspace ownership](adr/0005-hosted-c-minus-workspace-node-placement-and-trust.md)
- [0006: customer and operator authentication](adr/0006-better-auth-only-customer-and-platform-authentication.md)
- [0007: durable chat and artifacts](adr/0007-control-owned-chat-and-artifact-persistence.md)

[Security policy](SECURITY.md) explains private vulnerability reporting.
