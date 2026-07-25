# 012: add an agent-agnostic channel broker with Telegram as the first adapter

Status: `verification`

Priority: P1
Depends on: 002, 003, 010
Unblocks: managed external messaging channels without placing channel credentials in a workspace

## Outcome

An employee can connect one private Telegram bot to each ONEComputer workspace
and use it to converse with any supported, policy-selected agent through the
same agent-neutral chat contract used by ONEComputer Web.

ONEComputer owns a small encrypted channel-credential store and a trusted
channel broker outside the workspace. The broker, not Hermes, Claude, Codex, or
the sandbox, holds the Telegram token and talks to Telegram. It resolves every
incoming sender to an authorized tenant, employee, workspace, agent, and
conversation before forwarding a normalized message to Control.

Telegram is the first official channel adapter. The broker core is independent
of both Telegram and the selected agent so later official adapters can reuse
the same routing, authorization, session, audit, and delivery boundaries.

## Product decisions

- Build the narrow credential vault and broker in ONEComputer. Do not add
  OneCLI or another general credential-injection control plane for this bounded
  requirement.
- Continue to keep Microsoft 365 and MCP credentials in LiteLLM. A channel
  token is not an MCP credential and never grants Microsoft authority.
- Treat the broker as trusted ONEComputer middleware outside the untrusted
  workspace. It reaches agents only through Control's authenticated,
  agent-neutral chat boundary.
- Telegram must not connect directly to Hermes, Claude CLI, Codex CLI, or a
  process inside the workspace. Do not project the bot token through an
  environment variable, file, launch argument, agent configuration, tool
  result, prompt, or model context.
- Workspace configuration owns channel attachment and routing. Enforce one
  connection per workspace and adapter, and one active workspace attachment per
  credential. A durable workspace binding survives sandbox restart.
- Settings owns a typed, write-only Credentials inventory for creation,
  rotation, status, and deletion. It is not a general environment-variable or
  arbitrary secret-injection vault and never displays a stored token.
- A connection is bound server-side to the authenticated tenant, employee, and
  workspace. An inbound Telegram message cannot choose arbitrary tenant,
  subject, workspace, grant, agent, or session identifiers.
- The same Telegram connection may target Hermes, Claude CLI, or Codex CLI
  when that agent is assigned, healthy, and allowed by the workspace's signed
  policy.
- Keep a separate conversation session per channel connection, sender,
  workspace, and agent. Switching agents must be explicit and authorized; do
  not silently feed one agent's history to another.
- Initially support a pinned default agent plus an explicit agent-switch
  command or UI action. The broker must reject an unavailable or unauthorized
  target rather than falling back to another agent.
- Telegram is a conversation transport, not an approval authority. Protected
  actions continue through ONEComputer's existing policy and OpenVTC approval
  path. Telegram may show a content-bounded status or a link to the owned
  approval UI but cannot approve, deny, sign, or bypass a protected action.
- Attaching an external channel creates an intentional data-export path.
  Enterprise policy must be able to disable it or allow it only for specific
  workspaces, users, agents, and content classes. Exact destination egress
  alone is not a sufficient data-loss control.
- Support only reviewed, first-party channel adapters. Arbitrary user-installed
  channel code, arbitrary webhook destinations, and general HTTP credential
  injection require a separate product and threat-model decision.
- Make a clean implementation. The discarded Hermes-specific Telegram path,
  schema, environment injection, and UI are not a compatibility target, and
  disposable development connection data need not be migrated.

## In scope

- A channel-broker service deployed on ONEComputer's trusted control plane,
  outside every workspace network and agent process.
- A typed, versioned internal channel envelope for normalized inbound messages,
  outbound text, bounded attachments, delivery status, and correlation data.
- A typed adapter interface that isolates Telegram-specific polling or webhook,
  sender identity, message formatting, rate-limit, and delivery behavior from
  broker routing.
