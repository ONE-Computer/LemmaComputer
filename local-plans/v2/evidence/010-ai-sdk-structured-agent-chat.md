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
  `sha256:ecff2323ccb55dae8a801d6a8d74a6e749934e9d8efce04090a30a75f3355001`

The direct AI SDK notices are in the repository-root
`THIRD_PARTY_NOTICES.md`. No Vercel-hosted service is configured or required.

## Automated verification

`npm test` passed all 151 tests. The agent stream suite covers:

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

Protected delete, live denial, and live expiry remain verification items.

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
