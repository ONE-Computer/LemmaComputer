# Deployment profiles

LemmaComputer supports two production deployment profiles from the same product
codebase and application image. `worktree` is an isolated development mode, not
a third product edition.

| Capability | `customer-managed` | `hosted` | `worktree` |
| --- | --- | --- | --- |
| Operator | Customer | LemmaComputer | Developer |
| Organizations | Exactly one | Multiple | Development fixtures |
| Sign-in providers allowed by profile | Workforce Entra | External ID and enterprise Entra | Development and provider test adapters |
| Identity and secret custody | Customer deployment | LemmaComputer deployment | Local worktree |
| Workspace drivers | Local or remote Kasm | Remote Kasm only | Local or remote Kasm |
| Connector administration | Customer operator | Organization administrator | Developer |
| Usage accounting | Local | Hosted | Development |
| Hosted telemetry and billing | Denied | Allowed | Denied |
| Hosted background jobs | Denied | Allowed | Denied |
| LemmaComputer-managed control plane | Not required | Allowed | Development-only |

“Allowed” means the deployment profile is eligible for that implementation; it
does not claim the feature is already available. Issues #11 and #12 own the
External ID and enterprise Entra sign-in implementations.

The executable source of this table is
`packages/deployment-profile/src/index.mjs`. Its adjacent declaration file is the
stable typed interface for runtime consumers. Deployment preflight imports that
same resolver from `scripts/deployment-config.mjs`.

## Operator preflight

Set `LEMMACOMPUTER_INSTALLATION_KIND` explicitly and run the matching preflight:

```bash
npm run env:check -- --profile=customer-managed
npm run env:render -- --profile=customer-managed
```

or:

```bash
npm run env:check -- --profile=hosted
npm run env:render -- --profile=hosted
```

Customer-managed deployments must configure
`LEMMACOMPUTER_ENTRA_TENANT_ID` for the customer's directory and must leave
`LEMMACOMPUTER_HOSTED_MCP_EGRESS_ORIGINS` empty. They may use `kasm-local` or a
remote `kasm` driver. No generated service projection contains a required
LemmaComputer-hosted control-plane URL.

The checked-in network-deny smoke disables Node DNS, HTTP, HTTPS, TCP, TLS, and
Fetch APIs before running the customer-managed preflight:

```bash
node --import ./tests/fixtures/deny-node-network.mjs \
  ./scripts/qualify-deployment-profiles.mjs --profile=customer-managed
```

Run `npm run qualify:deployment-profiles` to preflight both production profiles
with the same application image tag and compare their service topology.

Hosted deployments require HTTPS public and LiteLLM administration endpoints,
mutual-TLS material, remote `kasm` workspace execution, distinct credential and
session secrets, and broker-only Telegram credential intake.

`npm run worktree:init` writes the `worktree` selection for isolated local
development. A production consumer must call `resolveDeploymentProfile` with
`allowDevelopment: false` and reject it.

## Runtime use

Consumers import the profile package rather than interpreting raw environment
variables:

```ts
import {
  assertHostedCapability,
  resolveDeploymentProfile,
} from "@lemmacomputer/deployment-profile";

const profile = resolveDeploymentProfile(process.env.LEMMACOMPUTER_INSTALLATION_KIND, {
  allowDevelopment: process.env.NODE_ENV !== "production",
});

assertHostedCapability(profile.id, "backgroundJobs");
```

This only answers whether the deployment supports the capability. Every request
still requires organization-scoped RBAC authorization.
