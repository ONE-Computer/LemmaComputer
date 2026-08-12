# Product policy release artifacts

`product-release-trust.json` is the explicit public trust root for protected
workspace baselines. It contains Ed25519 public keys only. Release signing
private keys must remain in the release-signing environment and must never be
written to this repository, tenant configuration, or the product database.

Files in `protected-baselines/` are deterministic RFC 8785 payload envelopes
signed by a product-release key. Installations verify an envelope against the
checked-in trust root before copying it into tenant-scoped immutable policy
history. Organization policy can only narrow that protected baseline.

The Phase 0.5 office-worker baseline deliberately preserves both supported
browsers and the complete LibreOffice-based office workspace. It permits only
the Claude Desktop and Claude CLI agent catalog entries; Hermes and Codex remain
outside this baseline. The bounded Microsoft 365 office-tool allowlist retains
its reviewed allow versus approval-required decisions; unlisted tools remain
outside the product ceiling.

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
