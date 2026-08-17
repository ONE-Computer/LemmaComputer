# Workspace node deployment

The rationale for sticky placement and the remote mutual-TLS trust boundary is
recorded in [ADR 0006](../adr/0006-hosted-c-minus-workspace-node-placement-and-trust.md).

LemmaComputer has one Docker/KasmVNC workspace runtime and two placements. A
`colocated` node runs beside the reference application stack for
customer-managed installations and worktrees. A `remote` node runs the same
workspace image and adapter in a private compute boundary. Hosted deployments
require `remote`; they do not use the commercial Kasm control plane or its
Developer API.

Control never receives Docker authority. It calls the workspace-bound
`/internal/v2/workspaces/:workspaceId/...` node API. Remote calls use HTTPS,
mutual TLS, the internal bearer credential, and the stable node identity.
Create and egress changes additionally carry a signed policy bundle bound to
tenant, subject, workspace, access generation, policy digest/key, and fixed
gateway/Control routes. The node rechecks the provider's workspace label on
status, open, egress update, and destroy so a provider ID cannot be substituted
across workspaces.

## Hosted C-minus placement

Hosted Control uses a durable registry rather than load-balancing lifecycle
requests across node controllers. The registry stores a stable node id, private
HTTPS endpoint, expected certificate name, and one of `active`, `draining`, or
`disabled`. It does not store private keys or bearer credentials. A tenant has
one default node assignment for new workspaces, and every created workspace
copies that node id into its own row. Changing the tenant default therefore
affects only future workspaces; status, open, policy update, restart, stop,
delete, and tenant-cleanup calls continue to use each workspace's persisted
owner.

Only a step-up-authenticated platform administrator can mutate placement:

- `POST /v1/platform/workspace-nodes` registers a private node endpoint;
- `PATCH /v1/platform/workspace-nodes/:workspaceNodeId/state` drains or
  disables a node;
- `PUT /v1/platform/tenants/:tenantId/workspace-node` changes the default for
  new workspaces; and
- the corresponding GET routes expose nodes and assignments to the platform
  operator realm, never the customer realm.

The platform operator UI exposes those registry, admission, and assignment
operations. It also writes `workspace.defaultSharedNodeId` through the audited
platform-configuration boundary. When that setting names an active registered
node, hosted self-service onboarding atomically assigns new personal and
organization tenants to it. The worktree development harness mirrors this
placement rule in its real database; remote-node qualification then makes the
persisted assignment authoritative for runtime routing so the same onboarding
path is testable before hosted qualification. A missing setting leaves explicit
operator placement available; a configured but invalid or unavailable node fails
onboarding closed instead of silently choosing another node. Dedicated
placement is an explicit operator or entitlement decision and is never inferred
from SSO configuration.

Registration starts a node as `active`. A draining node owns and serves its
existing workspaces but is not eligible when a new workspace copies its tenant
assignment. A disabled node is fail-closed for all routed lifecycle calls.
Before disabling a node, operators must destroy or otherwise disposition its
persisted workspaces. For a first upgrade from the previous single-node hosted
shape, the assignment request may explicitly backfill unplaced workspace rows;
that option is safe only when the operator has confirmed that the registered
node is their actual legacy owner. Every mutation and backfill count is written
to the platform audit ledger.

The C-minus scheduler deliberately has no heartbeat, capacity scoring,
automatic failover, or live workspace migration. An absent assignment, absent
workspace owner, node mismatch, disabled node, or purge receipt bearing another
node id fails closed. These omissions buy a productionizable multi-node shape
without pretending that rescheduling a stateful Docker volume is safe.

Control selects placement-aware routing from workspace-node topology, not from
the deployment-profile name. `remote` topology in hosted and in the worktree
development harness resolves every lifecycle call through the persisted
workspace owner in the node registry. `colocated` development and
customer-managed single-node deployments retain the explicitly configured
direct controller client. This lets local remote qualification exercise the
same C-minus router used by hosted without pretending that local Compose is AWS.

## Remote network contract

Expose only these private paths:

- Control to node API over mTLS HTTPS;
- workspace ingress to the node's private mTLS desktop relay ports;
- node application relays over mTLS to the two configured private endpoints for
  LiteLLM and Control;
- the governed per-workspace egress proxy to its inspected egress network.

The per-workspace network is Docker-internal. Workspaces receive fixed local
aliases (`lemmacomputer-gateway` and `lemmacomputer-control`), not arbitrary
upstream destinations. Hardened relay containers alone join the pre-created
application network and validate the configured upstream CA. Do not attach the
workspace container to an application, control, default-bridge, host, or
general outbound network. Block instance metadata at routing and firewall
layers as well as in the governed proxy.

