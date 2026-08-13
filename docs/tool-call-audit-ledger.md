# Tool-call compliance ledger

The tool-call ledger records one terminal compliance event for every connector tool invocation admitted by Control. The workspace loopback broker owns the invocation identity and terminal classification; callers cannot supply or reuse that identity through the public tool request.

## Recorded evidence

Each terminal contains tenant, member, workspace, logical agent, agent-process instance, execution context, connector and tool identity, policy decision and version, approval-operation reference when applicable, bounded target summary, timestamps, latency, correlation ID, and terminal outcome.

The schema deliberately has no prompt, tool arguments, tool result, model reasoning, credential, bearer token, signed URL, or arbitrary provider-payload column. Microsoft 365 target labels pass through the server-owned redaction function. Generic connectors receive only the fixed summary `Connector tool invocation` until a connector-specific reviewed schema exists.

## Completion semantics

- Policy denials and approval holds become terminal in the same transaction as admission.
- Allowed calls remain pending until the workspace broker reports success, failure, timeout, or cancellation under the same authenticated agent-process identity.
- Admissions without terminal evidence after five minutes become `unconfirmed`. This is an explicit degraded result, never an inferred success.
- The exact pinned LiteLLM qualification demonstrates that exceptional MCP paths do not always invoke a post-call hook. LiteLLM hooks therefore cannot be the terminal source of truth.

## Storage and retention handoff

`tool_audit_events` is range-partitioned monthly by `completed_at`. Control creates the current month and the next three months at startup under a PostgreSQL advisory lock. A default partition is a safety net, not the intended steady-state location.

Hourly and daily aggregate tables retain counts and latency totals without member, workspace, agent-instance, target, or correlation detail. The query API reports whether detailed history is complete, partial, or available only as aggregate counts.

Issue #22 owns the final retention periods and archival destination. Its implementation should:

1. export and verify a closed monthly partition before detaching it;
2. detach and drop the detailed partition only after the configured detail-retention period;
3. remove orphaned invocation-key rows after their detailed partition is gone;
4. retain or archive aggregate rows for the separately configured aggregate-retention period;
5. expose the resulting detail boundary through the existing `detailState` and `retainedDetailFrom` response fields;
6. run under a migration/maintenance database role rather than the Control application request path.

Dropping a closed partition is the intended retention mechanism. Row-level UPDATE and DELETE remain rejected on terminal events so ordinary application credentials cannot rewrite compliance evidence.

## Volume qualification and trade-off

The release qualification generated 5,000,000 terminal events across ten days in PostgreSQL 18, built both rollup layers, ran the indexed admin queries, and rolled the transaction back. It observed:

- 5,000,000 detail events, 5,000,000 hourly counts, and 5,000,000 daily counts;
- zero rows in the default partition;
- 8,097,775,616 bytes across the detail partitions and their indexes (about 1.62 KB per synthetic event);
- 0.045 ms for the latest-page query, 1.475 ms for a connector-and-tool-filtered page, and 1.292 ms for the rollup summary on the qualification host.

At the issue's representative 500,000 calls per day, that deliberately wide synthetic shape projects to roughly 0.81 GB per day or 73 GB for 90 days of indexed detail. That is the central trade-off: immutable per-call evidence is retained only for the configured compliance window, while compact aggregate counts can live longer. Issue #22 must choose those periods from customer obligations and storage budgets; this issue does not silently assume that every installation can afford 90 days of detail.

## Operational checks

- Alert when pending admissions older than five minutes are reconciled to `unconfirmed`.
- Alert when rows land in `tool_audit_events_default`.
- Monitor partition and index sizes per month, plus rollup lag.
- Treat a failure to persist admission as fail-closed: the connector tool must not execute.
- A terminal delivery failure may not erase an executed call; the stale-admission reconciler records it as `unconfirmed`.
