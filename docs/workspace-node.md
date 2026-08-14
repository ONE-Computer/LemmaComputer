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
- workspace ingress to the node's private TLS desktop relay ports;
- node application relays to the two configured private HTTPS endpoints for
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
application URLs to use HTTPS, mTLS certificate material, a private advertised
desktop host, a private bind address, the restricted application network, and
workspace-ingress upstream TLS verification. Certificate private keys remain
with their owning workloads: the node server key reaches only the node and the
Control client key reaches only Control.

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

Before promotion, run `npm run qualify:deployment-profiles`, the focused
controller/adapter/ingress tests, and `npm run verify:quick`. In a representative
private node, also prove workspace start/open, governed model and tool traffic,
desktop reconnect through the TLS relay, egress allow/deny behavior, restart
persistence, cross-workspace substitution denial, verified purge, and secret-
free lifecycle audit events. KVM remains disabled on hosted multi-tenant nodes.
