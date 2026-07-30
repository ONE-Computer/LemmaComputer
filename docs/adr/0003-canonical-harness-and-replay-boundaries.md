# ADR 0003: Canonical harness and replay boundaries

## Status

Accepted for the ONEVibe capability migration.

## Context

ONEComputer currently integrates Claude CLI, Codex CLI, and Hermes Agent through
native runtime adapters behind an agent-neutral HTTP bridge. ONEVibe also
contains Agent Client Protocol (ACP) clients and a task-level VCR. Copying those
systems would create competing session, approval, event, and replay authorities.

The product needs native harness fidelity, stable ACP interoperability, detached
turns, and a Manus-style workspace replay without exposing provider credentials,
hidden reasoning, raw tool payloads, or cross-tenant state.

## Decision

1. `AgentChatEvent` remains the sole live product event contract. Browser,
   scheduler, channel, project, and VCR consumers never depend on vendor or ACP
   messages.
2. Native and ACP implementations conform to one `HarnessAdapter` behavior:
   create/load a session, stream one ordered turn, request governed permission,
   cancel, and report negotiated capabilities.
3. ACP stable protocol v1 is supported through the official
   `@agentclientprotocol/sdk`. Experimental ACP v2 is not accepted until a
   separate compatibility ADR and conformance lane approve it.
4. ACP commands and arguments are projected from reviewed policy. They are
   never supplied by a browser request.
5. ACP permission requests fail closed unless Control resolves an exact
   governed operation. An adapter cannot auto-approve a tool.
6. Harness model traffic continues through the workspace-scoped credential
   broker and LiteLLM. ACP is a harness protocol, not a model-provider bypass.
7. Activity remains the redacted timeline index. Replayable workspace content
   is stored separately as encrypted, owner-scoped frames referenced by opaque
   identifiers.
8. VCR consumes canonical events and authorized frame references. It never
   records raw ACP traffic, provider payloads, chain-of-thought, credentials,
   cookies, or permanent signed URLs.
9. Turn execution will move behind a durable coordinator so browser disconnect
   does not define harness lifetime. Transcript, Activity, and VCR resume from
   persisted cursors.

## Consequences

- Claude, Codex, Hermes, and future ACP agents can use different native
  transports while producing identical chat and VCR behavior.
- ACP feature differences are visible through negotiated runtime capabilities.
- Supporting a new harness requires a conformance fixture and negative security
  tests, not changes to the browser protocol.
- Frame retention and Activity retention may differ; an expired frame leaves a
  truthful timeline marker and an unavailable-state viewer.
- ONEVibe task events and its mock VCR fallback are not migrated as authorities.

## Required verification

- ACP initialize/version/capability negotiation, session creation/load,
  streaming, cancellation, permission denial/selection, malformed frames,
  abrupt exit, timeout, stderr redaction, and path-confinement tests.
- Identical canonical golden stream across native and ACP fixtures.
- VCR sequence, checkpoint equivalence, owner/tenant isolation, redaction,
  retention, reconnect, rapid seek, historical buffering, and jump-to-live
  tests.
