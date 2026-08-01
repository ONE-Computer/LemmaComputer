# ONEVibe-MonoRepo: E2B + ACP final execution plan

> **Canonical update (2026-08-01):** [COWORK_E2B_ACP_PLAN.md](./COWORK_E2B_ACP_PLAN.md)
> is now the source of truth for the lightweight Cowork architecture. This
> document retains the broader provider and ACP sequencing; any reference below
> to a Cowork “workspace”, KasmVNC parity, or a persistent E2B volume applies
> only to the durable Computer compatibility path and is not a Cowork
> requirement.

> Current execution addendum: see [ONEVIBE_EPHEMERAL_COWORK_ACP.md](./ONEVIBE_EPHEMERAL_COWORK_ACP.md) for the task-scoped sandbox philosophy and API-first ACP/VCR qualification order.

**Status:** approved architecture plan  
**Date:** 2026-08-01  
**Target branch:** `codex/onevibe-computer`

## Executive decision

Use E2B Firecracker microVMs as the first managed execution provider for
conversation-scoped Cowork sessions. Run an allow-listed agent harness inside the
microVM through the Agent Client Protocol (ACP), and normalize all output into
ONEComputer's canonical governed event stream.

Keep Kasm/KasmVNC as the durable visual-computer tier. Add Modal as a later
gVisor-backed high-density execution tier for short code/test/tool workloads;
it is not the first replacement for Kasm and it does not define the canonical
provider contract.

```text
User / Cowork UI
       │ task, identity, policy, VCR viewer
       ▼
ONEComputer Control + durable coordinator
       │ signed policy, budget, broker grant
       ├── execution provider: E2B (conversation microVM)
       │       └── minimal Cowork image + OpenCode/Codex ACP harness
       ├── execution provider: Kasm (persistent visual workspace)
       └── execution provider: Modal (later gVisor burst tier)
               │
               ├── LiteLLM/model gateway through credential broker
               ├── canonical AgentChatEvent stream
               └── signed VCR capture sidecar → encrypted replay frames
```

ACP is the harness protocol. It is not the sandbox boundary, model-provider
credential path, approval authority, or VCR protocol. E2B is the execution
boundary. ONEComputer Control remains the policy, identity, evidence, budget,
and approval authority.

## What the R&D branches established

The `onecomputer-v2-onevibe` repository contains these relevant branches:

| R&D branch | Useful source | Decision |
| --- | --- | --- |
| `codex/onevibe-foundation` | governed ACP/replay contracts | port first |
| `codex/onevibe-quality-baseline` | baseline and runtime qualification gates | port first |
| `codex/onevibe-acp-runtime` | official Codex/Claude ACP packages, process confinement, provider negotiation | port after foundation |
| `codex/onevibe-e2b-modal-sandboxes` | E2B/Modal adapters, policy projection, external egress controls, volumes, lifecycle tests | port after ACP contract |
| `codex/onevibe-vcr` | encrypted replay, activity-bound frame references | port after canonical events |
| `codex/onevibe-live-view` | read-only live app view and replay UI | port after VCR API |
| `codex/onevibe-sandbox-strategy` | provider selection and economics | architecture reference |

These branches are R&D inputs, not merge-ready branches for the current
monorepo. They were developed on a different `origin/main` lineage. Port
contracts and focused commits onto current `origin/main`; do not wholesale
merge old `App.jsx`, migrations, or provider routes.

The R&D evidence has three caveats:

1. E2B/Modal adapters are automated-conformance green but live qualification
   still requires provider credentials, an immutable image/template,
   public governed egress, and provider quotas.
2. Codex ACP has a qualification lane through LiteLLM. Claude ACP is packaged,
   but intentionally remains disabled until broker-provided governed authority
   works without a provider secret in the agent profile/filesystem.
3. OpenCode is now pinned in the ACP runtime image and launched as the
   official `opencode acp` command by the provider-hosted ACP chat bridge.
   Control uses the E2B-hosted endpoint rather than the Docker-only chat DNS
   route. The deterministic adapter/API gates pass; live E2B evidence still
   requires the immutable image/template, real LiteLLM route, browser capture
   utility, and provider credentials described above.

## Runtime model

### Execution scopes

Add an explicit execution scope to the task model:

- `turn`: disposable environment for one request;
- `conversation`: one E2B microVM per chat session, paused between turns;
- `task`: environment retained across related Cowork interactions;
- `workspace`: current Kasm-style durable Computer desktop.

Default Manus-like web chat to `conversation` + E2B. Route to Kasm Computer when the
user needs a long-lived desktop, durable GUI state, nested virtualization, or
human takeover that E2B has not yet qualified. The model/agent cannot choose a
weaker boundary or extend retention.