Workspace containers drop the entire Docker default Linux capability set, then
add only `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, and `SETUID`. The root
entrypoint needs these capabilities to repair ownership and modes, replace
root-managed configuration inside the user-owned persistent home, and enter
the fixed `kasm-user` UID/GID during initialization. The final desktop process
runs as UID/GID 1000 without effective capabilities. Electron sandboxing and
Cowork add no capability; in particular, the runtime does not add network,
namespace, mount, device, `MKNOD`, or `SYS_CHROOT` capabilities.

## Optional workspace capabilities

Applications and AI agents are selections inside one workspace contract; they
are not separate workspace modes. Both arrays may be empty. An empty selection
still provisions the sandbox, persistent home, desktop service, and
authenticated desktop ingress relay. The node exposes no catalog application
launchers, starts no agent broker, receives no model alias or gateway grant,
and creates no LiteLLM or Control application relay. Public egress remains a
separate policy decision and may still require the governed egress proxy.

Selecting the first AI agent makes a model alias mandatory and causes Control
to issue only that agent's governed gateway and bridge authority. Removing the
last agent sets the model selection to null and revokes the workspace's AI
grants. Selecting applications exposes only their reviewed launchers; it does
not imply an AI provider or agent runtime.

## Chromium and Electron process sandbox

The application boundary and reasons for catalog gating are recorded in
[ADR 0005](../adr/0005-catalog-gated-electron-sandbox.md). The profile below is
not a general-purpose compatibility mode: only release-qualified application
identifiers can select it, and software installed inside a workspace cannot
change the enforced container profile.

Chrome, Visual Studio Code, and Obsidian must run with their upstream Chromium
sandbox enabled. A workspace that selects any of those applications receives
the fixed `lemmacomputer-workspace-electron` AppArmor profile. The profile
retains Docker's default confinement shape and adds only the AppArmor `userns`
permission needed by Chromium when `no-new-privileges` is active. Its seccomp
profile retains the pinned Moby default and adds three argument-filtered rules:
`clone` and `unshare` are allowed when the `CLONE_NEWUSER` bit is present, and
one additional `clone` rule permits exactly `CLONE_NEWPID` among the namespace
flags. Chromium needs that PID-only transition after it has entered the
unprivileged user namespace. The kernel still requires the caller to hold the
relevant capability in its current user namespace. `clone3` retains Moby's
`ENOSYS` fallback, unrelated namespace combinations remain denied, and
Cowork's `AF_VSOCK` exception is absent unless Cowork is also selected. The
runtime must not use `--no-sandbox`, `apparmor=unconfined`,
`seccomp=unconfined`, a privileged container, added capabilities, or the host
PID/user namespace to make these applications start.

This exception is scoped to the selected workspace container, not to an
individual process inside it. All processes in that container can request a
user namespace, while the AppArmor, seccomp, capability, network, storage, PID,
and memory boundaries continue to constrain the resulting processes. A hosted
deployment may enable this profile only on a remote workspace node. The node
capability switch, exact enforced profile label, and an unprivileged namespace
probe are all fail-closed preconditions to workspace readiness.

Set the workspace-node contract through `.env` and run `npm run env:check
-- --profile=hosted`. Remote deployments require the bootstrap/qualification
node URL and both private
application URLs to use HTTPS, complete client and server mTLS certificate
material, a private advertised desktop host, a private bind address, the
restricted application network, and workspace-ingress upstream TLS
verification. Certificate private keys remain with their owning workloads:
the node server key reaches only the node, the Control client key reaches only
Control, the ingress client key reaches only workspace ingress, and the
application-gateway client key reaches only the remote node controller.
Hosted Control uses the registry endpoint and certificate name for each
lifecycle call; the configured Control client CA/certificate/key and internal
node token are shared C-minus credentials and should be rotated as a single
node-fleet trust domain. Per-node credentials are a later hardening step, not a
prerequisite for sticky routing.

## Storage and removal

Persistent homes are Docker volumes named and labeled by workspace and access
generation. Encrypt the node's Docker data root with the platform's managed
block-storage encryption and restrict snapshots/backups to the same tenant and
operator boundary. Runtime destroy preserves the home volume. Permanent delete
removes only volumes at or below the authorized generation, re-enumerates the
node, and returns a verified purge receipt. Control must not mark purge
complete without that receipt.

Removal order is: stop assigning new work, drain/destroy runtimes, execute and
retain verified purge receipts, remove node credentials from Control, revoke
the client/server certificates and internal token, remove private ingress and
application-network routes, then destroy encrypted disks and snapshots under
the platform retention policy. A failed verification is retryable and must
leave the cleanup operation incomplete.

## Qualification

Run `npm run qualify:internal-mtls` locally to exercise the long-lived service
mTLS listeners in one shot: Control to the LiteLLM administration listener and
Control to a remote workspace node. The qualification creates separate
ephemeral test CAs and Control leaf keys, starts the real TLS listeners with
mock non-TLS backends, and proves accepted identity plus missing-certificate,
wrong-identity, wrong-token, cross-CA, and hostname rejection. It does not
install or reuse a developer CA.

Desktop ingress and node application relay routes also require client
certificates. Their focused tests prove an actual workspace-ingress handshake,
node relay identity enforcement, and application-relay client-key projection.

An isolated development worktree can run the same split boundary without
manually creating Compose overlays or copying a database:

```bash
npm run qualify:remote-workspace-node -- up --cowork
npm run qualify:remote-workspace-node -- status
npm run qualify:remote-workspace-node -- down
```

The command creates short-lived worktree-local test authorities and preserves
the worktree's existing users, organizations, providers, policies, databases,
and volumes. It is qualification tooling, not production PKI automation.
See the [remote workspace-node and Cowork workflow](../guides/development-workflow.md#remote-workspace-node-and-cowork-qualification) for the full
architecture, mTLS matrix, exact setup sequence, generated Compose topology,
manual acceptance checklist, hosted gaps, and troubleshooting.

Before promotion, also run `npm run qualify:deployment-profiles`, the focused
controller/adapter/ingress tests, and `npm run verify:quick`. In a representative
private node, prove workspace start/open, governed model and tool traffic,
desktop reconnect through the TLS relay, egress allow/deny behavior, restart
persistence, cross-workspace substitution denial, verified purge, and secret-
free lifecycle audit events. Hosted Claude Cowork additionally requires a
remote node with nested virtualization, `/dev/kvm`, and `/dev/vhost-vsock`;
the colocated hosted topology remains fail-closed.
