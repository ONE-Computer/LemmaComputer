# 009: chat with any policy-selected agent through one owned interface

Status: `cancelled`

Priority: P1
Depends on: 003, 007
Unblocks: provider-neutral agent expansion

## Cancellation record

Cancelled on 2026-07-25 at the user's request and superseded by Issue 010.
The native Hermes, Claude, and Codex adapter work remains a useful verified
implementation baseline, but this issue's flat, final-response Chat UI and
transport are not the product direction. Its unchecked verification cases are
not completion requirements for this cancelled issue; Issue 010 owns the new
structured-streaming verification.

## Outcome

An employee can select any chat-capable agent assigned to a running workspace
and use the same ONEComputer Chat interface, sessions, Microsoft 365
connection, governed tools, and signed approval path without the browser or
Control depending on that agent's private API schema.

## In scope

- Replace Hermes-named chat contracts and Control services with an owned,
  agent-neutral chat runtime contract.
- Keep the qualified Hermes gateway behind a Hermes runtime adapter.
- Add a Claude runtime adapter using the pinned Claude Code binary through the
  Claude Agent SDK.
- Add a Codex runtime adapter using the Codex SDK and a pinned Codex runtime.
- Resolve available chat agents from the signed, workspace-assigned policy and
  let the employee choose between them when more than one is assigned.
- Bind every chat session to one workspace and one agent catalog identity.
- Project each adapter only its own workspace-scoped model and MCP grants.
- Continue to expose Microsoft 365 exclusively through the
  `onecomputer_ms365` stdio MCP bridge and external Control approval boundary.

## Out of scope

- A general cross-agent memory format, automatic handoffs between providers,
  migrating private vendor transcripts between agents, rich tool-call
  rendering, voice, attachments, or changing the Microsoft 365 tool surface.
- Anthropic Managed Agents, OpenAI-hosted Codex cloud tasks, public agent API
  ports, direct model-provider credentials inside the workspace, or treating
  an SDK permission callback as ONEComputer approval authority.
- Weakening connector policy, signed approval, egress, sandbox, tenant,
  workspace, or agent isolation to accommodate an SDK.

## Required implementation

- Define canonical chat agent, availability, session, message, and send schemas
  in owned contracts. Vendor identifiers and payloads must not cross the
  Control API boundary.
- Define a `ChatRuntimeAdapter` boundary with health, session list/create,
  message list, and send behavior. Select adapters only from the verified
  policy and reject an unassigned or non-chat-capable agent.
- Derive adapter access from tenant, subject, workspace, selected agent, and
  signed policy digest. Do not reuse model, MCP, egress, approval, or provider
  credentials.
- Keep adapter endpoints on the private workspace network with fixed ports and
  fixed owned paths. The browser receives neither adapter credentials nor
  upstream paths.
- Pin and verify the Claude Agent SDK, Codex SDK, and their runtime
  dependencies. Configure both SDKs explicitly rather than inheriting
  user-controlled home configuration.
- Bind session identifiers to the selected adapter. A session created by one
  agent must fail closed when addressed through another agent.
- Preserve the external broker boundary. The existing
  `ONECOMPUTER_OPENAI_API_KEY`, Microsoft tokens, LiteLLM master key, agent
  bridge tokens, and approval signing material must not enter browser state,
  agent transcripts, workspace files, or logs.
- Preserve exact governed-operation behavior. Reads may auto-run only when
  Control policy permits them; protected writes must still pause on the same
  signed OpenVTC approval and execute at most once.
- Present selected-agent names and recovery states dynamically. No user-facing
  Chat copy may assume Hermes, Claude, or Codex.

## Required verification

- [x] Hermes, Claude, and Codex adapters satisfy the same owned contract tests.
- [x] Every assigned chat-capable agent can create/resume a session and return
      a response through the same web routes.
- [x] A multi-agent workspace shows an explicit selector and retains the
      session's bound agent when history is reopened.
