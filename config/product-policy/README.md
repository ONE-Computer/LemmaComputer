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
