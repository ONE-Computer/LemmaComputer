# Issue 010 verification evidence

Recorded: 2026-07-25 (Asia/Singapore)

## Implemented boundary

- The browser uses `@ai-sdk/react` `useChat` and `ai`
  `DefaultChatTransport`.
- Browser traffic remains on the authenticated owned route:
  `/api/v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions/:sessionId/messages`.
- Control validates and converts a canonical NDJSON event stream to the AI SDK
  UI stream protocol. No private workspace URL, adapter bearer key, provider
  credential, Microsoft token, raw approval document, or vendor event payload
  is sent to the browser.
- Native execution remains in the Claude Agent SDK, Codex SDK, and Hermes
  native API adapters. AI SDK does not own model execution or tool authority.

## Package and runtime pins

- `ai@7.0.37` — Apache-2.0
- `@ai-sdk/react@4.0.40` — Apache-2.0
- Claude Agent SDK `0.2.128`; Claude CLI `2.1.215`
- OpenAI Codex SDK/CLI `0.144.4`
- Hermes Agent release `v2026.7.20`; Hermes CLI `0.19.0`
- Workspace image:
  `sha256:75994beb4cbbfae8a8515c2a5e95590bef110cb705a77b49e8b95b1441a66b18`

The direct AI SDK notices are in the repository-root
`THIRD_PARTY_NOTICES.md`. No Vercel-hosted service is configured or required.

## Automated verification

`npm test` passed all 154 tests. The agent stream suite covers:

- the identical owned text/tool/completion contract for Hermes, Claude, and
  Codex;
- stable repeated-tool identifiers and cancellation/failure terminal mapping;
- malformed JSON, out-of-order sequences, abrupt streams, and cross-session
  substitution;
- deterministic workspace-, identity-, policy-, and agent-bound adapter
  authority;
- terminal-history reconciliation when a governed operation completes after
  its model turn was stopped.

`npm run build` passed every workspace. Python byte-compilation, entrypoint
shell syntax, and `git diff --check` also passed.

The attachment contract additionally covers the owned four-file, 8 MiB per
file, and 16 MiB per message limits; data-URL media/signature validation;
unsupported-binary rejection; image mapping for the Claude Agent SDK, Codex
SDK, and Hermes native API; and bounded text/PDF/Office extraction inside the
workspace.

The capability tests also cover model-route vision metadata, fail-closed
Control rejection, and the post-deployment LiteLLM callback. A live
disposable call using `onecomputer-glm` with image content returned HTTP 422
and `MODEL_IMAGE_INPUT_UNSUPPORTED` before provider execution. This is
registry-driven rather than a GLM branch: a route must explicitly advertise
vision support. The currently selected live workspace route was
`onecomputer-openai`, whose deployment advertises vision support, explaining
why the earlier pasted screenshot was accepted.

## Live browser verification

The running workspace had Claude CLI, Codex CLI, and Hermes Agent CLI selected.
It was restarted on the image digest above.

Each agent independently used the same `onecomputer_ms365` surface for a
bounded OneDrive-root read and returned the same three names:

- `Attachments`
- `Meetings`
- `Microsoft Copilot Chat Files`

Claude and Codex exposed nested, stable tool activity for `list-drives`,
`get-drive-root-item`, and `list-folder-files`. Hermes produced its ordered
final text because its qualified private API does not expose intermediate
vendor events.

For each of Claude, Codex, and Hermes:

1. a deliberately long turn was started in Chat;
2. the visible Stop action was used;
3. structured persistence recorded the assistant terminal state as
   `cancelled`;
4. reopening/switching the conversation rendered `Stopped by the employee`;
5. a new turn completed with `RECOVERED` without restarting the workspace.

Desktop and 390-by-844 mobile views were inspected. The transcript stayed
within the viewport, rendered one agent label per assistant turn, nested tool
and approval parts, kept the composer usable, and closed the mobile navigation
drawer after selecting a thread. The browser console had no errors or issues.

After the attachment rollout, the deployed picker added and previewed a PNG,
Claude received it through its native image block and returned
`IMAGE_RECEIVED`, and the transcript reopened with the image and filename.
The deployed Markdown path extracted a synthetic `notes.md` inside the
workspace and Claude returned its exact `ORCHID-731` test value. A synthetic
clipboard `paste` event carrying a PNG produced the same removable preview,
and the composer remained accessible at 390 by 844.

The rollout recreated only the workspace controller, Control API, and web
containers using the combined Issue 002 + Issue 008 compose model. It did not
recreate LiteLLM or remove MCP registrations. The Microsoft 365 connection
reported `connected`, the restarted workspace reported models and tools
`ready`, and a fresh read-only Hermes turn successfully listed `Attachments`
from the OneDrive root through `onecomputer_ms365`.

