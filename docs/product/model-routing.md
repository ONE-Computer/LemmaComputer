# Governed model routing

Members choose Lite, Balanced, or Pro as stable service classes. They do not
choose a provider deployment. Administrators map each class to reviewed
provider models, prices, and policy. `lemmacomputer-auto` is the gateway's
internal transport alias, not a member-facing mode. See
[LiteLLM gateway](../architecture/litellm-gateway.md#governed-model-request-and-auto-switching)
for the execution boundary.

## Member selection

A workspace saves a policy-bounded default model mode for new conversations.
Chat can override it for one conversation; Web remembers the override locally
by workspace, agent, and conversation. Another browser or cleared site data
returns to the workspace default. Thinking effort is a separate choice.

Managed native clients present the same three labels through reviewed
compatibility aliases. Their loopback broker maps each request to the product
class and gets a fresh Control-signed task binding. A client-supplied model
name or reasoning field cannot select a provider directly. Unknown aliases,
unavailable classes, and unsupported runtime versions fail closed.

## Decision and accounting

1. LiteLLM accepts the synthetic alias with a scoped workspace key and signed
   task binding.
2. Control resolves the active organization, default spending Team, policy,
   rollout, mapping, eligible deployments, capabilities, residency, health,
   effective rate card, currency, and budget.
3. Control records the decision and signs one concrete deployment. LiteLLM
   verifies the actual selected route and obtains a durable usage admission
   and budget reservation before provider dispatch.
4. Completion records normalized usage, cost, outcome, and route observation.
   An admission without a final event remains visible for reconciliation.

A provider failure can temporarily mark its deployment unavailable. A later
success clears that signal. The gateway cannot silently fall back outside the
signed deployment. No eligible, priced, policy-compliant route means no
dispatch. Unknown price or usage is unavailable, never zero.

Each deployment uses an immutable effective rate card; service-class names
have no blended price. A mapping change affects future decisions only.
Historical decisions keep their mapping and price snapshot. Cost and usage
observations must match the original tenant, actor, Team, task, class,
provider, model, and deployment.

The router stores bounded signal codes and decision evidence, not prompt or
response text. Concurrent and repeated request IDs preserve independent,
idempotent decisions.

## Rollout and rollback

New Teams start on a fixed Balanced route. Shadow mode executes the fixed
route while separately recording the hypothetical dynamic decision. Explicit
Lite/Balanced/Pro selections still require an eligible route for the selected
class. A representative review must match the exact policy, mapping, fixed
route, and shadow window before dynamic routing is enabled. The kill switch
appends a disabled rollout that returns to the configured fixed route; it does
not rewrite past decisions.

## Administrator setup

1. Configure and test provider credentials and models in **Models & routing**.
2. Publish complete rate cards there.
3. Publish a Lite/Balanced/Pro mapping there.
4. Assign default Teams and budgets in **Teams & budgets**.
5. Create Team policies, review shadow evidence, enable, and monitor routing
   and Data health.

Provider setup does not automatically publish a price, mapping, policy, or
rollout. Both deployment profiles use the same tenant-scoped code and schema.
Run `npm run test:integration:governed-routing` for the pinned callback and
`npm run verify:db` for persistence changes. Live provider and browser
behavior require separate target-environment checks.
