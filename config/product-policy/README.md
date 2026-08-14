# Product policy release artifacts

`product-release-trust.json` is the explicit public trust root for protected
workspace baselines. It contains Ed25519 public keys only. Release signing
private keys must remain in the release-signing environment and must never be
written to this repository, tenant configuration, or the product database.

Files in `protected-baselines/` are deterministic RFC 8785 payload envelopes
signed by a product-release key. Installations verify an envelope against the
checked-in trust root before copying it into tenant-scoped immutable policy
history. Organization policy can only narrow that protected baseline.

The Phase 0.5 office-worker baseline preserves both supported browsers and the
complete LibreOffice-based office workspace. The bounded Microsoft 365
office-tool allowlist retains its reviewed allow versus approval-required
decisions; unlisted tools remain outside the product ceiling.

### Pending authorized baseline successor

The current signed v1 envelope predates the workspace-choice contract now used
by the product. Its signature must not be edited or replaced in a development
worktree. The next authorized release-signed version must:

- allow the complete reviewed agent catalog: Claude Desktop, Claude CLI, Codex
  CLI, Hermes Agent Desktop, and Hermes Agent CLI;
- allow only Lite, Balanced, and Pro service classes and deny legacy Auto;
- deny `kasm-persistent-standard` for new assignments while retaining runtime
  compatibility for assignments pinned to the immutable v1 envelope;
- retain `lemmacomputer-auto` only as the internal governed-routing alias and
  remove provider/model aliases as member-selectable policy concepts; and
- decide explicitly whether `disposable-open-v1` belongs in the product ceiling.

Until that successor and its predecessor-aware installation path are supplied,
Control remains pinned and fail closed to the signed v1 agent and
workspace-profile ceiling. The web application hides stale Auto,
provider-route, and legacy-profile choices but does not broaden the verified
allow set.

## Effective-policy consumer contract

Control resolves a member assignment from the exact immutable template and
organization-policy versions recorded with that assignment. The resulting
`EffectiveProtectedWorkspacePolicy` is a deny-wins ceiling over the legacy
workspace policy before settings are returned, saved, or projected into a
runtime grant. An assigned member cannot select an excluded workspace profile,
agent, application, model alias, service class, egress mode, connector, or
connector tool through either the browser or Control API. Members may continue
to choose any application and agent that remains inside the effective allow
set.

The effective read model exposes the template/version/hash, every contributing
source, the allowed values, the member's selected defaults, and a deterministic
effective hash. Connector-policy work must project real connector enablement
and reviewed tool decisions into the `connectorPolicies` resolver input; model
thinking-level work must compare the requested level with
`allowed.maximumReasoningEffort`. Neither consumer may broaden the resolved
allow set or silently substitute an unrecorded policy version.

Changing an assignment appends a new tenant-scoped version. Existing workspace
images may require a restart for application or agent image choices to change;
the administration UI calls this out for any non-stopped workspace. New starts,
restarts, settings writes, and refreshed runtime grants resolve the current
assignment and fail closed when a pinned source is unavailable. Revocation also
appends a version and blocks workspace settings, starts, and restarts until an
administrator records a replacement assignment; it never falls back to the
weaker legacy policy.
