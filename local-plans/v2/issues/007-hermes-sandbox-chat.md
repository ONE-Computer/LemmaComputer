# 007: chat with Hermes inside the assigned sandbox

Status: `verification`

Priority: P1
Depends on: 003
Unblocks: Telegram messaging connection

## Outcome

An employee can open Chat in ONEComputer and converse with the Hermes agent
running inside their assigned Kasm sandbox. Stopping or destroying the sandbox
also stops Hermes and makes Chat honestly unavailable.

## In scope

- Run the pinned Hermes gateway and API server as an unprivileged process inside
  a policy-selected Hermes Kasm sandbox.
- Give Control private, workspace-scoped access to the Hermes API over the
  existing internal workspace network, without publishing a sandbox port.
- Add authenticated, ownership-checked Control routes for health, sessions,
  messages, and sending a message.
- Add a calm employee Chat destination with ready, loading, empty, sending,
  unavailable, stopped, and failed states.
- Keep Hermes CLI, its sessions, MCP configuration, model broker, egress policy,
  and Kasm lifecycle as the same sandbox-owned runtime.

## Out of scope

- OneCLI, a second agent runtime outside Kasm, arbitrary inbound firewall rules,
  a public Hermes API port, Telegram/Slack credential configuration, webhook
  ingress, general connector management, and rebuilding Hermes MCP connectors.
- Response streaming and rich tool-call rendering in this first vertical slice.

## Required implementation

- Derive a dedicated Hermes API credential outside the sandbox from the
  authenticated tenant, subject, workspace, selected agent, and signed policy
  digest. Do not reuse the model, MCP, egress, session, or agent-bridge grant.
- Project that credential only to the selected sandbox runtime and redact it
  from logs. Control must call only the fixed internal sandbox hostname and
  fixed Hermes API port.
- Expose an owned ONEComputer response schema rather than forwarding arbitrary
  paths, headers, or vendor response bodies.
- Fail closed for cross-tenant/user/workspace access, stopped or replaced
  sandboxes, policies without Hermes, invalid session identifiers, timeouts,
  malformed upstream responses, and unavailable dependencies.
- Preserve deny-by-default egress. Hermes MCP/app access continues to require
  explicitly approved HTTPS destinations.

## Required verification

- [ ] A Hermes-selected running sandbox reports Chat ready, creates/resumes a
      session, persists messages, and returns an assistant response.
- [ ] Stopping/deleting the sandbox stops the gateway and Chat reports offline;
      starting it again restores Chat without a public listener.
- [x] Claude-only policies never receive a Hermes API credential or process.
- [x] Cross-tenant/user/workspace requests, arbitrary proxy paths, invalid
      sessions, and direct host/public port probes fail closed.
- [x] The workspace network allows Control to reach only the fixed Hermes API
      endpoint while the browser cannot receive its bearer credential.
- [x] Existing CLI, model, MCP, egress, signed-policy, lifecycle, and UI tests
      continue to pass.
- [x] Logs, browser storage, API responses, screenshots, and evidence contain no
      Hermes API credential or sensitive raw upstream metadata.

## Evidence required

Include the internal network/listener inspection, container process ownership,
positive chat transcript using safe fixtures, stopped/deleted and non-Hermes
states, isolation probes, secret scans, automated tests, production build, and
desktop/mobile Chat screenshots.

## Stop conditions

- Passing requires publishing port 8642, accepting a sandbox-chosen upstream,
  moving agent execution outside Kasm, broadening egress, or sharing a reusable
  platform credential with the browser.
- Hermes cannot run its pinned gateway/API in the same container and lifecycle
  as the selected workspace agent.

## Completion record

Implementation and automated verification are complete; live sandbox recreation
is pending the product owner’s authenticated restart gesture.

- Automated suite: 135/135 passed; all workspace builds passed.
- The pinned workspace image was rebuilt as
  `sha256:a616a655aa234a096cc78129b07ea8b268a86c71f1a8c2c28a39d180edaa8858`.
- Control, controller, and Web were rebuilt and are healthy. Control has the
  dedicated Hermes derivation secret; the current pre-change sandbox still has
  no Hermes API process or published port.
- The desktop and mobile Chat journey, saved-session load, message send, and
  assistant response were browser-verified with safe fixtures and no console
  errors.
- Final live proof requires signing in to ONEComputer and restarting the
  existing Hermes sandbox so Control recreates it from the new image and issues
  its workspace-bound API grant through the normal authenticated lifecycle.
