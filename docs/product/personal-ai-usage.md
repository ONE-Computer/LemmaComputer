# Personal AI usage overview

**Account menu → My AI usage** gives every authenticated organization member a
private, current-month view of the AI usage attributed to that membership. It
is available in both `customer-managed` and `hosted` deployments. The view is
separate from the administrator AI control plane: it does not show Team
budgets, provider or model controls, other members, task content, or exports.

## What members see

The overview reports accounted text tokens, provider cost, request activity,
previous-period change, and breakdowns by workspace and agent. Historical
workspace and agent identifiers remain attached to the ledger facts if a
member's current workspace list later changes; the UI labels these as previous
attributions instead of silently dropping them.

All figures come from the same append-only usage-ledger read model as the
administrator spend report, filtered to the authenticated tenant and subject.
Corrections are applied once to the original admission, so a corrected event
does not become a second request. Currency totals remain separate unless an
explicit conversion basis is introduced in a future contract.

Cost labels distinguish:

- provider-confirmed cost;
- cost estimated from the immutable rate snapshot captured with the event;
- unpriced or partially priced usage, whose missing amount is unavailable and
  is never represented as zero;
- admitted requests still awaiting a final provider usage report; and
- append-only corrections already reflected in the displayed totals.

An empty period says that no attributed governed calls or delayed reports were
found. It does not invent a zero-cost claim.

## Operational-emissions proxy

The carbon figure is the `operational-token-v1` derived dashboard proxy
documented in [AI token operational-emissions estimate](ai-token-emissions.md).
The method uses accounted text tokens and each provider's selected serving-grid
assumption. The overview discloses the token coverage percentage, the selected
grid assumptions, unsupported usage units, method boundary, and method-unavailable
state.

The estimate is not an invoice, product carbon footprint, life-cycle
assessment, sustainability assurance, or proof of a provider's physical
serving location. Missing grid coverage is not extrapolated.

## Privacy and API contract

`GET /v1/me/ai-usage` requires an active authenticated membership. The server
derives both `tenantId` and `userId` from that session; membership roles do not
broaden the result. The endpoint accepts only ISO-8601 `from`, `to`, and `asOf`
query values, rejects caller-supplied user, Team, workspace, or agent selectors,
limits ranges to 366 days, and returns `Cache-Control: private, no-store`.

The response deliberately omits Team, user, task, request, model, deployment,
and provider-administration dimensions. Provider names appear only as the
minimum grouping required to calculate the disclosed carbon proxy. Prompts,
responses, hidden reasoning, tool arguments, connector data, and raw provider
traces never enter this read model.

## Support checks

When a member reports an unexpected value, support should first confirm the
organization membership and report period, then compare the member-scoped
ledger facts with the administrator spend report filtered to the same user and
frozen `asOf` time. Check the visible data notes before treating a difference
as a defect: delayed reports, unpriced usage, corrections, and current
serving-grid selections can legitimately change the presentation without
rewriting historical ledger facts.

Do not request prompt or response content to reconcile this overview. If the
endpoint is unavailable, verify that the deployment has the usage-ledger spend
read store configured; there is no profile-specific schema or member setting.
