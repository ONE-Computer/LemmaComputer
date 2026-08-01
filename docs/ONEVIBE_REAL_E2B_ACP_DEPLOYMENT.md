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

Control also fail-closes all task-mutating paths after the one-hour ephemeral
Cowork deadline: new chat turns, provider VCR uploads, and PPTX creation return
`ONEVIBE_TASK_EXPIRED`. Read-only evidence replay remains available for audit.
This is a capability boundary, not cleanup proof; production still needs a
provider reaper to stop the sandbox, revoke gateway grants, and purge its
ephemeral volume.

## Provisioning

1. Build and publish an immutable workspace template from the exact
   `docker/Dockerfile.workspace` digest.
2. Configure the workspace controller with `SANDBOX_DRIVER=e2b`, the pinned
   `E2B_TEMPLATE_ID`, external policy-bound egress proxy template, and the
   controller policy verification keys.
3. Configure LiteLLM as the only model gateway. Do not put provider API keys
   in the template, E2B environment, or agent filesystem.
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

## Current known prerequisite

The repository now contains the provider-hosted ACP bridge and routing logic,
but a live run still requires an approved E2B template ID, reachable governed
egress/control routes, and valid runtime credentials. Until that qualification
is completed, production must fail closed rather than claim an ACP result.

The next hardening items are explicit: add durable session/replay persistence
and a TTL reaper that revokes grants and purges ephemeral volumes; expose
provider-local, source-application PNG capture (Chrome/Word window targeting)
through the controller capture-grant endpoint; and add a gated live E2B
acceptance harness covering two real conversations, follow-up session reuse,
frame hash deduplication, PPTX magic bytes, and cleanup. The existing fixture
Playwright suite remains a UI contract test, not a substitute for that gate.
