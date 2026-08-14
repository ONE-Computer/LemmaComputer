# Team budgets

Team budgets are an AI spend-governance control, not a subscription, invoice, or
payment balance. The same implementation runs in `customer-managed` and `hosted`
profiles. All configuration, reservations, alerts, overrides, and reconciliation
records retain a tenant key in both profiles. A customer-managed installation has
no LemmaComputer-hosted billing or telemetry dependency.

## Accounting basis

P0 budgets consume the immutable ledger's `provider_cost` in the Team snapshot
recorded before each provider attempt. The authoritative capacity formula is:

```text
effective limit - settled provider_cost - outstanding reservations
```

`Auto`, `Lite`, `Balanced`, and `Pro` never carry a price. The pre-dispatch quote
uses the concrete provider account, base model, deployment, region, service tier,
currency, and effective rate card. Contract overrides take precedence over the
pinned catalogue, and the pinned catalogue takes precedence over a conservative
fallback. Remapping an alias therefore changes only future attempt quotes; it
cannot reprice settled history.

Unknown or incomplete prices are never zero. A hard budget rejects a route when
the concrete deployment has no complete approved rate or current-period ledger
events are unpriced. A soft budget allows work with a visible `unpriced` warning.
Provider-reported cost corrections remain append-only ledger deltas and change
the settled total without reopening or double-settling the original reservation.

## Periods and warnings

Each immutable budget version declares a reporting currency, calendar month or
calendar week, IANA timezone, effective interval, mode, and warning thresholds.
Boundaries are local midnight in that timezone, so UTC duration can be 23 or 25
hours shorter or longer around daylight-saving transitions. Creating or editing a
budget inserts a new version; prior versions remain immutable evidence.

Threshold alerts are emitted during settlement or an explicit reconciliation,
not by the status read endpoint. A `(budget version, period, threshold)` can alert
only once. P0 alerts are in-product administrator records; external delivery is
outside scope.

## Pre-dispatch enforcement

Hard enforcement requires a concrete deployment and explicit bounds for maximum
input, output, reasoning, cache writes, retries, fallbacks, agent steps, and any
billable routing/classification overhead. Unknown cache state is quoted as a miss.
All bounded attempts and steps are priced before provider dispatch. Every retry,
fallback, or later step must pass admission with its own attempt identity; repeated
identities are idempotent and conflicting fingerprints are denied.

Reservations are serialized per tenant and Team in the same database transaction
as durable usage admission. This prevents parallel requests from each observing
the same capacity. Settlement links one reservation to the original immutable
usage event and releases unused capacity. An operational reservation expiry is a
reconciliation deadline, not an automatic refund: an expired but non-terminal
provider attempt remains outstanding and hard admission stays fail closed until a
settlement or an audited terminal release is recorded.

Soft mode records a priced reservation when possible and warns when the Team is
over its limit, but does not reject provider dispatch. Hard-limit bypasses and
limit increases are time-bounded, append-only records containing actor, reason,
prior effective limit, new value where applicable, and expiry. On expiry the base
or previously effective limit applies automatically.

## LiteLLM projection and reconciliation

LemmaComputer projects an opaque tenant/Team key and the minimum limit metadata to
LiteLLM through supported Team APIs. It never reads or writes the LiteLLM database.
A hard budget may project `max_budget`; a soft budget projects observability
metadata without a blocking gateway limit. The projection contains no Team name,
cost-center code, user identity, prompt, completion, provider payload, or key.

Projection state is a defense-in-depth mirror. LemmaComputer's exact ledger and
atomic reservation are authoritative. Reconciliation fingerprints the expected
projection, compares it with the supported API response, records matched, drifted,
unavailable, or repaired state, and can repair drift through the same API.

Usage completion returns an explicit `not_reserved` settlement result when the
admission legitimately had no reservation: the Team had no active budget, or a
soft budget continued with unknown/incomplete pricing. The immutable usage event
still remains observable and never becomes zero cost. Retrying an original
completion idempotently retries settlement after an outage; corrections update
ledger totals without reopening a reservation. Explicit reconciliation evaluates
warning thresholds again, so correction deltas can emit any newly crossed alert.

## Stale state and recovery

Hard admission fails closed when the ledger, budget store, or complete price is
unavailable. LiteLLM projection failure is visible in Team administration; it does
not make unknown spend free. Soft mode may continue only with an explicit warning.

Operator recovery procedure:

1. Stop retry storms at the gateway and preserve the affected attempt IDs.
2. Restore database connectivity and run schema compatibility checks; application
   startup never runs migrations.
3. Reconcile expired unsettled reservations against provider terminal state.
   Settle from the immutable usage event, or record a terminal release with safe
   evidence when the provider was not dispatched or confirms no billable work.
4. Run projection reconciliation. Repair through LiteLLM's Team API if drifted.
5. Confirm the Team status shows priced spend, expected outstanding reservations,
   the correct local period boundary, and a current reconciliation timestamp.
6. Remove emergency bypasses by allowing their short expiry; never rewrite their
   audit history.

Do not manually update ledger, reservation, alert, override, or reconciliation
history. Their database triggers deliberately reject mutation. Corrections and
releases are new evidence rows.

## Migration risk

The budget migration is additive: it creates new tables, indexes, foreign keys,
and immutability triggers with no backfill or table rewrite. Locks are limited to
new-object catalogue work and foreign-key validation against existing tenant,
user, Team, rate-card, and usage-event keys. Runtime risk is bounded index growth
from reservations and immutable history. No destructive contraction or restore
plan is required for this release.
