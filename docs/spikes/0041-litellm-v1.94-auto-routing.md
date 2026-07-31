# LiteLLM v1.94 Auto Routing qualification

**Issue:** #41
**Decision date:** 2026-07-31
**Decision:** **NO-GO for LiteLLM as ONEComputer's governed routing decision
authority.** Keep LiteLLM as the provider-neutral inference data plane and let
ONEComputer own the narrow `ModelRouter` decision boundary described below.

This is a spike record, not production enablement. It adds no schema, UI,
workspace grant, or production LiteLLM image change.

## Immutable candidate and provenance

- Candidate: `ghcr.io/berriai/litellm:v1.94.0`
- Multi-platform index:
  `sha256:65d84a2282137b4dc73bbe184650a7c807177c533e4223b3bfbc87963fe3fabe`
- Linux amd64 manifest:
  `sha256:fa88aab52bfcf894f964b855f31be0ef83cba9f5be5d94bbc46f78fcdeb4d46b`
- Linux arm64 manifest:
  `sha256:9e2822d534546632b0678d47904d892cb3fd9332209a219720dec3af48895dff`
- Upstream tag commit:
  `38f2e023f1179d06a199f3d5f02702c89c1a8a58` (GitHub reports a valid
  verified commit signature).
- Current production pin and rollback target:
  `ghcr.io/berriai/litellm:v1.93.0@sha256:a1745e629abfb17d434426ff48b115f54f4f4c4a0f5af241de569e93c63c411e`.

Primary evidence:

