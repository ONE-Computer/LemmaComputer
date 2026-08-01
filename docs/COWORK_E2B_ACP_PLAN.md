# Cowork on E2B: canonical architecture and delivery plan

**Status:** implementation contract (2026-08-01)
**Branch:** `codex/onevibe-computer`
**Owner:** ONEComputer Control + Cowork runtime

This is the single source of truth for the lightweight Cowork runtime. It
supersedes any earlier plan that describes Cowork as a Kasm workspace or that
requires KasmVNC parity inside an ephemeral chat sandbox.

## Product boundary

ONEComputer has two deliberately different experiences:

| Experience | User mental model | Runtime | State lifetime | Visual surface |
| --- | --- | --- | --- | --- |
| **Computer** | “I am using my governed computer.” | Kasm/KasmVNC (or a later durable provider) | Persistent workspace and home volume | Full desktop, human takeover, clipboard, office apps |
| **Cowork / ONEVibe** | “An agent is doing this task for me.” | E2B Firecracker microVM per conversation/task | Disposable task session; fixed TTL; destroy by default | Application-scoped evidence (browser/document PNGs), not a desktop login |

Cowork is not a lightweight alias for Computer. It does not create, open, or
list a Kasm workspace; it does not mount a durable home volume; and it does not
expose port 6901. If a user needs a persistent desktop, human takeover,
clipboard, or long-running office state, Control must route them to Computer.

The current `/v1/onevibe/tasks` implementation still uses an internal
workspace-shaped handle for compatibility with existing task/event tables. That
handle is transitional and is never a durable workspace or a user-selectable
Computer resource. New APIs and code must use a first-class Cowork session
identifier and must not add dependencies on the workspace lifecycle.

## Canonical Cowork session model

The target Control model is an owned `cowork_session` with:

- `sessionId`, tenant, subject, task, agent, policy hash, provider profile;
- an immutable image/template digest and provider sandbox id;
- a short creation-anchored deadline, turn budget, byte budget, and state;
- durable redacted activity, ACP transcript references, VCR frame references,
  artifact ownership, and cleanup evidence;
- no durable user home, no provider credential, and no hidden reasoning.

The session is the authorization and retention boundary. The E2B sandbox is an
implementation detail behind an `EphemeralExecutionAdapter`; it is never
returned as a launch URL or treated as a workspace by the UI.

## Dependency tree and migration seam

The current implementation is a useful compatibility baseline, but its
dependency direction is still workspace-shaped:

```text
POST /v1/onevibe/tasks
  └─ Control server
      └─ WorkspaceService.create(cowork-ephemeral-* grant)
          ├─ WorkspaceStore.workspaces
          ├─ ControllerClient → workspace-controller → SandboxAdapter
          │    └─ E2B adapter currently provisions the full workspace image
          └─ task header on workspace chat message
               ├─ AgentChatAuthority(workspaceId)
               ├─ provider NDJSON → ActivityStore(activity_events)
               ├─ OneVibeTaskStore(onevibe_task_runs/events)
               └─ VCR/artifacts on workspace/task routes
```

This baseline is retained until the new path is proven, but it must not grow.
Its known coupling points are: task ownership through `workspaces`, two event
stores without a canonical message ledger, provider-owned conversation history,
and an E2B adapter that assumes Kasm paths, volumes, and desktop capture.

The target dependency direction is additive and explicit:

```text
POST /v1/cowork/sessions
  └─ CoworkSessionService
      ├─ CoworkSessionStore
      │    ├─ cowork_sessions (owner, policy, deadline, provider state)
      │    ├─ cowork_turns (budget, cursor, terminal state)
      │    ├─ cowork_messages (redacted canonical history)
      │    └─ cowork_events (ordered SSE/activity ledger)
      ├─ EphemeralExecutionAdapter
      │    ├─ E2B Firecracker implementation
      │    └─ (later) Modal/gVisor implementation
      ├─ Governed ACP bridge (Codex/OpenCode)
      ├─ Application capture adapter (Playwright/document)
      └─ Artifact registry + retention/cleanup coordinator
```

