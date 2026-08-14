# Cloud deployment guides

These guides map LemmaComputer's logical trust boundaries onto cloud services.
They are reference architectures, not deployable infrastructure-as-code or a
production security sign-off.

- [AWS deployment architecture](aws-deployment.md)

Future provider-specific guides should preserve the same product invariants:
one shared codebase for hosted and customer-managed profiles, tenant-scoped
state, one canonical browser origin, private control and gateway services,
separate model/MCP/channel/workspace egress paths, and no direct internet route
from LiteLLM.
