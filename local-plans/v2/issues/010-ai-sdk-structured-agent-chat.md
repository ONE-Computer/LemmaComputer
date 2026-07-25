# 010: replace the bespoke Chat surface with AI SDK structured streaming

Status: `verification`

Priority: P1
Depends on: 003, 007
Supersedes: 009
Unblocks: durable remote agent tasks and multi-device control

## Outcome

An employee can chat with any policy-selected Hermes, Claude, or Codex agent
through a responsive ONEComputer Chat surface that streams text and structured
agent activity, presents governed approval state clearly, supports stopping a
running turn, and reloads completed conversation history without the web app
maintaining a bespoke chat state machine.

## Product decision

- Keep the working native execution adapters: Hermes through its qualified
  native interface, Claude through the Claude Agent SDK, and Codex through the
  Codex SDK.
- Use Vercel AI SDK only for the web Chat state, UI message model, transport,
  and structured streaming boundary. Do not replace the native agent loops
  with AI SDK model providers or `ToolLoopAgent`.
- Defer ACP. It is neither required by this issue nor part of its acceptance
  criteria.
- This product is pre-release and fully in development. Make a clean cutover:
  remove superseded final-only APIs, flat-message storage, frontend state, and
  tests instead of maintaining backward compatibility, dual routes, legacy
  schema readers, migrations for disposable development data, or fallback
  behavior.

## In scope

- Pin the Apache-2.0 `ai` and `@ai-sdk/react` packages and record their
  third-party notices.
- Replace `ChatScreen`'s manually managed message, busy, error, send, stop, and
  streaming state with AI SDK `useChat` and typed `UIMessage` parts.
- Define one owned canonical agent-event mapping for text deltas, reasoning or
  progress where safely available, tool start/progress/completion, governed
  approval waiting, final completion, cancellation, and failure.
- Stream those events from each existing native adapter through the private
  workspace service and authenticated Control route to the browser using the
  AI SDK UI stream protocol.
- Render one coherent assistant turn with nested progress/tool/approval parts;
  do not emit a separate assistant row or agent label for every event.
- Preserve agent selection and bind each conversation to its workspace and
  selected agent.
- Persist the new completed `UIMessage` representation, or an owned equivalent
  that converts losslessly to it, so reopening a conversation reproduces the
  same transcript.
- Provide an explicit stop action that cancels the active adapter turn and
  leaves the conversation in an accurate, recoverable state.
- Surface stream failures and agent unavailability without losing the
  employee's submitted message or falsely reporting tool completion.
- Accept up to four bounded attachments per message through the file picker or
  clipboard paste. Send validated images through each native agent's image
  input and convert supported text, PDF, and Office documents to bounded,
  explicitly delimited prompt content inside the workspace.
- Keep Microsoft 365 access exclusively behind the existing credentialless
  `onecomputer_ms365` bridge and authoritative Control approval flow.
- Apply one shared agent operating contract to Hermes, Claude, and Codex:
  agents resolve human-facing names, paths, links, and screenshot values with
  assigned read/search tools before asking the employee for provider-internal
  identifiers. Advertise the exact bounded Control argument contract in MCP
  tool schemas so agents are not invited to make calls policy will reject.
- Declare model input capabilities in the LiteLLM route registry. Reject image
  input fail-closed in Chat and in a post-routing LiteLLM callback whenever
  the selected deployment does not explicitly advertise vision support.

## Out of scope

- ACP integration, generic agent discovery, replacing the native Hermes,
  Claude, or Codex SDKs, or moving model execution into Vercel AI SDK.
- Vercel AI Gateway, Vercel hosting, Vercel Workflow, or any requirement to
  send ONEComputer prompts, credentials, or telemetry through Vercel services.
- Cross-device relay, mobile push, background execution after the workspace is
  stopped, durable task queues, multi-device presence, or the final remote
  agent-control architecture. This issue creates a suitable Chat/event
  boundary but does not claim those later capabilities.
- Voice, unbounded or executable attachments, cross-agent transcript
  migration, agent handoff, or a universal representation of every private
  vendor event.
- Compatibility with Issue 009's final-response endpoint, flat
  `{ role, content }` messages, disposable session JSON, or its frontend API.

