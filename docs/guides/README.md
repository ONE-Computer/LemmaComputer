# Guides: choose a task

Start with [Evaluation, development, and remote workspace workflow](development-workflow.md).
It is the single authority for choosing a checkout, local profile, and
qualification setup. Read another guide only for the task you are doing.

| Task | Read next |
| --- | --- |
| Plan the proposed customer AWS deployment | [Initial AWS deployment candidate](deployment/aws-initial-deployment.md), then the [AWS reference architecture](deployment/aws-deployment.md) for network and security controls |
| Configure a production profile | [Deployment profiles](deployment-profiles.md), then [Configuration and operations](operations.md) |
| Prepare an immutable release | [Full release path](demo-release.md#full-release-path); the routine demo-update command is not an AWS deployment command |
| Set up Microsoft sign-in or Microsoft 365 locally | [Microsoft integration runbook](local-deployment.md) |
| Change database schema | [Database migrations](database-migrations.md) |
| Add a component or integration | [Component extension contracts](../reference/extension-contracts.md) |

The AWS pages describe a candidate design and required deployment order. This
repository has no AWS infrastructure-as-code or command that provisions that
design. Local Compose and the development workflow qualify product behavior;
they do not create a hosted production environment.
