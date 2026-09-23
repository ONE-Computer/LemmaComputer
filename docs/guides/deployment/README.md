# Cloud deployment guides

These guides map LemmaComputer's logical trust boundaries onto cloud services.
They describe proposed deployments, not deployed infrastructure, deployable
infrastructure-as-code, or a production security sign-off.

- [Initial customer AWS deployment candidate](aws-initial-deployment.md) — the
  supplied overview diagram, the current product contract, and decisions to
  settle before go-live.
- [AWS deployment architecture](aws-deployment.md) — broader reference options
  and security controls for either production profile.

Future provider-specific guides should preserve the same product invariants:
one shared codebase for hosted and customer-managed profiles, tenant-scoped
state, one canonical browser origin, private control and gateway services,
separate model/MCP/channel/workspace egress paths, and no direct internet route
from LiteLLM.
