# Real E2B ACP deployment runbook

This is the deployment gate for real Cowork execution. Fixture servers and
contract tests are not evidence that a model call occurred.

## Old ONEVibe findings

The old `onevibe-fleet` repository contains a useful ACP reference in
`api/scripts/onevibe-acp.ts`: it uses the official TypeScript ACP SDK over
stdio, initializes the runtime, configures a LiteLLM gateway, and waits for a
terminal prompt response. Its sandbox service is explicitly stubbed whenever
`SANDBOX_ENABLED=false`, so those fallback handles are not suitable evidence
and were not ported. The authoritative legacy `onevibe` history also has a
stronger behavioral reference in commits `d8371ff`, `175df85`, `3c6d0e9`, and
`6e4c605`: conversation-owned sandbox workers, LiteLLM routing, durable
redacted journals, hash-deduplicated X11 PNG checkpoints, and a live SSE/PPTX
acceptance harness. These are requirements to reproduce with the current
provider-neutral contracts, not commits to merge wholesale.

## Runtime contract

The workspace image must contain:

- the pinned `@agentclientprotocol/codex-acp` and `opencode-ai` packages;
- `/usr/local/libexec/onecomputer-acp-chat`, which starts `codex-acp` or
  `opencode acp` and exposes the bounded NDJSON chat contract;
- Chrome/Firefox and `gnome-screenshot` for provider-local VCR capture;
- the ONEComputer gateway proxy and connector bridge.

At creation, Control passes only a signed policy, short-lived gateway grant,
agent bridge grant, and chat API key. The E2B adapter returns provider-hosted
chat endpoints (`8644` Codex, `8645` OpenCode). Control uses those endpoints
for the selected E2B workspace; the Docker-only `onecomputer-sandbox-*` DNS
route is never used for managed sandboxes.

The bridge keeps the canonical user/assistant transcript in a bounded,
mode-`0600` record on the task volume and rejects concurrent turns for one
session. The record contains user-visible messages only; ACP thought chunks,
credentials, and raw diagnostics are never persisted. On provider-process
restart, the bridge starts a fresh provider-local ACP process and calls
`session/load` with the exact persisted vendor session ID. If the selected
harness does not advertise `loadSession`, or the vendor rejects the load, the
endpoint fails closed rather than creating a new context or returning an empty
synthetic conversation. Control activity/SSE remains the authoritative replay
source; the provider record exists to restore the vendor context for the next
real turn. The record is atomically replaced, capped at 32 MiB, protected by a
task-scoped HMAC derived from the chat capability key, and never contains that
key itself.

E2B’s lifecycle has an important implication for Cowork: `onTimeout: "pause"`
preserves the full sandbox and can keep cycling indefinitely when auto-resume
is enabled, while `kill` is terminal. The adapter therefore uses pause/resume
only as a provider-level optimization and relies on the Control reaper’s fixed
task-creation deadline to call destroy and volume purge. Every live run must
record both the E2B `sandboxId`/`templateId` and the final `killed`/volume state.
E2B secure access must remain enabled; custom templates need an envd version
that supports secured access.

The provider-local screenshot path is now explicit: an authenticated Control
request for a ready, task-owned workspace calls the controller's
`/internal/v1/sandboxes/:providerId/vcr/frames` endpoint, which invokes the
managed adapter inside E2B. Control validates the PNG, stores it under the
task owner, and appends a hash-linked `workspace-frame` event. Kasm adapters
without a provider capture capability fail closed with `503`; they do not
silently fall back to a host screenshot. E2B browser and document captures
select a visible Chrome/Firefox or LibreOffice window with `xdotool` and use
`gnome-screenshot -w`; if no matching application window exists, capture fails
closed. A desktop capture remains available explicitly as
`sourceApplication: "desktop"`.

Control also fail-closes all task-mutating paths after the one-hour ephemeral
Cowork deadline: new chat turns, provider VCR uploads, and PPTX creation return
`ONEVIBE_TASK_EXPIRED`. Task/event/VCR rows remain retained for governed audit
access (the owner-facing route still requires an active identity).
This is a capability boundary, not cleanup proof. Control now includes an
identity-policy-backed ephemeral reaper (`ONEVIBE_EPHEMERAL_REAPER_INTERVAL_SECONDS`)
that stops the provider, revokes grants, and purges the disposable volume while
retaining task/event/VCR rows for audit replay. Live qualification must enable
that reaper and attach evidence that an expired E2B sandbox and volume are
actually removed; an enabled timer or an expiry timestamp alone is not cleanup
proof.