### Agent lifecycle

1. Authenticate the user and resolve effective signed policy.
2. Create or resume the owned conversation task idempotently.
3. Select an allowed provider and isolation class in Control.
4. Reserve budget and issue a short-lived broker grant bound to tenant,
   subject, workspace, conversation, agent, policy hash, scope, expiry, and
   limits.
5. Create/resume the E2B sandbox from an immutable image/template.
6. Start the allow-listed ACP harness inside its confined workspace and
   negotiate protocol/runtime capabilities.
7. Route model traffic through the LiteLLM gateway; no provider key enters the
   sandbox.
8. Map ACP updates, tool calls, plans, permission requests, text, artifacts,
   cancellation, and terminal state to `AgentChatEvent`.
9. Emit redacted activity and VCR references outside the sandbox.
10. Pause on governed idle; resume on the next owned message; destroy on
    retention expiry, budget exhaustion, policy revocation, or deletion.

### Harness support order

1. Codex ACP through the existing qualified LiteLLM provider negotiation.
2. OpenCode ACP through a new pinned runtime image and the same adapter tests.
3. Claude Agent ACP only after the credential/authority boundary is proven.
4. Native Claude/Codex/Hermes adapters remain supported where they provide
   better compatibility; ACP and native adapters share the canonical events.

## Provider responsibilities

### E2B — first production-learning provider

Use E2B for one microVM per conversation, short idle pause/resume, snapshots,
forks where policy permits, and usage-based spend controls.

Required qualifications:

- immutable `linux/amd64` minimal Cowork image and E2B template;
- E2B API key held only by the controller secret boundary;
- external TLS egress proxy reachable from the provider;
- default-deny provider network and exact route allowlist;
- scoped model/control grants injected through the broker;
- ACP process, filesystem, and terminal confinement;
- application-scoped browser/document capture; desktop/KasmVNC/clipboard remain
  Computer-only capabilities;
- frame capture sidecar with no raw prompts, cookies, secrets, or hidden
  reasoning in replay evidence;
- create/resume/pause/kill reconciliation and explicit volume purge.

#### Temporary qualification result

On 2026-08-01 a bounded provider test used the built-in `base` template only;
no repository changes or persistent credentials were made. The test verified:

- sandbox creation with `secure: true`, 2 vCPU, 512 MiB, and internet disabled;
- a harmless command executing successfully;
- outbound HTTPS being blocked when `allowInternetAccess` was false;
- pause/resume preserving the filesystem and returning to `running`;
- pause without memory retention returning `paused`;
- snapshot creation, clone, marker-file verification, and snapshot deletion;
- kill returning success, a subsequent direct lookup returning `404`, and final
  sandbox, volume, and snapshot inventories all being empty.

This proves the provider lifecycle hypothesis, not production parity. The
account had no custom templates. Before any Cowork traffic is routed to E2B,
build and promote an immutable ONEComputer image/template containing the ACP
runtime, workspace tools, browser/office/VCR dependencies, and the approved
egress broker. Qualification must also assert the exact scoped ingress/traffic
token boundary; a successful `secure` request alone is not evidence that token
handling is correct. Pause, snapshot, and resume can drop PTY/WebSocket/live
VCR connections, so the coordinator must reconnect and emit truthful lifecycle
events. Add orphan sweeping, snapshot TTL/deletion, timeout/kill-on-failure,
and per-task usage metering before production enablement.

### Kasm/KasmVNC — durable visual tier

Keep Kasm for long-running browser/office work, persistent profiles, desktop
takeover, and any workflow whose visual stream is a first-class requirement.
The task UI should make the provider choice legible without exposing vendor
implementation details.

### Modal — later gVisor tier

Add Modal after E2B proves the lifecycle and spend contract. Target short
compute-heavy turns, tests, and burst tool workers. Treat Modal's default
gVisor boundary, timeout, volume, network, and snapshot semantics explicitly;
do not advertise it as a Firecracker microVM or assume it supports the full
KasmVNC desktop parity target.

## Control-plane contract

Preserve the current `SandboxAdapter` for compatibility and introduce a
provider-neutral execution contract with capabilities such as:

- isolation class and provider trust level;
- create/status/resume/pause/destroy/reconcile;
- exec, PTY, files, private ingress, and computer-view support;
- snapshot/fork support and exact semantics;
- architecture, image, region, GPU, nested-container, and maximum-lifetime
  constraints;
- egress enforcement location, credential injection mode, usage dimensions,
  and capability freshness.

Provider IDs, URLs, credentials, diagnostics, and failure bodies stay private.
The public task record exposes a safe capability summary and truthful state.

## Security invariants

Every provider and harness must:

