# Hermes final-answer slice of #85

## Scope and trade-off

Hermes's native `assistant.delta` stream mixes intermediate assistant commentary
with answer tokens. Its `assistant.completed.content` contains the final reply.
The adapter now discards the ambiguous deltas, continues forwarding sanitized
tool activity, and publishes the explicit final reply once, after successful
`run.completed` and stream completion. It does not classify prose heuristically.

The answer appears at completion rather than token-by-token. Model/tool work and
latency are unchanged. This does not implement #85's cross-agent Thinking surface,
commentary persistence, or all-adapter conformance. Claude and Codex are unchanged.
The existing shared input marker, artifact collection, source extraction,
cancellation, and detached replay mechanisms remain in place.

Missing final events, interrupted/partial answers, failed native runs, and provider
failures do not fall back to mixed deltas. An explicitly empty final is permitted
for artifact-only responses. A cancelled stream propagates cancellation and does
not publish pending text as a completed answer.

No schema, migration, credentials, connectors, routing, or tenant-boundary changes.
Both deployment profiles use the same adapter. Deploying the change requires an
updated workspace image and refreshing the applicable workspace runtimes; a Web
image rebuild alone is insufficient. Existing saved transcripts are not rewritten.

## Automated verification

Run from the initialized task worktree:

```bash
node --import tsx --test tests/hermes-final-answer.test.ts tests/agent-chat.test.ts
npm run verify:quick
LEMMACOMPUTER_E2E_FIXTURE_PORT=29791 LEMMACOMPUTER_E2E_WEB_PORT=29792 npm run test:e2e -- tests/e2e/chat-multi-thread.spec.ts
LEMMACOMPUTER_E2E_FIXTURE_PORT=29791 LEMMACOMPUTER_E2E_WEB_PORT=29792 npm run test:e2e -- tests/e2e/chat-refresh.spec.ts
```

The new tests execute the actual Python adapter against scripted native SSE,
without provider credentials. They cover mixed commentary, live tool events,
duplicate completion messages, final-only responses, input markers, failed and
truncated runs, incomplete final answers, cancellation, and empty artifact-only
answers. All five new tests failed against the original implementation and pass
with the fix. The combined focused suite passes 25 tests.

Quick gate: 891 passed, 39 expected database/optional skips, zero failures.
Browser fixtures: one multi-thread test and three refresh/cancellation/site tests
passed. These browser fixtures exercise the existing shared chat lifecycle; the
native Hermes translation is covered by the Python-backed regression tests and
the live test below. Database qualification is not required for this slice.

## Live Lite qualification — 2026-09-07

Used the existing local stateful stack, Test workspace, Hermes CLI, with Lite
explicitly selected in the web composer and independently verified in Control's
run record. No provider credentials were copied into the development worktree.

The test temporarily replaced only Test's chat-adapter executable with the exact
candidate bytes and restarted only that adapter, after verifying no active chats.
The original executable was backed up and restored after qualification, its SHA256
matched the pre-test value, and the adapter health check passed. No workspace
image, shared stack, persistent home, or remote deployment was changed.

### Original reproduction

- Chat: `328fbcca-7d55-4941-a979-b3c5b40d768d`.
- Prompt: `can you tell me more about the world bank projects from your knowlege?`
- Requested service class: `lite`; run completed in approximately 60 seconds.
- Native session: `api_1788739532_9bea67e6`; 16 tool calls, six model calls.
- Tools: one skill view, ten file reads, five file searches against the local wiki.
- Native history contained four nonempty intermediate assistant messages plus
  its final answer. Control persisted exactly one text part, byte-for-byte equal
  to the native final answer (8,253 characters), excluding those four messages.
- During work, the browser showed tool progress without repeated preambles.
- Refreshed during the live run; it reconnected and automatically displayed the
  final answer, with the composer enabled, without another refresh.
- No application error was observed; the only captured console error was from a
  browser-extension content script, not the application.

### Cancellation

- Chat: `bd1b093a-441a-480b-8507-47e786a7a23c`.
- A separate Lite, read-only local-wiki comparison was stopped through the UI.
- Control saved `cancelled`; Web showed `Work stopped` / `Stopped by the employee`
  and re-enabled the composer without publishing a partial answer.
- Native provider-failure cases were tested with deterministic fixtures, not by
  disrupting the live provider or changing credentials.

## Remaining release work

This is implementation and qualification evidence, not a deployment or closure
of #85. Merge/push and workspace-image rollout are separate steps. No all-agent
conformance, live Telegram transport, or remote EC2 release is claimed here.
