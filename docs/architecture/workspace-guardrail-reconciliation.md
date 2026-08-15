# Workspace guardrail reconciliation

Organization workspace guardrails are immutable, versioned constraints over
workspace types, applications, agents, service levels, reasoning effort, and
data transfer. A new organization version is a security-policy transition, not
just a settings update. LemmaComputer must not leave an already-running
workspace authorized by an older version after the new version becomes current.

This document defines the publication, suspension, reconciliation, and recovery
contract shared by the `customer-managed` and `hosted` deployment profiles.

## Authorities and invariants

- Control is the authority that creates organization guardrail versions.
- The workspace store is the tenant-scoped inventory and lifecycle authority.
- The workspace node owns runtime destruction; Control never receives its
  Docker socket.
- The gateway owns workspace and agent request grants and must revoke them
  independently of runtime destruction.
- Saved workspace selections are subordinate to the effective organization
  policy. A saved value cannot grandfather access removed by a later version.
- A new immutable version is not created until every workspace in the
  publication inventory has been safely suspended or was already stopped.
- One incompatible workspace must remain visible as `action_required`; it must
  not make the member's complete workspace inventory disappear.

## Publication sequence

`POST /v1/admin/protected-workspace-policy/organization-versions` performs one
ordered transition:

1. Authorize `policy.manage` and validate the complete proposed constraints and
   required revision note. Unqualified agents or unsupported reasoning levels
   are rejected before any workspace mutation.
2. Enumerate every current workspace for the tenant, including workspaces owned
   by other members.
3. Suspend the inventory in parallel. A `not_created` or `stopped` workspace
   has its gateway workspace grant revoked and needs no provider destruction.
   A `ready`, `open`, `provisioning`, `restarting`, or `failed` workspace is
   compare-and-set to `stopping`, its access generation is advanced, its access
   grants are revoked, its provider runtime is destroyed, its gateway grants
   are revoked, and it finishes as `stopped` with no provider identifier.
4. If any suspension fails, return the retryable
   `WORKSPACE_POLICY_TRANSITION_FAILED` error and do not create the new policy
   version.
5. After every suspension succeeds, create the immutable organization policy
   version.
6. Reconcile each workspace's saved selection against the new effective policy.
   Preserve still-allowed choices and remove choices that are no longer
   assigned. Persist the reduced selection only when it remains complete.
7. Return an enforcement summary containing `stopped`, `alreadyStopped`,
   `reconciled`, and `actionRequired` counts.

The operation is fail-closed at policy publication, but it is not a distributed
transaction across workspace providers. If one provider cleanup fails after
other workspaces were stopped, the new version is not created and the already-
stopped workspaces remain safely stopped. Retrying is expected: stopped
workspaces take the idempotent revocation path, while unresolved cleanup is
attempted again.

## Selection reconciliation

Reconciliation computes a complete selection across these dimensions:

- workspace profile;
- application identifiers;
- agent identifiers;
- model alias or governed Auto route; and
- requested service class.

For existing saved settings, list-valued choices are intersected with the new
allowlist. A profile, model, or service class that is no longer allowed cannot
be silently replaced with an unrelated choice. If at least one allowed
application and agent remain and every scalar choice remains valid, Control
persists the compatible subset. If any required dimension becomes empty or
invalid, the workspace is marked `action_required` with
`WORKSPACE_POLICY_SELECTION_REQUIRED`.

Legacy workspaces without saved sandbox settings adopt the constrained policy
defaults. They do not fail merely because the settings row predates this
mechanism.

An `action_required` workspace stays in inventory with a **Review
configuration** action. It cannot start until an administrator or authorized
member chooses a complete compatible configuration.

## Runtime defence in depth

Publication-time suspension is the primary mechanism. Runtime reads also check
the policy version and digest projected by the provider. If a ready or open
runtime reports an older projection, Control suspends it and returns
`restart_required` rather than restoring access under stale policy.

Workspace listing isolates known compatibility errors per record. It attempts a
safe suspension and returns the affected workspace with `action_required`
instead of rejecting the entire list. This is the recovery path for legacy
rows, interrupted publications, and drift discovered after publication.

## User-visible states

| State | Meaning | Required action |
| --- | --- | --- |
| `current` | The running workspace projection matches the effective policy. | None. |
| `applies_on_next_start` | The workspace is stopped or not yet created. | Start it when needed; the new policy is projected at start. |
| `restart_required` | A stale or changed projection was detected and the runtime was suspended. | Restart the workspace. |
| `action_required` | The saved selection cannot form a complete configuration under the effective policy, or cleanup needs intervention. | Review configuration or resolve the reported cleanup failure. |

The administration UI warns before publication whenever any workspace is not
`not_created` or `stopped`. Confirmation explicitly states that current access
will be revoked and affected workspaces will be stopped. Cancelling the warning
does not publish a version or mutate workspaces. The warning count is an
advisory browser snapshot; Control re-enumerates the authoritative tenant
inventory when it receives the save request.

## Security properties and limits

- Advancing `access_generation` invalidates previously issued ingress access.
- Gateway revocation is required even when the provider runtime has already
  disappeared.
- Provider destruction is required before a new version becomes current.
- Runtime launch always derives a fresh policy projection from the current
  effective version; it does not reuse the old runtime bundle.
- Reconciliation never expands a saved selection beyond the new policy.
- A successful immutable policy write is not rolled back because one selection
  later needs human action; that state is explicit and recoverable.

This mechanism does not provide simultaneous stop time across all nodes, nor an
atomic transaction with an external provider. The current implementation also
does not hold a tenant-wide publication fence shared with workspace start and
restart commands. A command racing in the narrow interval after its workspace
was suspended but before the version write can briefly launch with the previous
version. The runtime version-and-digest check suspends that stale projection on
the next read, but publication is not strictly linearizable with concurrent
starts. Operators should use a maintenance window for disruptive changes. A
future high-assurance implementation should add a tenant-scoped publication
generation or lock checked by both publication and runtime commands.

## Operational procedure

See [Changing organization workspace guardrails](../guides/operations.md#changing-organization-workspace-guardrails)
for the administrator warning, expected results, failure recovery, and
verification steps.