## Required implementation

- Add AI SDK only to the web/Control Chat boundary. Native SDK credentials,
  agent process ownership, model routing, MCP configuration, and tool
  execution remain inside the private workspace runtime.
- Define a small canonical event vocabulary with stable IDs and ordering. Map
  vendor events explicitly; never pass raw Claude, Codex, or Hermes payloads
  into browser state.
- Consume the native streaming surfaces rather than waiting for only the final
  response. A vendor that has no intermediate event for a concept may omit
  that part, but it must still produce ordered text/completion/error events.
- Use a single authenticated streaming route selected by workspace, agent, and
  conversation. The browser must not receive private adapter base URLs, bearer
  keys, provider credentials, or workspace-network authority.
- Validate every incoming message and outgoing structured part. Unknown,
  malformed, oversized, out-of-order, cross-session, or cross-agent events
  terminate the affected stream safely and are not persisted as successful
  output.
- Give each turn and tool invocation a stable identifier so concurrent or
  repeated same-name tools attach progress and results to the correct UI part.
- Represent the external ONEComputer approval lifecycle as owned custom data
  parts. AI SDK approval helpers may drive presentation but must not become the
  authorization decision or execution authority.
- Persist completed turns atomically. A cancelled or failed turn must record
  its real terminal state and must never invent an assistant completion.
- Remove the superseded Issue 009 Chat transport, frontend state, persistence,
  and tests in the same cutover. Do not add compatibility shims or maintain two
  chat stacks.
- Keep styling within the existing ONEComputer design system and ensure the
  transcript, tool details, approval state, composer, stop action, and agent
  selector work at desktop and mobile widths.

## Required verification

- [x] AI SDK dependencies are pinned, their licenses are recorded, and no
      Vercel-hosted service is required at runtime.
- [x] Hermes, Claude, and Codex satisfy the same owned stream-contract tests
      for ordered text, completion, cancellation, and failure events.
- [x] Available native tool/progress events map to stable structured parts
      without raw vendor payloads or duplicated assistant rows.
- [x] The web Chat surface streams text incrementally and renders one coherent
      assistant turn with tool and progress details.
- [x] Reloading a completed conversation reproduces the same structured
      transcript for its bound workspace and agent.
- [x] Stopping each live adapter cancels the active turn, records an accurate
      terminal state, and permits a later message without restarting the
      workspace.
- [ ] Malformed frames, abrupt disconnects, timeouts, unavailable runtimes,
      repeated tool names, concurrent sends, and cross-agent/session
      substitution fail safely and visibly.
- [x] A bounded OneDrive read works through each adapter using the same
      assigned `onecomputer_ms365` MCP surface.
- [x] A disposable protected Microsoft 365 write/delete reaches
      `approval_required`, is rendered as waiting in Chat, and executes at
      most once only after the existing signed OpenVTC approval.
- [ ] Approval denial and expiry are rendered accurately and never appear as a
      completed tool action.
- [x] Browser state, streams, persisted messages, errors, logs, screenshots,
      and artifacts contain no adapter keys, provider credentials, Microsoft
      tokens, raw approval secrets, or prohibited vendor payloads.
- [x] File-picker and clipboard image attachments render previews, persist in
      transcript history, enforce the owned count/size/type limits, and reach
      the selected native agent. Supported documents are extracted only
      inside the workspace and are bounded before entering the native prompt.
- [x] Production builds, full automated tests, stream-contract tests, and
      desktop/mobile visual checks pass after the old Chat path is removed.

## Evidence required

- Exact AI SDK package versions and an updated third-party-license inventory.
- Contract fixtures showing the canonical mapping from redacted Hermes,
  Claude, and Codex events to AI SDK UI message parts.
- A redacted stream capture for each adapter covering text, tool progress,
  completion, cancellation, and failure where the native SDK exposes them.
- Desktop and mobile captures showing incremental output, nested tool
  activity, governed approval waiting, denial/expiry, stop, and recovery.
- Live bounded Microsoft 365 read and disposable signed-approval lifecycle
  evidence for all three adapters.
