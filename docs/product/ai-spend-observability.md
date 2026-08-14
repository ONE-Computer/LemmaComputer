# AI spend observability

**AI control plane → Overview** and its **Spend Details** drill-down are
administrator-only, tenant-scoped read models over the append-only usage
ledger. They are available in both `customer-managed` and `hosted`
deployments. They are separate from personal Settings and employee Activity and
never read raw provider traces.

The member-scoped counterpart is documented in
[Personal AI usage overview](personal-ai-usage.md). It reconciles to this read
model for the authenticated subject without exposing administrator dimensions
or controls.

Overview summarizes the current month: provider cost, aggregate matching Team
budgets, forecast, a 30-day trend, top spending Teams, and the separately
disclosed AI token-emissions proxy. Spend Details provides date filters,
CSV/JSON export, spend dimensions, Team → user → task navigation, and governed
attempt evidence.

## Reading totals

The selected date range uses the usage event's occurrence time. The `asOf` value freezes which received ledger facts belong to the view, so pagination and CSV/JSON exports continue to reconcile even if a delayed event or correction arrives later.

Provider cost leads the view. Each currency is totaled separately; LemmaComputer does not silently convert or combine currencies. Corrections are signed, append-only deltas and are applied exactly once. A corrected task remains marked as corrected.

Provider-confirmed cost is reported separately from cost derived from LemmaComputer's rate snapshot. It is not silently substituted for, or added to, the primary provider-cost total. The dashboard also exposes:

- governed attempt and event volume;
- retries, fallbacks, and failures without recounting correction events as attempts;
- average and p95 latency from one latency sample per governed attempt;
- previous-period cost and attempt totals for an equally sized range;
- summaries by Team, user, requested route, resolved provider/model/deployment, workspace, agent, and composite task/turn identity.

## Allocation

Every attempt uses the immutable Team snapshot captured when the call was admitted. Later Team membership changes therefore do not rewrite historical spend. A user may belong to overlapping Teams, but an attempt has one spending Team and is counted once.

Attempts with no selected spending Team use the dedicated `Unallocated` snapshot. Allocated and unallocated counts are explicit so incomplete administration is not mistaken for free usage.

## Usage categories

Usage quantities remain visible even when monetary cost is unavailable:

- `input_uncached_token`: input tokens that were not served from cache;
- `cache_read_token`: input tokens served from a provider cache;
- `cache_write_token`: tokens written to a provider cache;
- `output_token`: generated output tokens;
- `reasoning_token`: provider-reported billable reasoning units, never reasoning text;
- `image` and `audio_second`: media usage where reported;
- `request`, `character`, and `second`: provider-specific billable units where reported.

Provider diagnostic units are not mixed into finance totals. The JSON contract retains an extensible usage map so additional allow-listed unit categories do not require raw payload exposure.

## Price basis and model aliases

Aliases such as `lite`, `balanced`, and `pro` describe governed service classes; they do not define a price. Cost is calculated from the concrete provider/model/deployment selected for an attempt and the immutable rate-card snapshot effective at that time. A task drill-down shows the rate-card ID, source, version, hash, and effective date when available.

This keeps historical totals stable if an administrator later maps an alias to a different provider or model. Input, cache-read, cache-write, output, reasoning, media, and other provider units can each have their own price buckets in the ledger.

## Data-quality states

- **Empty:** no governed calls or delayed admissions exist in the range.
- **Complete:** all received usage events have a usable price state.
- **Unknown price:** usage was recorded but no applicable price was known. It is not counted as zero.
- **Incomplete price:** only part of the usage could be priced. The task and view remain partial.
- **Delayed:** an admitted attempt has not produced a usage event by the view's `asOf` time.
- **Corrected:** a later signed ledger delta adjusts a prior event; both facts remain auditable.

A monetary total can legitimately be zero, but unknown, incomplete, and delayed states are always shown separately from zero.

The separate **Data health** tab keeps diagnostic coverage out of financial
totals. It reports:

- unpriced or partially priced usage events still requiring review;
- admitted attempts still awaiting a final provider usage record; and
- failed attempts for which no billable usage was reported.

An administrator can record an append-only historical review baseline for
unpriced usage received before the report's `asOf`. That acknowledgement does
not delete usage, fill a missing price, or change any spend total. New pricing
gaps after the baseline remain active.

## Explanations and privacy

Task explanations use only allow-listed counters and categories: conversation history, attachments, retrieved context, system/policy context, tool-result context, output/reasoning quantity, retries/fallbacks, routing overhead, and cache behavior. They do not contain prompts, responses, hidden reasoning, screenshots, page content, raw tool arguments, connector secrets, provider account identifiers, or signed URLs.

Task identity is composite: user, workspace, agent, session, task, and turn. The opaque task key preserves that identity during drill-down and avoids merging unrelated calls that reuse the same task ID.

There is no general-purpose Explainability score on Overview. Task drill-down
shows a sanitized explanation only when allow-listed cost-driver counts were
recorded for that task. It does not infer causation from spend changes, token
ratios, or unrelated operational counters.

## API and exports

Administrators can read:

- `GET /v1/admin/spend` for a paginated report;
- `GET /v1/admin/spend/tasks/:taskKey` for the governed calls behind one task;
- `GET /v1/admin/spend/export?format=csv|json` for the same frozen authorized view.

Administrators record a Data health historical pricing review with
`POST /v1/admin/spend/cost-coverage/acknowledgements`. The endpoint accepts the
review cutoff only; it does not mutate ledger facts or prices.

Queries accept ISO-8601 `from`, `to`, and `asOf` values plus Team, user, workspace, agent, session, task, and turn filters. Ranges are limited to 366 days and task pages to 200 rows. An opaque cursor carries the original filters, range, and `asOf`; callers must not modify it.

CSV and JSON are versioned contracts. Exports include the authenticated tenant identifier, Team and user identifiers, task identity, route/model results, separate primary and provider-confirmed costs, latency, price state, and correction state. HTTP responses use `Cache-Control: no-store`. Role and tenant failures return the same not-found shape to prevent existence disclosure.
