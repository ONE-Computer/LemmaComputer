# ADR 0004: Governed official ACP runtimes

## Status

Accepted for Codex; Claude remains packaged but not enabled for governed
inference.

## Context

ONEComputer needs to run the official Codex and Claude ACP adapters without
placing provider credentials in a disposable agent home or filesystem. The
canonical ACP adapter already owns protocol negotiation, ordered event mapping,
permission requests, cancellation, timeouts, and path-confined filesystem
callbacks.

Codex ACP supports ACP provider negotiation through `providers/set`. Claude
Agent ACP does not currently expose an equivalent client-supplied provider
configuration.

## Decision

- Pin both official ACP packages in the workspace runtime image.
- Start runtimes with an explicit, allowlisted executable and a minimal
  environment; never inherit the host environment.
- Require a broker gateway for Codex. Advertise the provider capability,
  configure the `custom-gateway` provider before creating a session, and keep
  its scoped authorization header only in process memory.
- Route Codex through the OpenAI Responses-compatible LiteLLM endpoint.
- Supply a 32,768-token Codex model context window for non-native aliases.
  Without this metadata Codex uses fallback model metadata and requests an
  output budget larger than the Kimi Responses route accepts.
- Keep browser-based login disabled.
- Do not enable Claude for governed inference until its official ACP adapter can
  accept broker-provided, workload-scoped authority without writing a provider
  secret into its profile or filesystem.

## Verification

`npm run qualify:codex-acp` starts the real pinned Codex ACP binary in an
isolated home, configures the local LiteLLM gateway, streams a real Kimi turn,
checks the terminal event, and verifies that neither canonical events nor
diagnostics contain the gateway credential.

Unit tests also cover provider negotiation order, unsupported-provider failure,
environment confinement, and configuration redaction.

## Consequences

Codex ACP can be enabled behind the same broker-custodied model authority as the
rest of ONEComputer. A successful package install or ACP handshake alone is not
treated as runtime qualification. Claude support remains deliberately blocked
rather than weakening the credential boundary.
