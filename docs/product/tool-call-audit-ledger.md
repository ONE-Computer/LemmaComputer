# Tool-call audit ledger

Control records a tenant-scoped compliance event for each admitted connector
tool invocation. The workspace broker creates the invocation identity; a
caller cannot choose or reuse it. Records contain the actor, workspace,
agent instance, connector/tool, policy and approval references, bounded target
summary, timestamps, correlation, latency, and outcome. They do not contain
prompts, arguments, results, hidden reasoning, credentials, or signed URLs.

## Terminal states

- Denials and approval holds become terminal with admission.
- Allowed calls remain pending until the authenticated broker reports success,
  failure, timeout, or cancellation.
- A pending call without terminal evidence after five minutes becomes
  `unconfirmed`. This is a degraded outcome, never inferred success.
- Admission persistence failure denies execution. A later terminal-delivery
  failure cannot erase an executed call; reconciliation retains it as
  `unconfirmed`.

LiteLLM post-call hooks are not the sole terminal authority because exceptional
MCP paths do not consistently invoke them in the pinned gateway version.

## Storage and retention

`tool_audit_events` is append-only and range-partitioned by completion month.
Control prepares near-term partitions; a default partition is a safety net,
not the expected steady state. Hourly and daily aggregates retain counts and
latency totals without member, workspace, target, or correlation detail. The
query API distinguishes complete, partial, and aggregate-only history.

The final detail and aggregate retention periods and archive destination
remain an operator/product decision. A maintenance role must verify export
before detaching or dropping a closed detail partition. Do not mutate
terminal rows to implement retention. Monitor pending-to-unconfirmed counts,
default-partition rows, partition/index size, and rollup lag.

A synthetic PostgreSQL volume test is sizing evidence for its tested row
shape, not a production retention forecast. Choose retention from customer
obligations and measured traffic before go-live.