The final rollout additionally recreated LiteLLM to install global capability
enforcement, then verified the Microsoft 365 connection remained `connected`.
One read-only Hermes regression asked it to find `OC-MVP-DENY.txt` without
being given Graph IDs. Hermes used the common MCP bridge to list the signed-in
user's drive, search the supplied human filename, and report exactly one
matching drive item. No file was changed.

The first run exposed a contract mismatch: the upstream connector schema
advertised `top: 50` and `fetchAllPages`, while Control permits a maximum of
10 results and no all-pages search. Control correctly denied that broad call.
The shared MCP bridge now advertises Control's exact bounded schema
(`top <= 10`, exact `id,name,eTag,parentReference` projection, no
`fetchAllPages`) to Hermes, Claude, and Codex. The repeated live run succeeded
without an agent-specific workaround.

## Protected-operation result

The disposable live target was
`OC-ISSUE-010-CLAUDE-20260725.txt`. Initial prerequisite reads were
rate-limited, so the already-observed drive identifier from the sandbox
agent's own earlier transcript was used to make the bounded protected call
without another listing request.

The upload reached the authoritative Control/OpenVTC
`approval_required` state. Trail showed `waiting for approval`, the redacted
file target and operation binding, and the explicit statement that the exact
action was stored but had not run. Chat rendered `upload-file-content` as
Running with `Waiting for governed approval`, plus a separate
`Waiting for signed approval` governed-action part. The agent entered
`wait-for-governed-operation`; stopping the browser turn persisted one
assistant message with `data-approval: approval_required`,
`data-tool: running`, and terminal state `cancelled`.

The employee subsequently approved the request with the enrolled approval
device. Control recorded the signed decision and one successful execution
receipt, and the 45-byte target appeared in the employee's OneDrive. A second
approved upload operation also converged on success without creating another
named item.

This exposed a transcript-projection defect rather than an approval defect:
the stopped Chat turn retained `Claude is working`,
`wait-for-governed-operation: running`, and `approval_required` even though
Control had later completed the operation. The fix now:

- closes running progress/tool parts whenever a turn reaches a terminal state;
- resolves every approval part against the authenticated owner's current
  Control operation state when history is read;
- refreshes nonterminal governed parts after a stopped turn until they become
  terminal.

Live verification after rollout rendered `Work stopped`,
`Approved action completed`, `Stopped before the tool returned`, and
`Stopped by the employee` for the exact historical turn. It did not claim that
Claude was still active. The workspace was restarted onto the pinned image
above and reported healthy.

The employee then exercised the disposable protected delete through Hermes
for `OC-MVP-DENY.txt`. Operation
`dea2e66d-d92c-4103-94c0-1729f54a93b3` entered `approval_required` at
2026-07-25T07:09:26Z, received a signed OpenVTC approval at 07:12:26Z, and
executed exactly once at 07:12:27Z with receipt `{"success":true}`. The target
disappeared from OneDrive.

The action succeeded, but the original Hermes turn did not receive that final
result. The native trace established the continuity failure:

- `wait-for-governed-operation` held the credentialless stdio bridge's only
  JSON-RPC input loop while it polled Control;
- the blocked bridge could not answer Hermes MCP keepalive pings, so Hermes
  declared it unavailable and reconnected;
- the orphaned call eventually reached Hermes's 300-second MCP timeout;
- Control's five-minute enclosing stream timeout then cancelled Chat, which
  was inaccurately persisted as `Stopped by the employee`.

The shared fix is below the individual agent adapters. MCP tool calls now run
without blocking the stdio input loop, stdout responses are serialized, and
the bridge remains responsive to pings throughout a human approval wait.
Control and the workspace Chat adapter now allow a 15-minute native turn,
longer than the 10-minute governed-operation lifetime. A transport
cancellation is described neutrally instead of being attributed to an
employee stop.

The regression test starts a governed wait that remains pending for one
polling interval and requires the stdio bridge to answer a ping before that
wait completes. After rollout, a clean Hermes session called
`wait-for-governed-operation` for the completed operation, received
`{"success":true}`, streamed `Work complete`, persisted
`Authoritative final result: success=true.`, and ended in the completed state.
The active workspace runs pinned image
`sha256:75994beb4cbbfae8a8515c2a5e95590bef110cb705a77b49e8b95b1441a66b18`
with all three agents ready.

Live denial and live expiry remain verification items.

The existing automated approval suite still passed the authoritative
OpenVTC/signed-decision, denial, expiry, idempotency, and at-most-once
enforcement cases. Those tests do not substitute for the remaining live cases.

## Clean-cutover deletion inventory

- Removed the Hermes-only `apps/control-api/src/hermes-chat.ts` client.
- Removed the final-response Chat send API behavior.
- Removed `chatApi.send` and the bespoke frontend message/busy/send state
  machine.
- Removed flat `{ role, content }` persistence and the old `sessions.json`
  reader.
- Removed `tests/hermes-chat.test.ts`.
- Added no compatibility route, dual persistence reader, migration of
  disposable Chat JSON, or ACP layer.