- A Telegram adapter using either long polling or a verified webhook, with the
  choice and its operational consequences recorded before implementation.
- An encrypted, tenant- and owner-scoped connection store for bot credentials,
  allowed external sender IDs, workspace binding, routing mode, token version,
  lifecycle state, and timestamps.
- Production key wrapping through the project's approved runtime secret or KMS
  boundary. A plaintext database value or an application-wide static key
  embedded in source, image, or workspace configuration is not acceptable.
- Write-only create, update, rotate, revoke, status, and connectivity-test
  APIs. Read APIs return metadata and state only.
- Workspace Channels UI for Telegram attachment, sender allowlisting,
  default-agent selection, explicit agent switching policy, and disconnect,
  plus a Settings Credentials UI for typed creation, rotation, status, and
  deletion.
- Server-side routing from a verified external sender to one authorized
  workspace, agent, and independent channel session.
- Reuse of Issue 010's agent-neutral structured chat interface for Hermes,
  Claude CLI, and Codex CLI. Channel-specific code must not import or call an
  individual agent adapter.
- Translation of structured agent output into Telegram-safe text, bounded
  files, progress, errors, and protected-action notices without exposing
  internal events or credentials.
- Delivery idempotency, retry, ordering, deduplication, replay defense,
  backpressure, rate limiting, bounded media handling, and recovery after
  broker or Control restart.
- Auditable connection lifecycle, routing decisions, denied sender attempts,
  agent switches, inbound/outbound message metadata, and delivery outcomes
  without raw credentials or unrestricted message bodies.
- An administrator policy surface that can deny channel creation or constrain
  it by tenant, employee, workspace, agent, adapter, sender allowlist, and
  permitted outbound data behavior.

## Out of scope

- OneCLI, a general secrets platform, transparent proxy credential injection,
  certificate-authority management, or arbitrary outbound HTTP credentials.
- Moving Microsoft 365, model-provider, or MCP credentials out of LiteLLM.
- Direct Telegram support inside Hermes, Claude, Codex, or a workspace image.
- Exposing an agent's native messaging plugin, Telegram toolset, webhook
  listener, or vendor-specific session API to the public internet.
- Slack, WhatsApp, Teams, email, or user-defined adapters in this issue.
- Arbitrary third-party adapter installation or execution.
- Using Telegram identity as ONEComputer authentication or accepting Telegram
  usernames, display names, phone numbers, or message claims as authorization.
- Completing OpenVTC approvals inside Telegram.
- Full data-loss prevention, content classification, malware scanning, or
  unrestricted large-file relay. If enterprise policy requires these for
  external messaging, stop and split the required enforcement into a
  prerequisite issue.
- Cross-workspace group chats, multi-user shared conversations, autonomous
  proactive messaging, or broadcast campaigns.
- Preservation or migration of the discarded development-only Telegram
  connection schema or token values.

## Required implementation

- Define a `ChannelConnection` bound to tenant, owner, workspace, adapter,
  encrypted credential version, allowed external principals, routing policy,
  lifecycle state, and timestamps. Enforce ownership in every database query,
  not only in request handlers.
- Define a `ChannelRoute` resolved exclusively by the broker from the stored
  connection and verified external sender. Ignore or reject externally supplied
  internal identifiers.
- Define a `ChannelSession` key that includes connection, sender, workspace,
  and agent. Preserve per-agent history isolation across every switch,
  reconnect, and restart.
- Define a versioned `ChannelEnvelope` with an immutable adapter message ID,
  connection ID, external sender ID, normalized content, bounded attachment
  descriptors, receive time, correlation ID, and deduplication key. It contains
  no channel credential or reusable Control authority.
- Give the broker a narrow service identity accepted only by channel-specific
  Control routes. Bind each short-lived grant to the resolved connection,
  workspace, agent, sender, session, audience, expiry, and allowed chat
  operation.
