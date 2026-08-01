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
