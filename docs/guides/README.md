# Guides: read only the one for your task

**First time running the repo?** Follow the numbered
[first-run steps](development-workflow.md#evaluate-a-single-checkout): clone,
start the application, verify your account, and open a desktop. That is the
only guide you need for a basic local evaluation.

If you are changing code, use the [task worktree setup](development-workflow.md#develop-in-an-isolated-task-worktree).
Read the other guides only when you reach the corresponding task:

| File | Read it when you need to… |
| --- | --- |
| [AWS go-live](aws-go-live.md) | Plan and qualify the proposed production deployment. |
| [Development workflow](development-workflow.md) | Set up a disposable evaluation, isolated task worktree, or local remote-node/Cowork test. This is the setup authority for development, not an AWS runbook. |
| [Deployment profiles](deployment-profiles.md) | Choose and validate `hosted` or `customer-managed` application behavior and configuration. |
| [Demo releases](demo-release.md) | Update the running demo or create an immutable full release. Use its full-release section for AWS go-live. |
| [Local operations](operations.md) | Start, stop, diagnose, and back up a local Compose stack. |
| [Microsoft 365 local test](local-deployment.md) | Register the connector app and test consent or SharePoint site grants. |
| [Database migrations](database-migrations.md) | Change schema or run explicit migration jobs. |
