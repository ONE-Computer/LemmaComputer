# ADR 0006: Hosted C-minus workspace-node placement and trust

- Status: Accepted
- Date: 2026-08-16

## Context

Hosted LemmaComputer must run user workspaces outside the shared Control
compute boundary. A workspace runtime and its persistent home are stateful and
node-local, so treating workspace nodes as interchangeable load-balanced
capacity can send lifecycle or deletion requests to a node that does not own
the data.

Private networking alone does not authenticate either side of the remote-node
connection. Control must know which private node it reached, and the node must
reject callers that are not the authorized Control workload. Placement records
must not contain private keys or turn an operator-entered URL into authority by
itself.

The first hosted deployment also needs a shape that can be operated before
automatic scheduling, node replacement, and live migration are safe. Those
later controls must not weaken the initial sticky ownership invariant.

## Decision

Hosted C-minus uses an operator-managed registry of logical workspace nodes and
sticky, persisted placement:

- each node has a stable logical ID, private HTTPS endpoint, expected TLS server
  name, and operator-controlled admission state;
- each tenant has one default node assignment for new workspaces;
- each workspace copies that node ID into its own persisted record before
  provisioning; and
- every later lifecycle and verified-purge request resolves through that
  recorded workspace owner, not through a load balancer or the tenant's current
  default.

Only the separate workforce operator realm may register nodes or change tenant
placement. Registration and assignment are audited. `active`, `draining`, and
`disabled` are admission states; they are not claims of live node health.

Every remote workspace-node API connection uses HTTPS mutual TLS plus the
internal node bearer credential. Control verifies the node server certificate
against the registered TLS server name. The node verifies the Control client
certificate and expected workload identity before accepting the application
credential. Remote topology fails closed when this material is incomplete.

The deployment supplies the private CA or workload-identity system and issues
the leaf certificates. Certificate private keys remain with their owning
workloads and never enter the node registry. The CA signing key is not deployed
to Control or workspace nodes. Infrastructure-specific certificate issuance is
outside the product architecture; disposable local qualification authorities
are test material only.

C-minus deliberately excludes node heartbeats, capacity scoring, automatic
failover, fungible replacement, and live workspace migration. An operator
registers a provisioned node and assigns a tenant manually. An unreachable node
fails when Control attempts a lifecycle call; registration alone does not prove
reachability.

## Consequences

Infrastructure must provide a stable logical node ID, resolvable private HTTPS
endpoint, matching server certificate name, complete mutual-TLS identities, and
the internal application credential before an operator registers the node. A
cloud instance identifier or changing private IP is infrastructure attachment
metadata, not the product's stable node identity.

Recovering a failed node must fence the old controller and restore exclusive
ownership of its persistent storage before private DNS or infrastructure
attachment is moved to a replacement instance. Control must never silently
recreate the workspace on another node.

Operator surfaces must distinguish admission from observed health when a future
heartbeat protocol is added. Until then, `active` means only that the operator
permits placement. Deployments that promise one dedicated tenant per node must
enforce that entitlement in application/database policy or retain it as an
explicit, audited operating limitation; the C-minus registry does not infer it
from SSO or cloud tags.

## Related documents

- [Workspace node deployment](../architecture/workspace-node.md)
- [Deployment profile capability contract](0003-deployment-profile-capability-contract.md)
- [Evaluation, development, and remote workspace workflow](../guides/development-workflow.md)
