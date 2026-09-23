# Activity in Chat

Activity is a sanitized, user-visible work trace for one agent turn. It shows
plans, progress, provider summaries, tools, web actions, sources, approvals,
computer actions, errors, and completion. It does not expose hidden reasoning,
raw tool payloads, prompts, screenshots, or an administrator log. The chat
transcript remains usable when Activity is closed or unavailable.

## What members see

Chat opens Activity for the latest turn or a selected earlier response. Desktop
and tablet use a right drawer; mobile uses a full-screen dialog. Repeated
updates for one action collapse into its current state. Source links open only
validated HTTP(S) destinations. The panel supports keyboard focus, Escape,
and polite live announcements.

If persistence is unavailable, a stream disconnects, or history has expired,
the panel shows a distinct neutral state. It never replaces the chat answer.

## Event and replay contract

`ActivityEventV1` carries a version, event and turn IDs, turn-local monotonic
sequence, timestamp, kind, state, provenance, fixed user visibility, and a
strict kind-specific payload. Provider-generated summaries are labelled as
summaries; they are not presented as verbatim hidden reasoning.

Control stores events before emitting the corresponding chat UI chunks. Replay
and live SSE endpoints are scoped to the authenticated workspace owner,
selected agent, session, and turn. SSE replays after a cursor, follows new
records, sends heartbeats, and closes after a terminal record. The browser
merges by event ID and sequence on reconnect. Unknown, removed, cross-user,
and cross-tenant scopes share the same unavailable response. Adapter retries
use a stable deduplication key.

```text
GET /v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions/:sessionId/turns/:turnId/activity?after=N&limit=200
GET /v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions/:sessionId/turns/:turnId/activity/stream?after=N
```

## Sanitization and persistence

Only allow-listed presentation fields are copied from agent events. The mapper
bounds text; removes credentials, URL userinfo, fragments, signed or token-like
query parameters; and rejects non-HTTP(S) links. New provider/tool-derived
fields need a redaction fixture and strict-schema denial test.

Activity events are append-only, tenant- and subject-scoped product records.
Workspace deletion and retention follow the product store contract. Existing
chat history is not backfilled into Activity. Deploy the explicit migration
before the new Control version; application startup does not migrate. Rolling
back to a compatible app version leaves the additive table in place.
