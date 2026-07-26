# 013: add a disposable open-sandbox profile

Status: `planned`

Priority: P1
Depends on: 002, 003, 010
Unblocks: 014

## Outcome

An employee can choose a clearly labelled disposable workspace profile for
non-sensitive work. Claude, Codex, and Hermes receive their normal local
shell, filesystem, skill, plugin, browser, and public-web capabilities inside
the Kasm boundary, while the existing managed profile remains restricted and
customer SaaS credentials remain outside the workspace.

## Product decisions

- Add an explicit `disposable-open` execution profile. Do not silently weaken
  the existing managed profile.
- Pair the MVP disposable-open profile with `full-web` egress. Full web means
  arbitrary public HTTP and HTTPS through the existing external egress proxy,
  not direct networking or access to private infrastructure.
- Treat the workspace and everything installed or downloaded inside it as
  untrusted and disposable.
- Keep the container boundary: no Docker socket, host mounts, host authority,
  privileged container, private-network route, or cross-workspace access.
- Keep customer Microsoft 365 and other SaaS credentials outside the
  workspace. Existing scoped ONEComputer loopback grants remain bound to their
  exact workspace, agent, route, audience, policy, expiry, and budget.
- Make the profile agent-neutral. Do not create separate openness switches for
  Claude, Codex, and Hermes.

## In scope

- Add versioned policy contracts equivalent to:
  - `executionMode: managed | disposable-open`
  - `egressMode: restricted | full-web`
- Sign, project, verify, and enforce the selected modes through the existing
  policy-integrity boundary.
- Add a workspace-setup selection and an unambiguous non-sensitive-data
  warning for the disposable-open profile.
- Configure the selected agents consistently:
  - Claude Code can use its native shell, filesystem, subprocess, skill,
    plugin, MCP, browser, and supported web capabilities.
  - Codex uses full filesystem and shell access inside the container,
    `approval_policy = "never"`, and supported web/search capability.
  - Hermes no longer receives a blanket `disabled_toolsets` list and can use
    its normal CLI/API toolsets, including terminal, file, web, browser,
    skills, delegation, code execution, and `cronjob`.
- Apply the same effective mode to the terminal clients and Issue 010's
  Sandbox Chat adapters. The web chat must not silently remain read-only when
  the selected workspace profile is disposable-open.
- Add a full-web compiler path to the Issue 002 proxy/network enforcement:
  arbitrary public HTTP/HTTPS destinations are allowed without a domain
  allowlist, while every connection still traverses the assigned proxy.
- Support ordinary public development traffic including Git hosting, package
  registries, documentation, skill repositories, browser navigation, and
  agent-downloaded user-space tools.
- Preserve stop, restart, and delete semantics: Stop retains the workspace
  home, restart restores it, and Delete purges it.

## Out of scope

- Direct unrestricted networking, raw TCP/UDP internet access, VPNs, alternate
  proxies, tunnels, inbound exposure, TLS interception, or private-network
  access.
- Docker-in-Docker, Docker socket access, host filesystem mounts, added
  capabilities, privileged containers, or VM-grade isolation claims.
- Customer SaaS credential injection, production secrets, sensitive-data
  handling, or a claim that arbitrary downloaded code is trustworthy.
- Removing the managed/restricted profile.
- OpenVTC approval for full-web destinations, per-domain prompts, content
  inspection, malware classification, or a general DLP product.
- A marketplace or ONEComputer-managed update service for agent skills.

## Required implementation

- Replace deny-only schema assumptions with a discriminated, versioned egress
  policy that can represent restricted allowlists and full public-web access
  without collapsing their audit or enforcement semantics.
- Keep the workspace on its internal-only network. The egress sidecar alone
  holds the external route, and all direct routes remain absent.
- In full-web mode, allow only public HTTP/HTTPS destinations and reject
  loopback, link-local, metadata, private, reserved, multicast, documentation,
  benchmark, invalid, and cross-workspace address space for IPv4 and IPv6.
