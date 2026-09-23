# AWS go-live: proposed deployment path

**Status:** Planning guide. The supplied AWS diagram is a proposal, not evidence
of a deployed environment. This repository has no AWS infrastructure code, ECS
task definitions, or command that provisions this design. The steps below are
the work still needed before go-live.

![Proposed AWS overview with public ingress, private application, controlled egress, inspection, database, and workspace subnets.](assets/aws-architecture-overview.png)

*The supplied diagram compresses two Availability Zones into one view. It does
not define every route, security-group rule, or service permission.*

## Deployment order

1. **Choose and record the production design.** Decide who operates it
   (`hosted` or `customer-managed`), the AWS account and VPC boundaries, Region,
   public origin, workspace-node allocation, network inspection, and recovery
   targets. Record unresolved choices in an infrastructure ADR. The
   [deployment profile guide](deployment-profiles.md) defines product behavior;
   the [AWS architecture reference](../architecture/aws-deployment.md) details
   the proposed cloud controls.
2. **Qualify the application boundary.** Use the
   [development workflow](development-workflow.md#remote-workspace-node-and-cowork-qualification)
   to test remote nodes, mTLS, and Cowork locally. Its Compose commands do not
   deploy AWS or qualify production networking.
3. **Build the AWS environment.** Write and review infrastructure code for
   two-AZ networking, inspected egress, WAF/ALB/DNS/TLS, ECS services, private
   workspace nodes, RDS, S3, logs, and secrets. Use the
   [AWS architecture reference](../architecture/aws-deployment.md) to review
   service placement, routes, and release gates. Test the selected design in
   the target AWS organization.
4. **Create an immutable release.** Follow the
   [full release procedure](demo-release.md#full-release-path), including
   `npm run verify:release` and `npm run release:tag -- --push` from a clean,
   pushed release commit. Publish qualified images and record their digests.
   The routine demo-update command is not an AWS deployment command.
5. **Install configuration and initialize data.** Supply the chosen profile's
   production secrets, image digests, and per-service configuration; run the
   [profile preflight](deployment-profiles.md#operator-preflight). Create the
   required databases and roles, then run explicit migration jobs before
   application startup. In `hosted`, the Control trust domain contains
   `lemmacomputer`, `lemmacomputer_auth`, and
   `lemmacomputer_platform_auth`; the LiteLLM trust domain contains `litellm`.
   Back up all four logical databases with matching secrets and workspace/S3
   data. See [database migrations](database-migrations.md) and
   [operations](operations.md#persistence).
6. **Start private services and connect the browser entry.** Deploy Control,
   Web, LiteLLM, workers, named egress proxies, and workspace nodes with their
   intended private routes and mTLS. Expose the canonical HTTPS origin through
   the ALB/WAF and register exact OAuth callbacks.
7. **Qualify the live installation.** On the target infrastructure, test
   sign-in, model/MCP and channel paths, workspace persistence and purge,
   inspected egress, backup/restore, failure recovery, and rollback. Apply the
   [release gates](../architecture/aws-deployment.md#deployment-phases-and-release-gates)
   before declaring it ready.

## Decisions that the diagram does not settle

- **Isolation:** The diagram shows one VPC and a node per tenant. The reference
  design also considers a separate workspace VPC/account, and the product
  supports a shared default node. Choose and test the intended allocation.
- **Egress:** The diagram shows inspection subnets, but Control, LiteLLM,
  Microsoft identity/Graph, channels, email, and workspace traffic each need
  an explicit destination policy and route. LiteLLM uses separate model and
  remote-MCP proxies; it must not receive general internet access.
- **Email:** SES appears as an option in the diagram. Current production
  configuration accepts Postmark for authentication and invitation email.
  Switching providers needs an application change and qualification.
- **Recovery:** Two AZs and Multi-AZ RDS do not provide automatic workspace
  migration or cross-Region recovery. Set task counts, restore procedure, and
  node replacement targets before making an availability claim.

Read the [AWS architecture reference](../architecture/aws-deployment.md) only
when designing or reviewing infrastructure. Read the
[development workflow](development-workflow.md) only when setting up local
evaluation, a task worktree, or remote-node qualification.
