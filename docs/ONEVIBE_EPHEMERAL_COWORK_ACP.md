# ONEVibe ephemeral Cowork and ACP qualification

> **Canonical architecture:** [COWORK_E2B_ACP_PLAN.md](./COWORK_E2B_ACP_PLAN.md).
> This page is the API qualification checklist; it is not a Kasm provisioning
> contract.

## Decision

Cowork is a task-scoped session, not a durable workspace. A normal chat starts
an E2B microVM from the `cowork-e2b-ephemeral-v1` profile. The current API may
return a workspace-shaped compatibility handle while the session schema is
migrated; that handle is never a Kasm workspace, never appears in the durable
workspace list, and must not gain an `open` or persistent-volume path.

The selected execution provider is policy-controlled. The first short-lived
provider is E2B (Firecracker); Kasm remains the durable Computer provider.
Modal (gVisor) is a later optional implementation of the same ephemeral
contract, not a Kasm desktop substitute.

## ACP execution boundary

Codex ACP and OpenCode ACP run inside the task-scoped E2B sandbox. Control owns
the Cowork session, policy, approval authority, event sequence, VCR manifest,
and artifact ownership. The sandbox receives only scoped gateway/control
credentials. No host process, host filesystem, Kasm volume, or host provider
key crosses into the E2B process.

The provider-hosted chat bridge is `/usr/local/libexec/onecomputer-acp-chat.mjs`. It launches the pinned `codex-acp` or `opencode acp` binary, performs ACP initialization and governed provider configuration, and exposes only the bounded canonical NDJSON chat contract. Control obtains the E2B-hosted endpoint from the signed controller response; it does not use the Docker-only `onecomputer-sandbox-*` DNS route for managed sandboxes. Permission requests default to cancellation until a Control-owned approval resolver is connected, so the bridge cannot silently approve a protected action.

OpenCode is launched as `opencode acp` (nd-JSON over stdin/stdout); it does not require a separate `*-acp` package. Codex uses the pinned `codex-acp` runtime. Both require a broker gateway in governed mode.

## Evidence ordering

For browser or document work the qualification order is deliberately API-first:

1. E2B creates the sandbox with the signed policy and external TLS egress proxy.
2. The browser/document capture command executes inside E2B. Browser capture
   is Playwright/application-scoped; a desktop screenshot is not a Cowork
   capability.
3. The capture adapter returns a bounded PNG and Control validates the capture grant, MIME, size, and hash.
4. Control appends the VCR frame event to the task evidence chain.
5. Only then does the Cowork SSE/NDJSON stream project the event to the UI.
6. PPTX generation is task-owned and appends an artifact event before the download link is rendered.

The UI is therefore never the source of truth for a screenshot, approval, or artifact.

## Required API gates

- ACP initialization/version negotiation for Codex and OpenCode.
- Ordered canonical events with no hidden reasoning or credentials.
- Permission requests resolve only through a governed operation.
- Cancellation, timeout, malformed transport, and process exit fail closed.
- Chat stream parsing rejects sequence gaps, wrong session/turn IDs, oversized frames, malformed JSON, and missing terminal events.
- E2B capture returns a valid bounded PNG before VCR ingestion.
- Cross-user/session reads return `404`; Cowork never becomes a durable
  workspace listing or Kasm launch.
- Control fail-closes all task-mutating paths (chat, provider capture, and
  PPTX creation) after the fixed deadline. Task/event/VCR rows remain retained
  for governed audit access. The reaper must destroy the E2B sandbox, revoke
  grants, and purge disposable state; a timestamp or enabled timer is not
  cleanup evidence.

## Live qualification prerequisites

The repository contains deterministic contract tests and an E2B adapter capture
test. Those tests are fixtures, not provider evidence. A real-provider gate
requires an approved pinned **minimal Cowork** E2B template containing ACP,
OpenCode, Codex, and the browser capture runtime plus public TLS
Control/LiteLLM/egress routes. The live gate must prove a non-empty model
response through LiteLLM, ordered ACP events, a real in-sandbox PNG, and
cleanup. No API key is committed; local qualification keys remain ignored and
mode `0600`.
