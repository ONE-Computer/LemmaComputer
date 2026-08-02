# Governed model routing

ONEComputer exposes stable service classes while keeping provider deployments and prices under administrator control.

## User-facing contract

Users choose one of four aliases:

- `Auto` classifies the task and selects an eligible service class.
- `Lite` favors lower-cost work within its capability contract.
- `Balanced` is the safe default for ambiguous work.
- `Pro` is reserved for work that needs its stronger capability contract.

Auto, Lite, Balanced, and Pro are product contracts, not provider model names. Administrators can replace the deployment behind a class without changing user workflows.

The workspace **Default model mode** is the starting choice for new
conversations. Chat can override it per conversation without changing the
workspace configuration. The Web client persists that override in
browser-local storage keyed by workspace, agent, and conversation, restores it
when returning to the same conversation, and falls back to Auto if the saved
value is unsupported. Clearing site data or using another browser starts with
the workspace default again.

The default and override affect `requestedServiceClass`; they never expose or
select a provider model directly. An explicit Lite, Balanced, or Pro request
skips Auto classification but remains subject to the full eligibility checks
below.

## Decision flow

1. LiteLLM accepts only the synthetic `onecomputer-auto` transport alias.
2. The callback validates the signed task binding and trusted workspace identity.
3. Control resolves the user's default Team and its immutable rollout and policy versions.
4. The router applies explicit class requests or privacy-safe task signals, then capability, residency, approval, health, rate-card, currency, and budget constraints.
5. Control records the decision and all eligible and rejected candidates atomically before returning a signed concrete-deployment binding.
6. LiteLLM verifies that binding immediately before provider execution, admits spend, and appends the final usage observation after completion.

Provider execution outcomes are also health evidence. A concrete provider availability
failure is marked unavailable for a bounded 60-second window in both the callback's
immediate routing signal and Control's durable tenant-scoped evidence. A later
successful execution clears the signal. The router records health-rejected
candidates and an `availability` escalation, or fails closed when no approved
deployment remains. LiteLLM never falls back outside the signed concrete
deployment binding.

Model names are intentionally absent from the user contract. Decision details expose provider, deployment, mapping, rate-card, and candidate evidence only to administrators.

## Cost model

Administrators set the policy billing currency, but do not type a single blended price on a service-class alias. Each concrete deployment references an immutable effective rate card. Expected cost is calculated from the expected usage buckets and that deployment's rates before selection.

Routing calls the ledger's canonical rate-card selector with the exact tenant, provider account, model, deployment, region, and service tier. The configured card must be the currently effective winner under contract-override, pinned-catalogue, and conservative precedence. A stale card, a higher-priority replacement, or any route-dimension mismatch fails closed. Decision insertion repeats this check in PostgreSQL.

Cache reads, cache writes, reasoning tokens, uncached input, output, requests, images, audio, and provider-specific units remain separate when the provider reports them. The usage ledger applies the exact decimal rate for each available bucket. A missing required rate, unknown price, expired card, or currency mismatch makes that deployment budget-ineligible; routing fails closed when no safe candidate remains.

If an administrator swaps the deployment behind Balanced, the new mapping version points to the replacement deployment and its own rate card. Historical decisions remain tied to the old immutable mapping and pricing evidence.

## Safety and privacy

- Task classification is bounded and stores signal codes, never prompt text.
- Low-confidence or ambiguous Auto classification defaults to Balanced.
- Team policy can narrow identity policy but cannot widen it.
- Session affinity pins the exact eligible deployment and records why it moves.
- Duplicate request IDs replay the durable decision instead of routing or charging twice.

Decision and observation rows are append-only and tenant-scoped in both customer-managed and hosted profiles. Mixed-currency reports deliberately show an unknown aggregate instead of adding incomparable money.

An observation is accepted only when its immutable usage event belongs to the same task, Team, actor, policy, mapping, service class, and executed provider/model/deployment as the routing decision. Its actual cost and currency must exactly equal the usage ledger fact. Both the store transaction and a database trigger enforce this binding.

## Rollout and rollback

Start every Team's Auto classifier in shadow mode. Auto requests execute the fixed deployment while the router records its hypothetical choice, expected cost, candidate evidence, fallback rate, errors, regret, and overhead. Explicit Lite, Balanced, and Pro requests are not classifier experiments: they execute the eligible deployment mapped to the requested class and are excluded from Auto shadow evidence. A denied explicit class or one without an eligible deployment fails closed instead of silently executing the fixed route.

Shadow mode never blocks the fixed route when the hypothetical policy has no eligible, priced, or budget-feasible candidate; it records an explicit `no_candidate` decision instead. Disabled mode bypasses hypothetical policy, budget, and pricing selection entirely and executes the rollout's validated fixed deployment.

Each review is derived server-side from an immutable set of decisions belonging to one exact shadow rollout, policy, mapping, and fixed route. Production enablement rejects reviews from older shadow windows even when their mapping happens to be unchanged.

1. Review a representative evidence window in the administrator UI.
2. Record the reviewer, note, sample size, and pass or fail result.
3. Enable production routing only after a passing review and typed confirmation.
4. Monitor observations and use the decision drill-down when results diverge.

The kill switch appends a disabled rollout that returns execution to the configured fixed deployment. It does not mutate or erase the prior rollout, policy, mapping, decision, or observation evidence.

## Operator provisioning and qualification

Use **AI control plane** in this order:

1. In **Models & providers**, configure and test provider credentials and
   choose approved models. Control uses the provider configuration's reviewed
   capability inventory when composing routes.
2. In **Pricing**, create complete immutable rate cards for every deployment
   expected to carry traffic.
3. In **Model routes**, publish an immutable mapping that assigns eligible
   deployments to Lite, Balanced, and Pro.
4. In **Teams & budgets**, assign default spending Teams and configure budgets.
5. Return to **Model routes** to create each Team policy and start its rollout
   in shadow mode.

Before creating a Team policy, the resulting state must include:

- an immutable mapping version;
- approved, evaluated deployments with capability and residency metadata; and
- effective tenant rate cards for every deployment expected to carry traffic.

Both deployment profiles use the same callback, Control APIs, schema, and tenant-scoped records. Deployment-specific endpoints and secrets remain configuration.

Saving a provider credential does not automatically publish a mapping, create
a price, or enable production routing. Those remain separate versioned
administrator decisions.

Qualify the pinned LiteLLM image and real callback hook with:

`npm run qualify:governed-routing`

Run fresh migrations and Postgres integrity coverage with:

`npm run verify:db`