- Inspection proving the browser receives only the owned Control stream and no
  private workspace URL, adapter authority, model credential, or Microsoft
  credential.
- A deletion inventory showing the superseded final-only Chat endpoint,
  frontend state machine, flat persistence, and obsolete tests were removed
  rather than retained as compatibility code.

## Stop conditions

- AI SDK requires Vercel AI Gateway, Vercel hosting, direct provider
  credentials in the browser, or replacement of the qualified native agent
  execution path.
- An adapter cannot expose a safe ordered stream without leaking private
  vendor payloads or weakening workspace isolation.
- Structured Chat approval would bypass, duplicate, or become authoritative
  over the existing signed Control/OpenVTC operation.
- Product direction is required for a vendor-only event that cannot be mapped
  safely into the owned canonical vocabulary.

## Preflight record

Implementation began in `/home/mike/Documents/onecomputer` on
`mike/greenfield-v2`. The worktree already contained the uncommitted Issue 009
native-adapter baseline; it was preserved and cleanly superseded rather than
rewritten for compatibility. The configured remote remained the ONEComputer
repository.

- AI SDK pins: `ai@7.0.37`, `@ai-sdk/react@4.0.40`.
- Native pins: Claude Agent SDK `0.2.128`, Claude CLI `2.1.215`, Codex SDK/CLI
  `0.144.4`, Hermes Agent `v2026.7.20` / CLI `0.19.0`.
- Expected change areas: owned contracts, Control Chat client/routes, web Chat
  state and rendering, native workspace adapters, structured persistence,
  container projection, fixtures/tests, notices, and this plan.
- The local Docker stack and one three-agent workspace were already running.
  The workspace was rebuilt and restarted onto
  `sha256:75994beb4cbbfae8a8515c2a5e95590bef110cb705a77b49e8b95b1441a66b18`.
- Existing provider credentials were reused from the ignored root `.env`; no
  new key was created or copied into source, browser state, or evidence.
- Disposable live fixture:
  `OC-ISSUE-010-CLAUDE-20260725.txt`.

## Completion record

Implementation is complete and the issue remains in verification for the
unchecked adverse-case matrix and live denial/expiry cases.
Detailed evidence and the deletion inventory are recorded in
`../evidence/010-ai-sdk-structured-agent-chat.md`.

The full workspace build, Python/shell syntax checks, `git diff --check`, and
all 154 automated tests pass. Live browser verification passed structured
OneDrive reads for Claude, Codex, and Hermes, persisted reload, per-agent stop,
persisted cancellation, and post-cancellation recovery without a workspace
restart. The protected Claude upload reached the authoritative
`approval_required` state, received a signed OpenVTC approval, executed once,
and produced the disposable OneDrive file. Because the employee had stopped
the model turn before deciding, Control now reconciles the later operation
result into durable Chat history: stale activity closes as `Work stopped` and
the governed card advances to `Approved action completed`. Protected delete
also passed live: Hermes resolved and deleted `OC-MVP-DENY.txt`, Control held
the exact action for signed approval, and the audit recorded one successful
dispatch. The initial model turn lost continuity because the synchronous
stdio bridge could not answer Hermes keepalive pings while its governed wait
was active. The shared bridge now executes tool calls without blocking its
JSON-RPC input loop, serializes concurrent responses, and allows up to
15 minutes for the enclosing native-agent turn. A regression requires a ping
response while a governed wait is still active. After rollout, a separate
Hermes session called `wait-for-governed-operation` for the completed
operation and persisted the final answer `Authoritative final result:
success=true.` with a completed terminal state.

The final shared-agent regression also passed against the live Microsoft 365
connection: Hermes received the common operating instructions, resolved the
OneDrive drive itself, searched `OC-MVP-DENY.txt` through the shared MCP
bridge's bounded schema, and found exactly one item without asking for
internal IDs or mutating it. The same prompt and bridge are projected to
Claude and Codex. A disposable request routed to the non-vision
`onecomputer-glm` alias was rejected by LiteLLM with
`MODEL_IMAGE_INPUT_UNSUPPORTED` before provider execution; the active
workspace remained on the vision-capable `onecomputer-openai` alias.