- Before forwarding a message, re-evaluate connection state, sender allowlist,
  workspace ownership and state, assigned agents, signed effective policy, and
  enterprise channel policy. Fail closed on any missing, stale, or ambiguous
  binding.
- Route normalized input through the existing agent-neutral chat service.
  Selecting Hermes, Claude, or Codex is data in the authorized route, not a
  branch in the Telegram adapter.
- Make an explicit agent switch atomic: validate the target, close or suspend
  the old route, select the target's independent session, and record the
  transition before accepting subsequent messages.
- Encrypt each bot token with authenticated encryption and connection-specific
  additional authenticated data. Store a key/version reference separately
  from ciphertext so credentials can rotate without compatibility ambiguity.
- Keep decrypted tokens only in broker memory for the shortest practical
  period. Never return them through an API, serialize them into a job or event,
  or pass them to Control, an agent adapter, a workspace, a browser after
  submission, or an observability system.
- Implement token replacement as a versioned rotation. New delivery work uses
  only the committed version; revoke the old token and cached material without
  requiring a workspace restart.
- Verify Telegram API responses and webhook authenticity where applicable.
  Enforce the exact Bot API destination at the broker's external network
  boundary; the workspace does not need Telegram egress.
- Allow only numeric Telegram user IDs recorded during setup. A bot receiving a
  message from any other sender responds with no sensitive state and forwards
  nothing to Control.
- Define message-size, attachment-count, MIME-type, download-size, processing
  time, queue-depth, and outbound-length limits. Reject or truncate according
  to an explicit, tested contract.
- Deduplicate Telegram updates across retry and restart using durable adapter
  update IDs. Make outbound retries idempotent where the upstream API permits,
  and otherwise expose possible duplicate delivery honestly.
- Map structured chat output through a channel renderer. Do not relay hidden
  reasoning, internal tool arguments, raw MCP responses, reusable URLs,
  credentials, policy documents, stack traces, or unbounded source content.
- Represent protected actions as a bounded notice with their current state.
  Any approval link must be short-lived, audience-bound, non-authoritative, and
  safe to expose through Telegram.
- Add explicit disconnect behavior: stop polling or reject webhook delivery,
  invalidate the connection grant, erase cached plaintext, revoke the stored
  credential, close queued work, and prevent further agent messages before
  reporting disconnected.
- Redact token-shaped values and external message content from default logs.
  Audit immutable identifiers, hashes where justified, states, policy
  decisions, and delivery codes instead.

## Required verification

- [ ] One allowlisted Telegram user can connect a dedicated bot and exchange a
      multi-turn conversation with each of Hermes, Claude CLI, and Codex CLI
      through the same broker and agent-neutral Control contract.
- [ ] Agent switching is explicit, policy checked, auditable, and preserves
      independent history for each agent. No prior agent receives subsequent
      messages, and no new agent receives the prior agent's context.
- [ ] The bot token is absent from workspace environment, files, process
      arguments, labels, image layers, agent configuration, browser responses,
      prompts, model context, queues, events, logs, screenshots, and evidence.
- [ ] Database inspection finds authenticated ciphertext and a key-version
      reference only; ciphertext copied between tenant, owner, connection, or
      purpose bindings fails to decrypt.
- [ ] A foreign tenant, employee, workspace, Telegram sender, connection,
      agent, session, or replayed update cannot read status, change routing,
      submit input, receive output, or infer protected state.
- [ ] Telegram usernames, display names, forwarded messages, reply metadata,
      group membership, and caller-supplied workspace or agent IDs never grant
      authorization.
- [ ] A disabled connection, revoked sender, rotated token, stopped workspace,
      unhealthy agent, stale policy, denied enterprise policy, expired grant,
      or unavailable Control fails closed with no fallback agent.
- [ ] Duplicate, delayed, reordered, concurrent, malformed, oversized, and
      replayed inbound updates produce the specified single routing result or a
      bounded rejection across broker restart.