The new adapter deliberately has no `open()` or `purgeWorkspace()` method. Its
minimum contract is `create`, `status`, `startAcp`, `captureApplication`,
`cancel`, `destroy`, and `reconcile`, with capability metadata that says
whether browser/document capture is available. A Computer `SandboxAdapter`
continues to own Kasm lifecycle and desktop launch. The Control API chooses the
contract from the product mode, never from a provider response.

### Implementation dependency order

1. **Contracts:** session/profile/capability schemas, event and message
   envelopes, lifecycle states, and typed failure codes.
2. **Persistence:** additive migrations and `MemoryWorkspaceStore` parity for
   session, turn, message, event, artifact, and cleanup records.
3. **Runtime:** minimal E2B image, ACP bridge, Python artifact toolchain,
   browser capture, and provider adapter conformance tests.
4. **Orchestration:** session service, grant binding, budgets, cancellation,
   history writes, SSE replay, and reaper/reconciliation.
5. **Evidence:** VCR frame validation, artifact package validation, retention,
   and audit receipts.
6. **Compatibility:** route the existing `/v1/onevibe/tasks` path through the
   new service only after the new session path is green; remove workspace
   dependencies once migration and replay tests pass.

No later layer may bypass an earlier one: UI work starts only after the real
API gate, and live E2B qualification starts only after local adapter and ACP
contract gates.

## Wave-1 architecture review and go/no-go decisions

The dependency tree was reviewed against the current Control routes, store
migrations, E2B adapter, ACP bridge, and qualification runner. The review
result is:

- **Do not extend `SandboxAdapter`.** It is the Computer/Kasm contract and its
  `open`/volume assumptions make a Cowork implementation unsafe. Add a separate
  provider-neutral `EphemeralExecutionAdapter` and a `CoworkControllerClient`.
- **Do not reuse `workspaceId` as a public Cowork identifier.** Existing signed
  policy, agent-bridge, and egress claims are workspace-bound. The first
  compatibility alias may remain internal, but the session API needs a
  versioned `resourceKind/resourceId` binding before it is production-ready.
- **Do not treat provider history as canonical.** The current bridge stores
  message arrays on provider volumes while Control stores only hash/evidence
  projections. Add Control-owned session, turn, message, provider-binding, and
  event records; provider `session/load` is recovery, not the source of truth.
- **Do not call the existing presentation endpoint an agent artifact.** It
  currently creates a Control-owned synthetic PPTX. The Gold Path is blocked
  until the E2B bridge can safely discover, validate, upload, and emit events
  for agent-created `.docx`, `.xlsx`, and `.pptx` files in a confined artifact
  directory.
- **Do not call the current live runner Gold Path evidence.** It lacks robust
  UI-SSE parsing, three-turn context proof, provider restart/cancel coverage,
  VCR retrieval assertions, cross-identity checks, and explicit secret
  non-disclosure. It remains a compatibility smoke gate until Wave 2 extends
  it.
- **Do not assert `envdAccessToken` from E2B `getInfo()`.** The SDK does not
  return that token there; qualification must assert secure creation/network
  evidence without logging or inspecting the token.

### Wave-2 implementation assignments

The next implementation wave is intentionally split by ownership to prevent
context drift and merge collisions:

1. **Execution seam:** add the ephemeral contract, Cowork controller routes,
   minimal E2B adapter, capability metadata, and negative no-Kasm tests.
2. **History/persistence:** add additive Cowork session/turn/message/provider
   binding/event migrations, store methods, canonical transcript writes, and
   restart/recovery tests.
3. **Qualification/artifacts:** fix and extend the live runner to parse both
   AI SDK SSE and Activity SSE, prove dependent turns/history replay, validate
   real agent-created Office packages, capture/retrieve VCR PNGs, and assert
   cleanup/isolation/secret non-disclosure.

The root agent integrates these tracks only after each reports tests and a
reviewable diff. No track may silently change the Computer/Kasm contract.

### Target endpoints

The compatibility endpoints remain read-only/deprecation paths while the
following session-scoped endpoints are introduced:

