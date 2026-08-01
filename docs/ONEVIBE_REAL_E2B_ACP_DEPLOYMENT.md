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

The bridge keeps the canonical user/assistant transcript for the lifetime of
the ACP process and rejects concurrent turns for one session. It does not
invent history: after the provider process is lost, the session is unavailable
and the endpoint returns `404` rather than an empty synthetic conversation.
Durable replay and restart recovery remain a release gate, not a hidden
fallback.

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
silently fall back to a host screenshot. The current E2B implementation still
captures the desktop surface; Chrome/Word window targeting is a follow-up
hardening item.

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
npm run qualify:e2b:cowork
```

`qualify-e2b-cowork.mts` creates two real task-scoped conversations, verifies
the selected ACP agent and provider metadata, performs two turns in one
session, checks unauthenticated provider-host access, records a PNG and PPTX,
and explicitly stops/purges both workspaces. It writes only redacted hashes
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

## Current known prerequisite

The repository now contains the provider-hosted ACP bridge and routing logic,
but a live run still requires an approved E2B template ID, reachable governed
egress/control routes, and valid runtime credentials. Until that qualification
is completed, production must fail closed rather than claim an ACP result.

The next hardening items are explicit: add durable session/replay persistence;
qualify the existing TTL reaper's destroy/revoke/purge behavior against E2B;
add Chrome/Word window targeting to provider-local capture; and add a gated live
E2B acceptance harness covering two real conversations, follow-up session
reuse, frame hash deduplication, PPTX magic bytes, and cleanup. The existing
fixture Playwright suite remains a UI contract test, not a substitute for that
gate.