- [ ] Rate limits, Telegram outage, Control outage, agent outage, full queue,
      timeout, partial streaming response, and outbound delivery failure have
      bounded retry and recovery behavior without losing authorization checks.
- [ ] Attachments outside the declared count, type, size, and timeout limits
      are rejected before reaching Control or an agent.
- [ ] A protected Microsoft operation still requires the existing verified
      policy and OpenVTC path. Telegram cannot create approval authority,
      modify the operation, replay a decision, or directly call LiteLLM/MCP.
- [ ] The broker can reach only the exact Telegram API and narrow Control
      routes it requires. The workspace has no Telegram route and cannot reach
      the broker's credential or administration endpoints.
- [ ] Disconnect and token rotation take effect without a workspace restart
      and leave no usable old credential or queued authority.
- [ ] Production builds, full automated tests, live deployed Telegram probes,
      restart tests, tenant-isolation tests, network inspection, database
      inspection, and redacted log inspection pass.

## Evidence required

Include:

- the broker, adapter, credential, routing, session, and trust-boundary diagram;
- the Telegram polling-versus-webhook decision and exact network routes;
- the channel envelope, connection, route, session, service-grant, and
  enterprise-policy contracts;
- proof that Hermes, Claude CLI, and Codex CLI use the same broker and Control
  route with no Telegram-specific agent code;
- redacted create, rotate, disconnect, sender-denial, agent-switch, protected
  action, retry, replay, restart, and outage probes;
- tenant, owner, workspace, sender, agent, and session isolation matrices;
- storage, process, container, image, browser, prompt, queue, event, network,
  and log inspection proving that no bot token reached the workspace or agent;
- token-cache lifetime and erasure observations;
- message and attachment limit probes;
- an O365 data-export threat analysis, the enforced enterprise policy, and the
  exact residual limitation that destination allowlisting cannot determine
  whether an otherwise valid response contains sensitive content; and
- source inspection proving that the discarded Hermes-specific environment
  injection, schema, routes, UI, and tests were not restored.

## Stop conditions

- Issue 010 does not expose a stable agent-neutral message and structured-output
  boundary usable without importing an individual agent adapter.
- Supporting an agent requires placing the Telegram token or Telegram-specific
  code inside that agent or workspace.
- Enterprise requirements demand content classification or DLP that cannot be
  enforced at the broker boundary defined here.
- Telegram identity cannot be mapped to an explicit immutable numeric sender
  allowlist with fail-closed behavior.
- Credential encryption would rely on a plaintext source/image key or a secret
  mounted into the workspace.
- The broker would need broad Control, LiteLLM, Microsoft Graph, database, or
  cross-workspace authority instead of a narrow connection-bound grant.
- Protected actions would need to be approved in Telegram or bypass the
  existing OpenVTC decision boundary.
- Adding another channel would require changing agent adapters or the broker's
  routing core rather than implementing the common adapter contract. Stop and
  correct the abstraction before declaring the first adapter complete.

## Completion record

An initial deployable broker, encrypted typed credential store, agent-neutral
Control route, Telegram polling adapter, workspace Channels UI, and Settings
Credentials inventory are implemented on
`codex/issue-012-channel-broker`. Automated credential-boundary, owner/sender
isolation, per-workspace cardinality, exclusive credential attachment, replay,
routing, build, Compose, and fixture-browser checks pass locally.

The issue remains in `verification`. In addition to a dedicated Telegram bot
token and numeric test-user ID for live Bot API, restart, rotation, disconnect,
outage, and deployed network/log/database inspection, completion still requires
the issue's short-lived connection-bound service grant, externally enforced
exact-destination egress, administrator channel/data-export policy, durable
audit evidence, and the full rate-limit, queue, retry, and attachment-limit
matrix. The current adapter rejects non-text messages and pins its Bot API
origin in code, but those controls are not substitutes for the remaining
requirements. No real Telegram credential was used during implementation.
