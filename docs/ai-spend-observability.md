# AI spend observability

The AI spend view in Settings is an administrator-only, tenant-scoped read model over the append-only usage ledger. It is available in both `customer-managed` and `hosted` deployments. It is separate from employee Activity and never reads raw provider traces.

## Reading totals

The selected date range uses the usage event's occurrence time. The `asOf` value freezes which received ledger facts belong to the view, so pagination and CSV/JSON exports continue to reconcile even if a delayed event or correction arrives later.

Provider cost leads the view. Each currency is totaled separately; ONEComputer does not silently convert or combine currencies. Corrections are signed, append-only deltas and are applied exactly once. A corrected task remains marked as corrected.

Provider-confirmed cost is reported separately from cost derived from ONEComputer's rate snapshot. It is not silently substituted for, or added to, the primary provider-cost total. The dashboard also exposes:

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

## Explanations and privacy

Task explanations use only allow-listed counters and categories: conversation history, attachments, retrieved context, system/policy context, tool-result context, output/reasoning quantity, retries/fallbacks, routing overhead, and cache behavior. They do not contain prompts, responses, hidden reasoning, screenshots, page content, raw tool arguments, connector secrets, provider account identifiers, or signed URLs.

Task identity is composite: user, workspace, agent, session, task, and turn. The opaque task key preserves that identity during drill-down and avoids merging unrelated calls that reuse the same task ID.

## API and exports

Administrators can read:

- `GET /v1/admin/spend` for a paginated report;
- `GET /v1/admin/spend/tasks/:taskKey` for the governed calls behind one task;
- `GET /v1/admin/spend/export?format=csv|json` for the same frozen authorized view.

Queries accept ISO-8601 `from`, `to`, and `asOf` values plus Team, user, workspace, agent, session, task, and turn filters. Ranges are limited to 366 days and task pages to 200 rows. An opaque cursor carries the original filters, range, and `asOf`; callers must not modify it.

CSV and JSON are versioned contracts. Exports include the authenticated tenant identifier, Team and user identifiers, task identity, route/model results, separate primary and provider-confirmed costs, latency, price state, and correction state. HTTP responses use `Cache-Control: no-store`. Role and tenant failures return the same not-found shape to prevent existence disclosure.
