# Activity panel

Chat can open a turn-scoped **Activity** panel beside the transcript. It shows the sanitized `ActivityEventV1` records that ONEComputer is allowed to present to the employee: plans, progress, provider summaries, tools, web actions, sources, approvals, computer actions, notices, errors, and completion.

Activity is a work trace: it explains the agent's visible approach, the actions it took, the sources it referenced, and the outcome. Provider-generated approach summaries carry an explicit label. The panel is not a chain-of-thought, hidden-reasoning, or administrator-observability view. The transcript remains understandable when Activity is closed or unavailable.

The work trace favors human descriptions over runtime telemetry:

- the provider's visible pre-tool explanation becomes the turn's **Approach**;
- repeated running and completed updates for one tool call render as one evolving action;
- Lifecycle updates with the same plan, progress, tool-call, web-action, or source identity collapse into one current row.
- supported web tools show the sanitized search, open, or find action rather than a duplicate raw tool row;

## Using the panel

- Activity starts closed. Desktop and tablet open it as a viewport-anchored right drawer without reflowing the transcript; mobile uses a full-screen dialog.
- Timeline connectors occupy only the gap between consecutive cards; they do not run through card content or icons.
- The Activity button opens the latest turn. **View activity** on an assistant response opens that completed turn’s retained history.
- Source and webpage links open only validated HTTP(S) destinations in a separate, isolated tab.
- The computer-view area is an extension slot for issue #17. Issue #16 does not connect, lease, or control Kasm.

The dialog supports ordinary keyboard navigation, Escape to close, focus containment, and focus return. New live updates are announced politely without repeatedly reading the whole timeline.

## Replay and reconnect

On open, Web replays the selected turn from sequence `-1`, merges by event ID and sequence, and orders rows monotonically. For an incomplete turn it then follows the SSE endpoint after the last replayed sequence. A disconnected stream leaves saved rows visible, announces reconnection, replays from its last cursor, suppresses overlap, and resumes the live stream. A terminal event closes the client stream.

The panel uses the authenticated workspace, agent, session, and turn already selected by Chat. A guessed, removed, expired, cross-user, or cross-tenant turn produces the same unavailable state and never renders another owner’s payload.

## Deployment and degraded states

The feature uses the same Web code in `hosted` and `customer-managed` profiles. Hosted analytics are not required. If a customer-managed deployment disables Activity persistence or runs a compatible Control version without retained Activity, the transcript continues normally and the panel explains that Activity history is unavailable.

Retention expiry does not remove chat history. It replaces the timeline with a neutral expired state. Loading, empty, disconnected, expired, persistence-unavailable, and request-error states are distinct and do not expose internal identifiers.

## Rollback

Rolling Web back to the prior compatible SHA removes the panel without changing chat or persisted events. Leave the additive `activity_events` table and Control replay endpoints in place; the forward-only issue #6 migration remains compatible and can be consumed again by a later Web deployment.