- Revalidate normalized hostname, DNS answers, redirects, CONNECT target,
  destination port, and TLS SNI metadata where available on every new
  connection. Preserve DNS-rebinding, hostile-suffix, raw-IP, alternate-port,
  and proxy-bypass defenses from Issue 002.
- Issue a workspace-bound full-web proxy grant with explicit mode, audience,
  expiry, revocation, and policy digest. A restricted grant cannot be replayed
  as full-web, and a full-web grant cannot be replayed across tenant, user,
  workspace, or agent boundaries.
- Generate agent configuration from the verified execution mode. Remove the
  hard-coded Codex read-only flags and Hermes blanket toolset disablement only
  for disposable-open; retain them for managed workspaces.
- Ensure Claude's strict MCP configuration does not disable its native local
  tools in disposable-open mode. Keep governed MCP routing distinct from
  native shell and filesystem tools.
- Let users and agents install and edit user-space skills, plugins, packages,
  and tools beneath the persistent workspace home. Do not grant root or mutate
  the immutable image at runtime.
- Preserve capability drops, `no-new-privileges`, PID/CPU/memory limits,
  workspace-volume ownership, and complete volume purge on Delete.
- Emit mode, policy version/digest, workspace/agent attribution, normalized
  destination metadata, decision, and reason without credentials, query
  strings, payloads, response bodies, prompts, or downloaded content.

## Required verification

- [ ] Managed Claude, Codex, and Hermes workspaces retain their current
      restricted tool and egress behavior.
- [ ] A disposable-open workspace can be selected with clear non-sensitive and
      deletion guidance, and the signed effective policy reports both modes.
- [ ] Claude, Codex, and Hermes can create and modify user-accessible files,
      execute subprocesses, and install user-space packages and skills.
- [ ] Hermes exposes its normal bundled toolsets including skills and
      `cronjob`; Codex is not forced into read-only mode; Claude native local
      tools remain available.
- [ ] Sandbox Chat and terminal clients enforce the same selected execution
      mode for every agent.
- [ ] Unlisted public HTTP/HTTPS sites, package registries, Git repositories,
      documentation, skill sources, and browser destinations work through the
      full-web proxy without per-domain policy edits.
- [ ] Loopback, metadata/link-local, private/reserved IPv4 and IPv6, host
      gateway, Docker, database, Control administration, another workspace,
      raw-IP, alternate-port, alternate-proxy, direct socket, DNS-rebinding,
      hostile-suffix, redirect, and SNI-mismatch attempts fail.
- [ ] Missing, malformed, expired, revoked, wrong-mode, wrong-policy,
      cross-tenant, cross-user, cross-workspace, cross-agent, and
      wrong-audience grants issue no upstream connection.
- [ ] Proxy, Control, workspace, and agent restart; DNS failure; policy refresh;
      concurrent lifecycle operations; and partial reconciliation recover
      without creating a direct route or changing profiles.
- [ ] Stop preserves and restart restores user-space installations; Delete
      removes the complete workspace volume.
- [ ] Image, container, process, environment, network, browser, and log
      inspection finds no customer SaaS credential, host authority, direct
      provider route, or prohibited content.

## Evidence required

Include the profile and egress-mode contracts, signed policy samples, UI
screenshots, generated configuration for all agents in both modes, egress
compiler output, proxy and route inspection, full public-positive and
private/bypass-negative matrices, identity and mode-replay tests,
restart/reconciliation results, lifecycle storage proof, package/skill
installation probes, and credential/log redaction inspection.

## Stop conditions

- Full web requires a direct workspace route, a privileged container, private
  or host network access, TLS interception, or weakening the Issue 002
  private/reserved destination defenses.
- Managed workspaces inherit disposable-open execution or egress behavior.
- A native agent feature requires customer SaaS or provider credentials to be
  injected into the workspace.
- The UI or policy cannot distinguish the disposable non-sensitive profile
  from the managed profile before provisioning.

## Completion record

Not complete.