- require a signed verified effective policy;
- default-deny egress and block loopback, link-local, metadata, private ranges,
  DNS rebinding, and unapproved public ingress;
- use broker-custodied credentials with exact scope and expiry;
- run immutable images by digest with SBOM/provenance;
- never expose host Docker/Kubernetes credentials;
- bind operations to tenant, subject, workspace, conversation, agent, policy
  hash, expiry, and budget;
- append lifecycle, policy, network, harness, artifact, VCR, and usage evidence;
- redact credentials, auth headers, signed URLs, raw provider payloads, and
  chain-of-thought;
- reconcile after controller, provider, harness, or browser disconnect;
- delete or cryptographically purge ephemeral state at retention expiry.

The UI may request or display an approval. Only VTI/OpenVTC may authorize it.
ACP permission requests must resolve to an exact governed operation or fail
closed.

## Delivery sequence

### Phase 0 — baseline and contracts

- Rebase the current ONEVibe work onto current `origin/main`.
- Port quality baseline, canonical `AgentChatEvent`, `HarnessAdapter`, and
  execution capability types.
- Add fake provider/harness fixtures and lifecycle reconciliation simulator.
- Add conversation scope, provider, isolation, region, budget, and policy-hash
  fields to owned task state.

**Exit:** current Kasm and existing Cowork PPTX/VCR journey pass unchanged;
new provider conformance tests pass against the fake provider.

### Phase 1 — E2B + Codex/OpenCode ACP vertical slice

- Port managed E2B adapter and policy-bound egress checks.
- Build/pin image and ACP runtime in CI.
- Implement create/resume/pause/kill, usage, budget reservation, backpressure,
  and reconciliation.
- Run multi-turn Codex and OpenCode ACP conversations through LiteLLM.
- Enforce a durable per-task execution-turn budget and fail closed under
  backpressure before opening a provider stream.
- Render canonical streaming activity in Cowork.

**Exit:** API and browser E2E prove a fresh E2B conversation, streamed ACP
turn, cancellation, resume, owner isolation, spend limit, and destruction.

### Phase 2 — OpenCode ACP and Claude qualification

- Package a pinned OpenCode ACP runtime with an isolated home and no browser
  login.
- Add provider negotiation, permissions, malformed-message, timeout, stderr,
  cancellation, and path-confinement tests.
- Run the same canonical golden stream against Codex, OpenCode, and fixtures.
- Enable Claude only after its broker authority path satisfies the same tests.

**Exit:** harness choice changes runtime implementation only; event, policy,
approval, VCR, artifact, and budget contracts remain identical.

### Phase 3 — application-scoped E2B/VCR qualification

- Prove Playwright/application capture inside the minimal Cowork E2B image;
  KasmVNC and desktop takeover remain Computer-only.
- Add capture sidecar at semantic action boundaries and bounded active cadence.
- Implement live-follow, previous/next, pause/play, scrub, event markers,
  frame availability, jump-to-live, and capture-degraded states.
- Test browser navigation, document editing, artifact creation, reconnect,
  redaction, and frame backpressure.

**Exit:** a user can watch and replay an E2B browser task, then download a
task-owned PPTX, with no secrets or private reasoning in evidence.

### Phase 4 — Modal and provider routing

- Implement Modal behind the same contract as a gVisor burst tier.
- Benchmark E2B, Modal, and Kasm for cold/warm latency, compatibility,
  concurrency, storage, VCR support, and total cost.
- Make routing policy- and budget-driven; provider fallback cannot weaken
  isolation, residency, or credential rules.

### Phase 5 — enterprise hardening

- Add cost estimates, live usage, quotas, lifecycle dashboards, alerts, and
  invoice reconciliation.
- Add chaos/restart/reconcile tests and regional/data-residency policies.
- Run independent OpenCode/Kimi review through LiteLLM, then reproduce every
  accepted finding deterministically.

## Production qualification gates

No provider is marked supported based on package installation or a mocked SDK.
Each provider must pass:

- unit/contract tests and negative security tests;
- API E2E for lifecycle, ACP, policy, credentials, budget, and evidence;
- browser E2E for streaming chat, cancellation, resume, VCR, and artifacts;
- live provider qualification with real credentials in an approved account;
- zero secret leakage in controller, provider, harness, workspace, proxy, and
  VCR logs;
- p95 startup/resume, first-observable-progress, stream, and replay SLOs;
- explicit retention/purge and cross-tenant isolation proof;
- rollback, reconciliation, and provider-outage runbooks.

The current developer machine can run the fake provider and local API/browser
qualification. Real E2B/Modal gates require credentials, an image/template,
public governed egress, provider quotas, and an approved region. Until those
exist, the adapters stay behind an experimental flag and the limitation is
shown honestly in the UI.