```text
POST /v1/cowork/sessions
GET  /v1/cowork/sessions/:sessionId
POST /v1/cowork/sessions/:sessionId/turns
GET  /v1/cowork/sessions/:sessionId/events?after=N
GET  /v1/cowork/sessions/:sessionId/events/stream?after=N
POST /v1/cowork/sessions/:sessionId/frames
GET  /v1/cowork/sessions/:sessionId/vcr
GET  /v1/cowork/sessions/:sessionId/artifacts/:artifactId
DELETE /v1/cowork/sessions/:sessionId
```

Every route checks tenant, subject, session, task, policy, and expiry. Expired
sessions are immutable for audit reads and reject all new turns, captures,
approvals, and artifact mutations.

## E2B Cowork runtime profile

The first managed profile is `cowork-e2b-ephemeral-v1`:

- pinned `linux/amd64` E2B template built from a minimal single-stage image;
- Node 22, the official ACP SDK, pinned `codex-acp`, pinned OpenCode, and the
  `/usr/local/libexec/onecomputer-acp-chat.mjs` bridge;
- Playwright and a pinned Chromium/Firefox runtime for browser tasks;
- optional document tooling only when the image explicitly declares it;
- a task-confined filesystem under `/workspace/task`, with no host mounts;
- provider-native network allowlist plus the signed external egress proxy;
- no Kasm daemon, VNC server, desktop login, nested KVM, or durable volume.

The image is promoted by digest, carries SBOM/provenance, and never contains
model-provider keys, enterprise OAuth tokens, E2B credentials, or registry
passwords. E2B template build credentials are short-lived and supplied only to
the build command.

## Near-term acceptance goal: Cowork API Gold Path

Before investing further in UI polish, qualify one complete session through the
real API. The session must use the E2B Cowork profile, a real Codex or OpenCode
ACP process, and the governed LiteLLM route. Fixtures may be used for negative
tests, but never for the successful path.

### Required scenario

1. Create one owned Cowork session with an idempotency key and receive a
   session-scoped identifier (not a durable workspace launch).
2. Send a basic question and receive an ordered streaming response containing
   a real assistant answer and a terminal event.
3. Send a follow-up question that depends on the first turn; prove that the
   same ACP session retains context.
4. Ask the agent to use the sandbox Python interpreter to create:
   - a valid `.docx` using the pinned `python-docx` runtime;
   - a valid `.xlsx` using the pinned `openpyxl` runtime; and
   - a valid `.pptx` using the existing presentation toolchain.
5. Register each file as a session-owned artifact with byte size, SHA-256
   digest, MIME type, and provenance linking it to the generating turn.
6. Retrieve each artifact through the authenticated API and validate the Office
   ZIP/package structure. The browser must not be the source of truth for file
   validity.
7. Capture at least one real browser PNG from inside E2B, hash-link it to an
   activity sequence, and retrieve it through the session VCR endpoint.
8. Cancel a second turn and prove that the ACP process terminates without a
   fabricated assistant message or dangling stream.
9. Destroy/expire the session and prove that new turns, captures, and artifact
   mutations fail closed, the E2B sandbox is killed, and no durable workspace
   or credential remains.

### Conversation-history contract

Conversation history is owned by Control and survives provider boundaries. The
E2B filesystem, ACP process, browser, and vendor session are caches or runtime
state—not the authoritative transcript.

- Persist user-visible user messages, assistant messages, tool-call summaries,
  tool results, artifact references, turn status, and sequence metadata in the
  session's redacted, append-only history.
- Never persist hidden chain-of-thought, provider credentials, auth headers,
  raw browser cookies, or unbounded diagnostic output.
- Bind every history record to tenant, subject, session, turn, agent, policy
  hash, and an integrity predecessor; enforce the same ownership checks on
  history reads as on event and artifact reads.
- A reconnecting SSE client can replay history and activity from a cursor and
  reconstruct the same conversation without duplicate turns or missing
  terminal events.
- After an ACP process restart or E2B pause/resume, Control attempts the
  negotiated vendor `session/load` path with the exact provider session id. If
  the harness cannot restore context, the API fails explicitly; it must never
  silently start a blank session or fabricate continuity.
- The canonical Control history remains readable under the documented audit
  retention policy after the sandbox is destroyed, while all new mutations are
  rejected after expiry.