Control-owned PNG/PPTX bytes have a separate governed retention timer
(`ONEVIBE_ARTIFACT_RETENTION_DAYS`, default 90 days). It deletes expired bytes
without deleting task/event evidence rows, so audit records remain available
while download URLs eventually fail closed after the retention window.

## Provisioning

1. Build and publish an immutable workspace template from the exact
   `docker/Dockerfile.workspace` digest.
2. Configure the workspace controller with `SANDBOX_DRIVER=e2b`, the pinned
   `E2B_TEMPLATE_ID`, external policy-bound egress proxy template, and the
   controller policy verification keys.
3. Configure LiteLLM as the only model gateway. Do not put provider API keys
   in the template, E2B environment, or agent filesystem.
   E2B command-scoped environment variables are not private in the guest OS;
   only short-lived, policy-scoped broker grants may be projected, and the
   bridge itself receives the loopback broker credential rather than a
   provider key.
4. Start a task with an OpenCode or Codex policy and verify the controller
   response contains the matching provider-hosted chat endpoint.
5. `GET /health` on that endpoint with the scoped chat key. It must report
   `transport: "acp"` and the selected agent.
6. Create a session and send a harmless prompt. Capture the raw Control-side
   canonical stream and verify:
   - `turn-start` is sequence 0;
   - at least one non-empty `text-delta` is returned by the real runtime;
   - a `turn-finish` terminal event follows with no sequence gaps;
   - LiteLLM request logs show the policy model alias and the scoped grant;
   - no fixture host, fixture task ID, or deterministic marker appears.
7. Capture a PNG from inside E2B, validate its PNG signature/hash and append
   the Control-owned VCR event before presenting it to the UI.
8. Destroy the task, revoke the gateway grant, kill the sandbox, and purge its
   volume. Re-read the endpoint and VCR URL; both must fail closed.

The repository now includes the guarded acceptance command:

```bash
ONECOMPUTER_E2B_LIVE=1 \
ONECOMPUTER_CONTROL_URL=https://control.example.com \
ONECOMPUTER_PROXY_TOKEN=... \
ONECOMPUTER_SESSION_COOKIE='...' \
ONECOMPUTER_CONTROLLER_URL=https://controller.example.com \
ONECOMPUTER_CONTROLLER_INTERNAL_TOKEN=... \
E2B_API_KEY=... \
E2B_TEMPLATE_ID=... \
ONECOMPUTER_E2B_DENY_HOST=example.com \
npm run qualify:e2b:cowork
```

`qualify-e2b-cowork.mts` creates two real task-scoped conversations, verifies
the selected ACP agent and provider metadata, performs two turns in one
session, checks unauthenticated provider-host access, records a PNG and PPTX,
probes a caller-supplied non-allowlisted hostname, and explicitly stops/purges
both workspaces. It writes only redacted hashes
and IDs under `.artifacts/e2b-live/`; it refuses fixture mode or missing
credentials before allocating anything.

For network qualification, inspect E2B `getInfo()` after creation and assert
that `allowInternetAccess` and `network.allowOut` match the signed route set.
Then prove a direct non-allowlisted destination fails while the governed
egress/model/control routes succeed; the configuration alone is not evidence
of enforcement.

## Required live qualification evidence

The release is not qualified until the following are attached to the build:

- E2B sandbox ID/template digest and creation timestamp;
- ACP initialization and provider-configuration transcript with credentials
  redacted;
- LiteLLM request ID/model alias and a non-empty response hash;
- canonical event stream hash and terminal state;
- in-sandbox PNG hash, dimensions, source application, and VCR event sequence;
- cleanup proof for sandbox, volume, grant, and endpoint reachability.

Never substitute `scripts/ui-fixture-server.mjs` for this gate. It is only an
explicitly opt-in Playwright contract fixture (`ONECOMPUTER_UI_FIXTURE=1`).

## E2B operational practices applied

The implementation follows E2B's documented lifecycle and security guidance:

- Use `secure: true` for exposed sandbox hosts and validate the scoped bearer
  token on every provider endpoint ([secured access](https://e2b.dev/docs/sandbox/secured-access)).
- Treat `onTimeout: "pause"` as resumable state, not deletion; use an explicit
  task deadline and reaper for terminal cleanup ([auto-resume](https://e2b.dev/docs/sandbox/auto-resume),
  [persistence](https://e2b.dev/docs/sandbox/persistence)).
- Inspect `getInfo()` and verify `allowInternetAccess`, `network.allowOut`,
  metadata, and volume mounts rather than trusting local configuration
  ([create](https://e2b.dev/docs/api-reference/sandboxes/create-sandbox),
  [get](https://e2b.dev/docs/api-reference/sandboxes/get-sandbox)).
- Keep secrets out of image layers and command-scoped environment variables;
  the broker grants only short-lived credentials ([environment variables](https://e2b.dev/docs/sandbox/environment-variables)).
- Keep the browser/desktop evidence inside the sandbox boundary and transfer
  only bounded PNG bytes through the authenticated controller ([computer use](https://e2b.dev/docs/use-cases/computer-use)).

## E2B Cowork design notes from the current SDK documentation

The following details are part of the runtime contract rather than optional
implementation trivia:

- Templates are immutable launch artifacts. The image build must install the
  ACP binaries, browser/document applications, `xdotool`, and screenshot
  tooling, then use a start/ready check so a newly created sandbox is ready
  without an unbounded bootstrap race ([template start and ready](https://e2b.dev/docs/template/start-ready-command)).
- `pause` preserves filesystem and memory, including running processes, while
  `kill` is terminal. A paused sandbox is not a substitute for task retention:
  the Control deadline and reaper still own the deletion decision. Paused
  services also lose external connections and clients must reconnect after
  resume ([persistence](https://e2b.dev/docs/sandbox/persistence),
  [connect](https://e2b.dev/docs/api-reference/sandboxes/connect-to-sandbox)).
- Auto-resume is persistent and can keep a sandbox cycling indefinitely while
  requests arrive. This is useful for an interactive Cowork task only while
  its signed task deadline is valid; the reaper must remain authoritative
  ([auto-resume](https://e2b.dev/docs/sandbox/auto-resume)).
- Long-running ACP processes and browser servers should be started as
  background processes with an explicit command timeout. Their stdout/PTY
  streams must be treated as reconnectable transport, not as durable history;
  Control evidence and transcript persistence remain the source of record
  ([background commands](https://e2b.dev/docs/commands/background),
  [command execution](https://e2b.dev/docs/cli/exec-command)).
- Every create/connect response must be inspected for `envdVersion`, secure
  access state, lifecycle, metadata, network policy, and volume mounts. A
  locally requested option is not enforcement evidence; live qualification
  must compare the provider response with the signed route set
  ([create](https://e2b.dev/docs/api-reference/sandboxes/create-sandbox),
  [get](https://e2b.dev/docs/api-reference/sandboxes/get-sandbox)).
- Secure access tokens are scoped to the sandbox controller and must never be
  copied into the ACP transcript, task events, or artifact metadata. Direct
  envd/file/process requests require that token, and the token should be
  renewed on connect/resume rather than cached as a user credential
  ([secured access](https://e2b.dev/docs/sandbox/secured-access),
  [environment variables](https://e2b.dev/docs/api-reference/envd/get-the-environment-variables)).
- If we later use E2B snapshots for warm-start performance, snapshot creation
  briefly drops active connections. The Cowork transport must reconnect and
  replay from the last acknowledged sequence; a snapshot is a performance
  optimization, not a transcript store ([snapshots](https://e2b.dev/docs/sandbox/snapshots)).

These notes explain two deliberate boundaries in this repository: E2B is the
execution and visual-evidence boundary, while Control owns task deadlines,
redacted durable activity, replay, approvals, and cleanup proof. No E2B
pause/resume or snapshot behavior is allowed to silently extend a Cowork task
or fabricate a missing ACP transcript.

## Current known prerequisite

The repository now contains the provider-hosted ACP bridge and routing logic,
but a live run still requires an approved E2B template ID, reachable governed
egress/control routes, and valid runtime credentials. Until that qualification
is completed, production must fail closed rather than claim an ACP result.

The next hardening items are explicit: qualify the existing TTL reaper's
destroy/revoke/purge behavior against E2B and maintain the gated live E2B
acceptance harness covering two real conversations, follow-up session reuse,
frame hash deduplication, PPTX magic bytes, and cleanup. The existing
fixture Playwright suite remains a UI contract test, not a substitute for that
gate.
