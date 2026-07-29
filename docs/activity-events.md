# Activity event protocol

ONEComputer projects agent activity into a versioned, user-visible event stream. `ActivityEventV1` is a sanitized product contract, not a chain-of-thought or administrator-observability feed.

## Event contract

Every event contains:

- `version`, `eventId`, `turnId`, a turn-local monotonic `sequence`, and `timestamp`;
- `kind`, lifecycle `state`, `provenance`, and the fixed `user` visibility;
- a strict kind-specific payload.

Version 1 supports `plan`, `progress`, `provider_summary`, `tool`, `web_action`, `source`, `approval`, `computer_action`, `notice`, `error`, and `terminal`. Deterministic Control-generated events use `deterministic_system`; provider-written summaries use `provider_generated`; tool lifecycle and actions use `tool`. Provider summaries must never be described as verbatim hidden reasoning.

The existing chat event stream remains the transcript transport. Control maps its canonical agent events into Activity records before emitting the corresponding chat UI chunks, so a client that learns a turn ID can immediately replay Activity sequence 0.

## Replay and live stream

Both endpoints are scoped by the authenticated workspace owner, selected agent, session, and turn:

```text
GET /v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions/:sessionId/turns/:turnId/activity?after=N&limit=200
GET /v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions/:sessionId/turns/:turnId/activity/stream?after=N
```

Replay returns events whose sequence is greater than `after`, plus the last returned sequence and whether the terminal record has been reached. The live endpoint uses Server-Sent Events, accepts either `after` or `Last-Event-ID`, replays before following new records, emits heartbeat comments, and closes after the terminal record. Control polls the durable store, so reconnect and multi-process delivery do not depend on process-local subscriptions.

Unknown, guessed, cross-user, and cross-tenant scopes return the same not-found response and do not reveal whether another owner's turn exists. Adapter retries use a stable per-source deduplication key; the store returns the original record rather than assigning another sequence.

## Sanitization boundary

The Activity mapper only copies allow-listed presentation fields. It normalizes and bounds text, removes bearer tokens and common credential formats, strips URL credentials, fragments, signed query parameters, and token-like query parameters, and rejects non-HTTP(S) links. Raw tool arguments, cookies, prompts, provider payloads, screenshots, page contents, and hidden reasoning are not fields in the persisted schema. Computer events may carry only sanitized labels and opaque, non-URL viewer references.

Treat additions to Activity payloads as security-sensitive contract changes. Add a redaction fixture and a strict-schema rejection case before introducing any field derived from provider or tool output.

## Persistence and deployment

Migration `01KYP75DVZZZTR9G9K2W753AX5_activity_events.sql` adds one append-only, tenant- and subject-scoped table with replay and retention indexes. It is additive, transactional, and shared by hosted and customer-managed profiles. Workspace deletion cascades Activity records. Application startup only checks compatibility; the explicit migration job must apply the migration before deploying this Control version.

The migration takes ordinary short schema locks to create a new table and indexes; it does not rewrite or backfill existing tables. No existing chat history is synthesized into Activity events.

Rollback the application to the previous compatible SHA if Control must be reverted. Leave the expanded table in place so the migration remains forward-only and rollback-safe; a later dedicated contraction may remove it only after the normal backup, retention, and restore review.