- [LiteLLM v1.94.0 tag](https://github.com/BerriAI/litellm/tree/v1.94.0)
- [Complexity Router source](https://github.com/BerriAI/litellm/blob/v1.94.0/litellm/router_strategy/complexity_router/complexity_router.py)
- [Complexity Router configuration](https://github.com/BerriAI/litellm/blob/v1.94.0/litellm/router_strategy/complexity_router/config.py)
- [Auto Router source](https://github.com/BerriAI/litellm/blob/v1.94.0/litellm/router_strategy/auto_router/auto_router.py)
- [Repository license](https://github.com/BerriAI/litellm/blob/v1.94.0/LICENSE)

## Reproduction and measured result

Run:

```bash
npm run qualify:auto-routing
ONECOMPUTER_LITELLM_QUALIFICATION_IMAGE='ghcr.io/berriai/litellm:v1.94.0@sha256:65d84a2282137b4dc73bbe184650a7c807177c533e4223b3bfbc87963fe3fabe' npm run qualify:providers
npm test -- tests/model-router-spike.test.ts
npm run build -w @onecomputer/litellm-adapter
```

The credential-free image harness imports the code from the candidate image,
classifies four deterministic tasks, and runs 2,000 iterations:

| Fixture | LiteLLM tier | Score |
| --- | --- | ---: |
| simple | `SIMPLE` | -0.15 |
| medium | `MEDIUM` | 0.20 |
| complex | `COMPLEX` | 0.55 |
| reasoning | `REASONING` | 0.25, reasoning override |

Measured on the qualification host:

- local heuristic median: **0.201 ms**
- local heuristic p95: **0.207 ms**
- classifier/provider calls: **0**
- classifier cost: **USD 0**

The existing isolated Provider Settings qualification also passed against the
candidate digest, including OpenAI-style and Bedrock-style local fixture routes,
credential rotation, rejection, disable/delete, scoped grants, streaming, tools,
and safe metadata behavior. This is compatibility evidence, not a live provider
benchmark.

## Capability findings

| Area | Finding | Decision |
| --- | --- | --- |
| Local heuristic | Four tiers, deterministic keyword overrides, low-cost local scoring, configurable thresholds | Acceptable component |
| Semantic Auto Router | Uses an embedding call and an utterance index | Not selected; extra runtime call, cost, privacy surface |
| Optional small-LLM classifier | v1.94 supports a classifier model and falls back to heuristic on error | Mechanically available; quality, latency, and real spend untested without credentials |
| Low confidence/default | Default/fallback model is configurable | ONEComputer will make the default explicit as `Balanced` |
| Session affinity | Built in and scoped by API-key hash plus session id | Useful reference, but affinity is disabled when routing plugins are used and must not bypass Team policy |
| Provider neutrality | Tier targets are LiteLLM model groups and can point at managed providers | Acceptable data-plane capability |
| Failure fallback | LiteLLM can fall back among model groups | ONEComputer must reserve/check budget before every dispatch and record attempts separately |
| Capability floors | LiteLLM exposes model metadata and pre-call checks | ONEComputer policy remains authoritative for vision, tools, streaming, and context floors |
| Spend attribution | v1.94 forwards sanitized caller metadata to LLM-classifier and embedding sub-calls | Promising; the owned ledger still has to create separate originating tenant/user/Team attempts |
| One-alias grant | Existing ONEComputer access-group grants expose one stable client alias | Preserve; never grant underlying provider model names |
| Structured decision telemetry | Adaptive routing writes some structured metadata, but normal complexity routing emits cause, tier, score, signals, and selected model only in formatted info logs | **Blocking NO-GO** |
| Privacy | Existing config disables raw request/response and message logging | Preserve; only bounded signal codes may be persisted |
| Licensing | Complexity and Auto Router source is outside `enterprise/` and covered by the repository MIT license | Acceptable for the evaluated source; re-check each pinned upgrade |
| Admin-free runtime | Static heuristic configuration needs no admin call per request | Acceptable, but mapping/rate-card versions remain ONEComputer configuration |

The blocker is not routing quality. It is evidence integrity: ONEComputer cannot
base budgets, explanations, or audit history on parsing a human log line such as
`routing decision cause=..., tier=..., score=..., signals=...`. A supported
callback must return a typed decision before production use. Until then,
LiteLLM cannot be the authority that produces the governed routing decision.

## Selected fallback `ModelRouter` boundary

`packages/litellm-adapter/src/model-router.ts` is an unwired reference adapter
for #42. Its contract deliberately separates:

1. the client request (`Auto`, `Lite`, `Balanced`, or `Pro`);
2. the bounded internal classification (`SIMPLE`, `MEDIUM`, `COMPLEX`,
   `REASONING`);
3. the versioned service-class mapping;
4. the concrete provider deployment and rate-card key.

It accepts tenant, user, Team, ephemeral prompt, session, capability floors, and
the policy-approved deployment pool. It returns a typed, persistable decision
with bounded signal codes, cause, mapping version, selected deployment,
rate-card lookup, fallback attempts, and router overhead. It never returns or
logs the prompt, response, hidden reasoning, key, provider payload, or raw
session id.

The reference proves:

- `Auto`: `SIMPLE -> Lite`, `MEDIUM -> Balanced`,
  `COMPLEX|REASONING -> Pro`;
- ambiguous/low-confidence tasks default to `Balanced`;
- an explicit administrator-permitted class cannot name a provider model;
- Team class and deployment allowlists fail closed;
- session affinity pins a class, while every turn re-checks current capability
  and deployment policy;
- vision, tools, streaming, and context limits are enforced before selection;
- an outage can fall back only inside the same approved class and skipped
  attempts are recorded;
- Foundry, OpenAI, Anthropic, GLM, and Bedrock are provider-neutral deployment
  values, not product vocabulary;
- replacing Foundry behind `Lite` with Bedrock preserves `Lite` and the stable
  `onecomputer-auto` alias, while new evidence points to the new mapping,
  deployment, and rate-card version and old evidence remains unchanged.

The transport recommendation for #42 is one existing stable client alias plus a
validated, server-derived class selection. If a managed client cannot carry
that selection safely, use a bounded alias set for `Auto`, `Lite`, `Balanced`,
and `Pro`; never expose arbitrary provider model names.

## Cost and telemetry contract for #42/#43

- A service class is not a price.
- Every decision resolves a concrete deployment and rate-card key.
- Each classifier, embedding, primary, retry, and fallback call becomes a
  separate ledger attempt attributed to the originating tenant, user, and Team.
- `routerOverheadMs` is separate from provider inference latency.
- Local heuristic classification has zero provider cost.
- An LLM classifier or embedding router must reserve budget before its own call
  and settle its actual usage independently.
- Unknown deployment pricing fails closed for hard budgets; it is never treated
  as zero.

## Rollout and rollback

No rollout occurs in this issue. For a later approved image upgrade:

1. Pin both tag and digest in the production Compose file.
2. Back up the coordinated Control and LiteLLM state per the release runbook.
3. Run Provider Settings, OAuth renewal, quick, DB, and isolated Compose release
   qualifications.
4. Deploy to shadow traffic with owned `ModelRouter` decisions; do not enable
   LiteLLM Auto Routing as authority.
5. On regression, restore the coordinated backup and the exact v1.93.0 rollback
   image above. Do not reuse a moving tag or preserve a newer LiteLLM database
   with an older binary unless the LiteLLM migration is explicitly proven
   backward compatible.

## Untested and follow-up

No real provider credentials were used. The following remain intentionally
untested:

- live OpenAI, Anthropic, GLM, Foundry, and Bedrock error shapes and latency;
- real vision payloads, tool schemas, streaming disconnects, provider context
  rejection, cache usage, and billing reconciliation;
- Claude Desktop/CLI transport naming against the new service classes;
- semantic embedding and small-LLM classifier accuracy, privacy, latency, and
  cost;
- cross-process/distributed affinity and production retry concurrency;
- a supported LiteLLM callback or upstream patch that returns the normal
  complexity decision as typed metadata.

#42 should therefore implement the owned adapter in shadow mode, feed concrete
deployment attempts to #43, and treat any future LiteLLM structured-decision
API as a replaceable adapter implementation rather than a product contract.
