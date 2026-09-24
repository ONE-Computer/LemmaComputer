# Deployment profiles

**Use this page to choose how an installation is operated.** It does not deploy
anything. LemmaComputer has one codebase and two production profiles:

| | `customer-managed` | `hosted` |
| --- | --- | --- |
| Operator | Customer | LemmaComputer |
| Organizations | One | Multiple, with tenant-scoped records |
| Customer sign-in | Embedded Better Auth in the installation | Embedded Better Auth in the hosted control plane |
| Platform operator sign-in | Absent | Separate Better Auth passkey realm |
| Workspace nodes | Customer-approved local or private remote nodes | Private remote nodes required |
| Secrets, backups, and network | Customer owns them | LemmaComputer owns them |
| Hosted billing, telemetry, and background jobs | Disabled | Eligible for configuration |

`worktree` is a **development harness**, not a third production profile. It
creates isolated local configuration and data for a task worktree or disposable
evaluation. Never select it to represent hosted production.

The profile decides which capabilities an installation may support. It does not
log a person in, grant an organization role, or prove the infrastructure is
safe. Every request still needs server-side organization and resource
permission checks. Customer sign-in may be configured with email/password,
passkeys, Google, Microsoft, SAML, or OIDC in either production profile;
provider claims cannot assign product roles. The capability matrix in
[`packages/deployment-profile/src/index.mjs`](../../packages/deployment-profile/src/index.mjs)
is the executable source of truth.

Workspace placement is a separate setting. `customer-managed` may choose a
local or remote node; `hosted` requires a remote node. Hosted acceptance also
needs real private networking, mTLS, governed egress, durable storage, and a
Cowork-capable node. A profile check or the local
[remote-node qualifier](development-workflow.md#remote-workspace-node-and-cowork-qualification)
does not qualify that production infrastructure.

## Operator preflight

In the target installation's existing configuration, set
`LEMMACOMPUTER_INSTALLATION_KIND` to the chosen production profile. Validate
that configuration with the matching command:

```bash
npm run env:check -- --profile=customer-managed
```

or:

```bash
npm run env:check -- --profile=hosted
```

`npm run env:render -- --profile=<chosen-profile>` then generates the
per-service environment projections. It does not provision databases, ECS,
workspace nodes, or secrets. The full catalog of required values is generated
from [`scripts/setup/deployment-config.mjs`](../../scripts/setup/deployment-config.mjs) into
`.env.example`; production values belong in deployment secret custody.

For a code-level check of both profiles, run
`npm run test:profiles`. This checks configuration and service
projections using synthetic configuration and image references; it does not deploy either
production profile. Start from the [AWS go-live path](aws-go-live.md) when
planning an AWS installation.
