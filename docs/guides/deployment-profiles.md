# Deployment profiles

LemmaComputer supports two production deployment profiles from the same product
codebase and application image. `worktree` is an isolated development mode, not
a third product edition.

Keep four independent questions separate:

- deployment ownership is `customer-managed` or `hosted`;
- runtime safety is `development` or `production`;
- workspace-node topology is `colocated` or `remote`; and
- a Git worktree is only a checkout and Docker namespace isolation mechanism.

The existing `LEMMACOMPUTER_INSTALLATION_KIND=worktree` value is retained as a
compatibility selector for development-only fixtures and relaxed loopback
requirements. It must be described as the **worktree development harness**, not
as a third production profile. In particular, node routing must follow
`LEMMACOMPUTER_WORKSPACE_NODE_TOPOLOGY`; it must not infer topology from the
installation-kind name.

| Capability | `customer-managed` | `hosted` | `worktree` |
| --- | --- | --- | --- |
| Operator | Customer | LemmaComputer | Developer |
| Organizations | Exactly one | Multiple | Development fixtures |
| Customer authentication | Embedded Better Auth; installation-local database | Embedded Better Auth; pooled control-plane database | Embedded Better Auth; isolated development database |
| Customer methods eligible for configuration | Email/password, passkey, Google, Microsoft, SAML, OIDC | Email/password, passkey, Google, Microsoft, SAML, OIDC | Production methods plus development fixtures |
| Platform-operator realm | Absent | Separate Better Auth passkey realm | Separate Better Auth passkey realm with local bootstrap |
| Identity and secret custody | Customer deployment | LemmaComputer deployment | Local worktree |
| Workspace provider boundary | Customer-approved local or remote-isolated | Platform-qualified remote-isolated | Development adapters |
| Connector administration | Customer operator | Organization administrator | Developer |
| Usage accounting | Local | Hosted | Development |
| Hosted telemetry and billing | Denied | Allowed | Denied |
| Hosted background jobs | Denied | Allowed | Denied |
| LemmaComputer-managed control plane | Not required | Allowed | Development-only |

“Allowed” means the deployment profile is eligible for that implementation; it
does not grant product authority. Both production profiles use the same Better
Auth customer contract. Better Auth proves authentication; server-resolved
LemmaComputer account, membership, active organization, permission, and resource
scope decide product access. Direct workforce-Entra and External ID adapters
are not part of any supported profile.

The workspace row separates runtime from placement. `hosted` forbids Docker
authority on an application/control host and requires the Lemma-owned
Docker/KasmVNC runtime on a private remote workspace node. Every deployment
must qualify tenant projection, signed-policy projection, governed egress,
lifecycle audit, and verified purge; a topology check alone is not production
qualification. The hosted runtime contract also includes Claude Cowork, so its
representative remote nodes require nested virtualization, `/dev/kvm`, and
`/dev/vhost-vsock`; a browser-only or non-Cowork workspace smoke is not hosted
acceptance. See the [remote workspace-node and Cowork workflow](development-workflow.md#remote-workspace-node-and-cowork-qualification) for the
local split qualification and its explicit hosted evidence gaps.

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

The embedded Better Auth runtime is the only customer-authentication path in
both production profiles. A customer-managed installation keeps its
authentication database, signing secrets, email delivery, and enabled
providers inside the installation.

Tenant-configured company SSO is registered through the authenticated
organization administration flow and cannot assign product roles from provider
claims. A customer-managed deployment may place the Lemma-owned
`docker-kasmvnc` node locally or remotely. Hosted requires the same runtime on a
private remote node. No commercial Kasm control-plane credential or generated
LemmaComputer-hosted identity is part of this contract.

The checked-in network-deny smoke disables Node DNS, HTTP, HTTPS, TCP, TLS, and
Fetch APIs before running the customer-managed preflight:

```bash
node --import ./tests/fixtures/deny-node-network.mjs \
  ./scripts/qualify-deployment-profiles.mjs --profile=customer-managed
```

Run `npm run qualify:deployment-profiles` to preflight both production profiles
with the same application image tag and compare their service topology.

Hosted deployments require HTTPS public and LiteLLM administration endpoints,
mutual-TLS material, a platform-qualified remote-isolated workspace provider,
distinct credential and authentication secrets, and broker-only Telegram
credential intake. Hosted platform enrollment additionally requires an
explicit operator email and a one-time bootstrap secret on first deployment.
After passkey enrollment, remove the bootstrap secret from secret custody; the
runtime continues with the passkey credential. The configuration contract recognizes
`colocated` and `remote` workspace-node topology; recognition is not a claim
that a particular infrastructure deployment has completed qualification.

`npm run worktree:init` writes the `worktree` harness selection for
isolated local development. Its loopback-only platform sign-in provisions one
local operator into the real platform role store, enrolls a passkey, then deletes the generated
bootstrap credential and its sessions. It uses a separate authentication
database, database roles, signing secret, and cookie prefix from customer
authentication. A production consumer must call `resolveDeploymentProfile`
with `allowDevelopment: false` and reject it.

Use `/platform` as the public operator entry. It redirects to the server-rendered
operator document under `/api/v1/platform/ui` so the platform session cookie
can remain narrowly scoped to the platform API boundary. The customer product
and platform operator sessions are still separate realms.

## Runtime use

Consumers import the profile package rather than interpreting raw environment
variables:

```ts
import {
  assertCustomerAuthenticationMethodAllowed,
  assertHostedCapability,
  resolveDeploymentProfile,
} from "@lemmacomputer/deployment-profile";

const profile = resolveDeploymentProfile(process.env.LEMMACOMPUTER_INSTALLATION_KIND, {
  allowDevelopment: process.env.NODE_ENV !== "production",
});

assertHostedCapability(profile.id, "backgroundJobs");
assertCustomerAuthenticationMethodAllowed(profile.id, "email-password");
```

This only answers whether the deployment supports the capability. Every request
still requires organization-scoped RBAC authorization.
