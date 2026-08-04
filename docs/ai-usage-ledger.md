# AI usage and cost ledger

LemmaComputer records every governed provider invocation as a tenant-scoped,
append-only attempt and usage event. The ledger is the accounting source for
provider cost. It is not a provider invoice, a raw trace store, or a
service-class chargeback system.

## Attribution and attempt lineage

Control admits a concrete provider attempt before LiteLLM dispatches it. The
admission snapshots the authenticated subject, exactly one Team and optional
cost-center code, workspace, agent, signed task/session/turn context, effective
policy, requested alias or service class, route-mapping version, and resolved
provider deployment. A later Team membership change or alias remap affects only
new admissions; historical attribution never changes.

Retries, fallbacks, embeddings, classifiers, routers, failures, and the final
inference are separate attempts. Each retry or fallback gets a fresh source
attempt ID and points to the preceding admission through `parentAttemptId`.
LiteLLM v1.93 invokes the deployment hook after selecting a concrete deployment
for each provider invocation, so every member of an attempt chain is admitted
and priced independently. Per-attempt budget bounds consequently declare zero
additional retries and fallbacks.

The workspace passes a signed task binding in
`x-lemmacomputer-ai-task-binding`. The loopback gateway removes any requester
supplied LemmaComputer or LiteLLM identity/route metadata, installs the
header-derived binding, and removes the header before forwarding. The callback
accepts identity only from LiteLLM's authenticated key projection. It carries
lineage between v1.93 retry/fallback hooks in callback-signed metadata; client
metadata cannot create a parent or change tenant attribution.

## Normalized usage units

Usage is stored as allow-listed quantities, not provider response payloads.
Billable buckets are mutually exclusive:

- `input_uncached_token`
- `cache_read_token`
- `cache_write_token`
- `output_token`
- `reasoning_token`
- image, audio, character, request, and time units where a provider bills them
- an extensible `provider:*` unit for a provider-native billing dimension

A provider-reported total such as `provider:total_tokens` is diagnostic only.
It may be used to detect normalization mismatches but is never priced alongside
the normalized buckets. Cache and reasoning quantities are removed from an
overlapping total when that provider reports them as subsets. In the pinned
LiteLLM adapter, Anthropic and Bedrock `prompt_tokens` include cache read and
creation tokens, so the ledger subtracts those buckets exactly once to derive
uncached input.

The pinned production integration is LiteLLM v1.93.0 at
`ghcr.io/berriai/litellm:v1.93.0@sha256:a1745e629abfb17d434426ff48b115f54f4f4c4a0f5af241de569e93c63c411e`.
Qualification fixtures cover OpenAI, Anthropic, GLM, and Bedrock normalized
token, cache, and reasoning shapes. A provider or LiteLLM upgrade must rerun
these fixtures and provider qualification before promotion.

For explainability, an event may also contain nonnegative counts for
conversation-history messages, attachments, retrievals, system/policy context,
tool-result context, and routing overhead. These counters explain broad cost
drivers without persisting the underlying content.

## Provider cost and rate cards

Rates attach to the resolved provider deployment, never to `Auto`, `Lite`,
`Balanced`, or `Pro`. A rate card is immutable and effective-dated, and keys
provider, provider account, base model, deployment or inference profile,
region, service tier, currency, source, and source version. Its unit rates use
exact decimal strings and explicit unit scales; JavaScript floating-point
arithmetic is not used for accounting.

Selection precedence at the event time is:

1. the matching active, approved contract override;
2. the matching pinned catalogue rate;
3. no rate, producing a visible unknown/unpriced event.

Missing rates are never interpreted as zero. When an event is priced, the
ledger stores its currency, per-bucket rate and cost, rate-card ID, source
version, and exact `provider_cost`. A later rate-card activation cannot
recompute historical events. Provider-confirmed cost, when a reliable provider
billing source supplies it, is stored separately from calculated provider cost.
Future internal `chargeback_cost` remains a separate accounting basis.

## Idempotency, corrections, and price states

Source-system plus source-event ID is the idempotency boundary. Repeated
callbacks with the same fingerprint return the existing event; a conflicting
payload is flagged instead of overwriting it. Completion event IDs derive from
the admission, so a lost callback response can be retried safely.

The exact price states are `priced`, `incomplete`, and `unknown`; cost
status is independently `estimated`, `provider_confirmed`, or `unpriced`.
Corrections are immutable delta events linked to the original event.
They reuse the original rate-card snapshot, including its currency and source
version, rather than whatever rate is active when the correction arrives.
Totals sum original and correction deltas. No correction mutates the original
row.

## Callback outages and reconciliation

Admission is fail closed. If Control, its ledger store, or budget admission is
unavailable, the provider call is not dispatched. The callback retries one
ambiguous admission transport failure with the same idempotent request. A
provider retry or fallback is a new concrete admission, not that transport
retry.

Completion delivery is best effort so an already successful model response is
not replaced by a telemetry error. A missing completion leaves the admitted
attempt visible for reconciliation and, when budgets are enabled, its
reservation outstanding until settlement or an explicit audited release.

Administrator reconciliation compares a bounded source/time window with
expected source IDs and fingerprints. It records missing, duplicate, late, and
mismatched findings as new rows. It never repairs history destructively.
Operators should reconcile after callback or provider outages and before using
the period as an accounting close.

## Retention, locality, and privacy

There is no automatic P0 ledger pruning. Admissions, events, unit/rate
snapshots, conflicts, and reconciliation findings remain append-only for the
deployment's audit and accounting retention period. Backups and any future
retention job must preserve event/correction lineage and tenant scope; do not
delete ledger rows ad hoc. A shorter legal retention policy needs a dedicated,
audited design rather than a mutable-row cleanup.

In the `customer-managed` profile, records, rate cards, exports, and
reconciliation remain in the customer's local deployment. The pinned rate
catalogue is shipped with the release, and negotiated rates are entered
locally. Runtime catalogue lookup and LemmaComputer-hosted telemetry egress are
not required. The `hosted` profile uses the same tenant-scoped interfaces and
schema.

The schema and APIs allow only identifiers, normalized counters, monetary
snapshots, outcomes, latency, and safe count-based cost drivers. Never include
prompts, responses, hidden reasoning, tool arguments or results, retrieved
content, screenshots, signed URLs, authorization headers, provider credentials,
or secrets in usage events, reconciliation details, or logs.

## Provider limitations

Provider usage fields are not uniform. Cache creation/read and reasoning may be
missing, renamed, or available only for particular models and API surfaces.
Streaming completion usage depends on the provider and LiteLLM emitting a final
usage object. Provider-confirmed monetary cost is not universally reliable or
available. Failed calls can have unknown usage, and late provider corrections
can arrive after the original event.

Unknown usage and unknown price are therefore explicit states, not zero cost.
The deterministic fixtures validate the supported normalized shapes but do not
replace real-provider billing reconciliation. Record any unqualified provider,
model, service tier, or upgraded callback shape as unknown until its fixtures,
rate coverage, and qualification evidence are added.
