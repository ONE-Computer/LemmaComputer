# Workspace node deployment

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

Set the workspace-node contract through `.env` and run `npm run env:check
-- --profile=hosted`. Remote deployments require the node URL and both private
application URLs to use HTTPS, complete client and server mTLS certificate
material, a private advertised desktop host, a private bind address, the
restricted application network, and workspace-ingress upstream TLS
verification. Certificate private keys remain with their owning workloads:
the node server key reaches only the node, the Control client key reaches only
Control, the ingress client key reaches only workspace ingress, and the
application-gateway client key reaches only the remote node controller.

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
See the [remote workspace-node and Cowork workflow](guides/development-workflow.md#remote-workspace-node-and-cowork-qualification) for the full
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
