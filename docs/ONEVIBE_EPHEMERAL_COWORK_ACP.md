# ONEVibe ephemeral Cowork and ACP qualification

## Decision

Cowork is a task, not a durable workspace. A user may choose a durable workspace for long-running work, but a normal chat starts a task-scoped ephemeral sandbox. The API creates the sandbox, binds the task and policy, and returns a short-lived workspace view only as an implementation handle. The UI does not list that handle as a durable workspace.

The selected execution provider is policy-controlled. The first short-lived provider is E2B (Firecracker); Kasm remains the durable visual-workspace provider. Modal (gVisor) uses the same adapter contract and is qualified separately.

## ACP execution boundary

Codex ACP and OpenCode ACP run inside the task-scoped E2B sandbox. Control owns the user session, policy, approval authority, event sequence, VCR manifest, and artifact ownership. The sandbox receives only scoped gateway/control credentials. No host process, host filesystem, or host provider key crosses into the E2B process.

The provider-hosted chat bridge is `/usr/local/libexec/onecomputer-acp-chat.mjs`. It launches the pinned `codex-acp` or `opencode acp` binary, performs ACP initialization and governed provider configuration, and exposes only the bounded canonical NDJSON chat contract. Control obtains the E2B-hosted endpoint from the signed controller response; it does not use the Docker-only `onecomputer-sandbox-*` DNS route for managed sandboxes. Permission requests default to cancellation until a Control-owned approval resolver is connected, so the bridge cannot silently approve a protected action.

OpenCode is launched as `opencode acp` (nd-JSON over stdin/stdout); it does not require a separate `*-acp` package. Codex uses the pinned `codex-acp` runtime. Both require a broker gateway in governed mode.

## Evidence ordering

For browser or document work the qualification order is deliberately API-first:

1. E2B creates the sandbox with the signed policy and external TLS egress proxy.
2. The browser/document capture command executes inside E2B.
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
- Cross-user/task/workspace reads return `404`.
- Ephemeral task creation returns `task + ephemeral workspace handle`; the handle is hidden from durable workspace listings. Control now fail-closes all task-mutating paths (chat, provider capture, and PPTX creation) after the one-hour deadline; read-only evidence replay remains available. A production TTL/reaper is still required to stop the provider sandbox, revoke its gateway grants, and purge its volume after expiry; the timestamp and write gate are not cleanup evidence.

## Live qualification prerequisites

The repository contains deterministic contract tests and an E2B adapter capture test. Those tests are explicitly fixtures and are not provider evidence. A real-provider gate still requires an approved pinned E2B template containing the ONEComputer image, ACP runtimes, OpenCode, browser capture utility, and the public TLS egress/control routes. The live gate must prove a non-empty model response through LiteLLM, ordered ACP events, a real in-sandbox PNG, and cleanup. No API key is committed or placed in local environment files by this change.