The acceptance run must perform at least three dependent turns, force an SSE
disconnect/replay, restart or resume the provider, and verify that the same
user-visible history and turn ordering are returned through the API before and
after recovery.

### Gold Path exit criteria

The goal is achieved only when all of the following are true in one API E2E
run:

- Codex and OpenCode each pass the chat and artifact scenario;
- three dependent turns, provider restart/resume, and SSE replay preserve the
  same canonical conversation history without gaps, duplicates, or silent
  context loss;
- SSE replay has monotonic sequence numbers, correct session/turn binding, and
  an explicit terminal event;
- the answer, Office files, and PNG are non-empty real outputs, not fixtures;
- Python execution is path-confined, bounded, and has no host filesystem or
  provider-key access;
- cross-user reads return `404`, expired-session mutations fail closed, and no
  secret appears in events, artifacts, logs, or ACP transcript records;
- the E2B sandbox cleanup and grant revocation are evidenced after the run;
- the browser E2E is then run as a projection of this already-passing API
  session.

### API streaming and lifecycle qualification matrix

The Gold Path is not green until the API tests exercise these transitions
against the real adapter (and the same transitions against a deterministic
provider double for fast regression):

| Area | Required proof |
| --- | --- |
| SSE connection | `Content-Type: text/event-stream`, no buffering, heartbeat/reconnect behavior, and `Last-Event-ID`/`after` replay without duplicates |
| Event ordering | Monotonic sequence numbers, one session/turn binding, bounded event size, and an explicit terminal event for success, cancellation, timeout, and failure |
| Backpressure | Slow consumer does not reorder or silently drop events; bounded buffers terminate with a typed retryable error |
| Disconnects | Client disconnect and ACP process exit are recorded, cancellable, and reconciled; no synthetic final answer is emitted |
| E2B create | Provider sandbox is created from the pinned Cowork template with signed policy, scoped grants, route allowlist, and no durable workspace mount |
| Readiness | ACP and browser capability checks complete before the session is reported ready; partial startup fails closed and is cleaned up |
| Resume | A provider pause/resume reconnects the ACP transport without extending the session deadline or losing the canonical event cursor |
| Cancellation | Control cancellation stops the ACP process, closes the stream with a terminal event, revokes active grants, and kills the sandbox when no longer needed |
| Expiry | Creation-anchored TTL rejects new turns/captures/artifact writes even if E2B auto-resumes |
| Cleanup | Sandbox kill, grant revocation, scratch-state purge, and orphan reconciliation are all observed and recorded; retries are idempotent |
| Isolation | A second identity cannot read events, frames, artifacts, provider status, or stream cursors and receives `404` |

The live evidence bundle must include the redacted SSE transcript, event-count
and sequence assertions, provider sandbox/template identifiers, lifecycle
timestamps, and final cleanup result. It must not include prompts containing
secrets, provider credentials, raw ACP diagnostics, or hidden reasoning.

This is the first meaningful Manus-like milestone: a user can ask, converse,
and receive useful Word/Excel/PowerPoint deliverables from a disposable Cowork
session while Control retains truthful streaming, evidence, ownership, and
cleanup guarantees.

### Application-scoped VCR

Cowork VCR means “what the agent did in the application,” not “a streamed
desktop.” The capture contract is explicit:

- browser: Playwright captures the actual page/context inside E2B;
- document: a document-aware capture helper is used only if the profile has
  that application installed;
- desktop: unsupported by the Cowork profile and fails closed with a typed
  capability error; Computer is the correct route.

Each PNG is size-bounded, signature-checked, hash-linked to an activity
sequence, and stored through Control. A screenshot produced by the browser UI,
a fixture, or a host process is not evidence.

## ACP and model boundary

Codex and OpenCode run inside E2B as real ACP stdio servers. Control starts the
allow-listed binary, negotiates the ACP protocol version/capabilities, and
maps updates to the canonical event stream. Model traffic goes only through
the governed LiteLLM route using a short-lived broker grant. The E2B guest never
receives an OpenAI, Anthropic, Kimi, or LiteLLM administrator key.