- [ ] Unselected agents, cross-agent session reuse, invalid session IDs,
      stopped/replaced workspaces, malformed SDK events, timeouts, and missing
      dependencies fail closed.
- [x] Each live adapter discovers the same assigned `onecomputer_ms365` MCP
      surface without receiving Microsoft credentials.
- [ ] A bounded OneDrive read works through each adapter, while a disposable
      protected create/delete lifecycle requires signed approval and executes
      once after approval.
- [ ] Tenant, user, workspace, policy, session, and agent identities cannot be
      substituted or replayed across adapters.
- [ ] Restart, reconnect, concurrent send, cancellation, operation expiry, and
      approval denial preserve authoritative state.
- [x] Existing model, MCP, egress, policy-integrity, OpenVTC, lifecycle, and UI
      tests continue to pass.
- [ ] Browser storage, responses, screenshots, workspace files, process
      environments, and logs contain no prohibited credential or raw sensitive
      provider payload.

## Evidence required

Include package/runtime pins, adapter contract tests, private listener and
process inspection, assigned/unassigned matrices, cross-agent session probes,
safe live transcripts for all available adapters, shared-MCP discovery, the
signed approval lifecycle, secret scans, full automated tests, production
builds, and desktop/mobile Chat screenshots.

## Stop conditions

- An SDK requires a direct provider or Microsoft credential inside the
  workspace, a public listener, an unbounded proxy, browser-held adapter
  authority, or bypassing ONEComputer Control approval.
- A provider cannot be adapted without exposing vendor payloads as the owned
  public contract.
- Live protected-write proof cannot obtain the enrolled user's signed approval;
  leave that case in `verification` rather than substituting an automatic
  approval.

## Preflight record

- Repository: `git@github.com:ONE-Computer/onecomputer.git`
- Branch: `mike/greenfield-v2`
- Existing dirty files belong to the active Hermes/O365 end-to-end repair and
  are part of this issue's baseline; they must be preserved.
- External systems: the existing local ONEComputer stack, its owner-scoped
  Microsoft 365 connection, the pinned agent distributions, and model routes
  already assigned by Control.
- Credential decision: reuse the existing
  `ONECOMPUTER_OPENAI_API_KEY` only at the current external broker boundary;
  never inspect or copy its plaintext into source or the workspace.
- Destructive fixture: one uniquely named disposable OneDrive item, created
  and deleted only after separate signed approvals.
- Expected files: local V2 plan/index, owned contracts, Control chat service and
  routes, workspace/controller projection, sandbox image/entrypoint and
  adapter service, web Chat UI/API, package pins, and focused tests.

## Completion record

Implementation is complete and the issue is in live verification.

- Control now exposes one owned chat contract and derives a distinct private
  adapter grant for each assigned chat agent.
- The web Chat surface resolves agents dynamically and shows Claude CLI, Codex
  CLI, and Hermes Agent CLI through one selector and one route family.
- The pinned workspace image runs private Claude Agent SDK, Codex SDK, and
  Hermes adapters on separate loopback brokers while projecting the same
  `onecomputer_ms365` MCP policy.
- Claude, Codex, and Hermes each completed a live bounded `list-drives` request
  through the web API and returned one drive. Codex also demonstrated that the
  MCP broker rejects out-of-policy arguments before accepting a corrected
  request.
- A live Claude `upload-file-content` call reached Control and entered
  `approval_required`, proving the browser/agent-neutral path still triggers
  signed OpenVTC consent. Final create and subsequent delete execution remain
  intentionally open until the enrolled user signs each separate operation.
- The production workspace image built successfully, all TypeScript workspace
  builds passed, `git diff --check` passed, and all 148 automated tests passed.
- The only secret-pattern scan hit is the pre-existing fake
  `sk-scoped-workspace-agent-key` test fixture; no provider credential was
  copied from `.env` into source.
