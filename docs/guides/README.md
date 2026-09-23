# Guides: read only the one for your task

**AWS go-live?** Start with the short [AWS deployment path](aws-go-live.md). It
shows the diagram, work order, and remaining decisions. The repository does not
yet have a command that deploys this design to AWS.

| File | Read it when you need to… |
| --- | --- |
| [AWS go-live](aws-go-live.md) | Plan and qualify the proposed production deployment. |
| [Development workflow](development-workflow.md) | Set up a disposable evaluation, isolated task worktree, or local remote-node/Cowork test. This is the setup authority for development, not an AWS runbook. |
| [Deployment profiles](deployment-profiles.md) | Choose and validate `hosted` or `customer-managed` application behavior and configuration. |
| [Demo releases](demo-release.md) | Update the running demo or create an immutable full release. Use its full-release section for AWS go-live. |
| [Local operations](operations.md) | Start, stop, diagnose, and back up a local Compose stack. |
| [Microsoft 365 local test](local-deployment.md) | Register the connector app and test consent or SharePoint site grants. |
| [Database migrations](database-migrations.md) | Change schema or run explicit migration jobs. |

For AWS subnet, firewall, and service-placement detail, see the
[AWS architecture reference](../architecture/aws-deployment.md). It is a design
reference, not another deployment guide.