ACP is not the sandbox, approval, VCR, or model protocol. ACP permission
requests are converted to an exact Control operation and otherwise cancelled;
the UI cannot approve an action by itself. Product-facing SSE is Control’s
ordered replay stream, not a direct unauthenticated ACP socket.

## Lifecycle and failure semantics

1. Authenticate and resolve the signed effective policy.
2. Create an idempotent Cowork session and reserve its budget.
3. Create the E2B microVM from the pinned profile and inject scoped grants.
4. Start Codex or OpenCode ACP in the confined task directory.
5. Stream redacted canonical events; capture application frames at governed
   action boundaries; persist artifacts before returning them to the UI.
6. Pause only as an E2B cost optimization if the session deadline remains
   authoritative; never extend the deadline because a sandbox resumed.
7. Destroy the sandbox, revoke grants, and purge task state at completion,
   cancellation, expiry, budget exhaustion, policy revocation, or provider
   failure. Preserve only the minimum redacted audit evidence.

Provider, process, SSE, browser, and storage disconnects produce explicit
failed/expired states. There is no synthetic assistant response, fake VCR
frame, or “ready” state when a real ACP/model call did not happen.

## Migration sequence

### Phase 0 — contract and documentation (current)

- Adopt this document as the canonical plan.
- Keep Kasm Computer behavior unchanged.
- Add `cowork-e2b-ephemeral-v1` capability metadata and an adapter seam that
  cannot call `open()` or `purgeWorkspace()`.
- Mark the workspace-shaped task handle as compatibility-only.

**Exit:** architecture tests prove Cowork cannot be exposed through the durable
workspace list or a Kasm launch route.

### Phase 1 — local image and ACP qualification

- Build the minimal Cowork image locally or on a large-disk builder.
- Run real Codex and OpenCode ACP against the local LiteLLM route where the
  binaries are available; assert initialize, streaming, cancellation,
  permission cancellation, malformed input, and path confinement.
- Run Playwright in the image and retrieve a real PNG before any UI test.

**Exit:** API qualification is green with no fixture response involved.

### Phase 2 — E2B template and API-first live gate

- Publish the image by digest and create a named E2B template.
- Configure provider-reachable Control, LiteLLM, and egress HTTPS routes.
- Prove create/resume/turn/stream/capture/artifact/cleanup with real E2B
  resources, including owner isolation, budget limits, and zero secret leakage.
- Record sandbox/template ids, image digest, event hashes, PNG hashes, and
  final kill/purge evidence without recording credentials.

**Exit:** the real API gate passes for Codex and OpenCode before browser work.

### Phase 3 — browser UX and Manus-like VCR

- Exercise the Cowork page against the same live API session.
- Render left-side streaming activity and right-side application VCR with
  previous/next, scrub, jump-to-live, reconnect, and truthful degraded states.
- Generate and download a real PPTX from a Cowork session; validate the Office
  package and its evidence links.

**Exit:** browser E2E is a projection of a previously qualified API run.

### Phase 4 — Computer handoff and optional providers

- Add an explicit “open in Computer” handoff that creates/uses a durable Kasm
  workspace only when the user asks for desktop state or takeover.
- Qualify Modal/gVisor or another provider against the same ephemeral contract;
  do not claim Kasm desktop parity for a provider that lacks it.

## Non-negotiable QA gates

- `npm test`, strict TypeScript build, and Playwright regression suite;
- API E2E: real ACP initialize, ordered stream, terminal event, cancellation,
  budget/backpressure, owner isolation, PNG signature/hash, PPTX validation,
  and provider cleanup;
- negative tests: no workspace listing, no Kasm open route, no desktop capture,
  expired-session mutation, invalid policy/grant, route rejection, secret
  leakage, and fabricated/fixture response rejection;
- browser E2E only after API evidence exists; browser failures cannot be hidden
  by fixtures or simulated state.

## Done means

ONEComputer reaches Manus-like Cowork parity when a user can submit a task,
watch a real Codex/OpenCode ACP stream, see truthful browser/document evidence,
scrub and replay it, receive a real artifact, resume within the fixed session
deadline, and observe deterministic cleanup—without ever creating or depending
on a full Kasm workspace.
