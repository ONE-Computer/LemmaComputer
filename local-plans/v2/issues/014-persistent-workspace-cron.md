# 014: add persistent cron to the base Kasm image

Status: `planned`

Priority: P1
Depends on: 013
Unblocks: unattended local sandbox automation

## Outcome

Claude, Codex, Hermes, and ordinary scripts can use a conventional user
crontab inside a disposable-open Kasm workspace. Jobs run while the workspace
container is running, survive container recreation through the persistent home
volume, pause when the workspace is stopped, and disappear when it is deleted.

## Product decisions

- Use the operating system's standard cron implementation as the common local
  scheduling substrate.
- Let agents manage schedules through shell access and `crontab`. Do not build
  a ONEComputer scheduler service, scheduling MCP server, or schedules UI.
- Preserve native agent features. In particular, installing system cron does
  not replace or disable Hermes cron or Claude's session-scoped scheduling.
- State the lifecycle honestly: closing the browser does not stop a running
  workspace, Stop pauses schedules, restart resumes future schedules without
  catch-up, and Delete permanently removes schedule state and output.

## In scope

- Install the pinned Ubuntu/Debian `cron` package in the base Kasm workspace
  image.
- Start and supervise the cron daemon without systemd from the owned workspace
  entrypoint.
- Allow `kasm-user` to create, list, replace, and remove its own crontab
  without root.
- Keep the canonical user crontab below the persistent home directory, for
  example `~/.onecomputer/crontab`, and safely restore it into the runtime
  spool whenever a workspace container is created or restarted.
- Provide a minimal scheduling instruction available to every selected agent:
  use absolute paths, the ONEComputer launchers, persistent scripts and output,
  explicit timezones, bounded runtimes, and non-overlapping execution unless
  the user requests otherwise.
- Ensure non-interactive scheduled agent commands use the existing governed
  launch paths:
  - Claude through `onecomputer-claude -p`;
  - Codex through `onecomputer-codex exec`;
  - Hermes through its supported non-interactive or native cron path.
- Preserve the model-route, proxy, HOME, PATH, locale, timezone, and other
  required non-secret runtime configuration in cron's minimal environment.
- Renew existing deterministic, scoped model-gateway grants for running
  workspaces before expiry so an unattended agent job does not fail merely
  because no browser or Control status request occurred. Stop and Delete still
  revoke the grants.
- Persist schedule scripts, stdout/stderr, and user-requested results beneath
  `~/.onecomputer/`.
- Add daemon readiness, failure reporting, and bounded log rotation.

## Out of scope

- A custom scheduler database, scheduling API, MCP tool, chat-native schedule
  object, calendar UI, schedules dashboard, notification inbox, or
  control-plane job runner.
- Waking or provisioning a stopped workspace to execute a due job.
- Replaying missed runs after downtime, distributed scheduling, exactly-once
  execution, leader election, cross-workspace workflows, or a claim that cron
  provides workflow orchestration.
- External delivery through Telegram, email, Slack, or another channel.
- Replacing Hermes native cron, Claude cloud Routines, Codex desktop scheduled
  tasks, CI schedules, or another vendor-managed scheduler.
- Long-lived customer credentials or provider credentials inside the
  workspace.

## Required implementation

- Add the cron package to the immutable image build and verify its package
  provenance with the rest of the image inventory.
- Start cron as a root-owned, supervised child of the workspace entrypoint.
  Include its liveness in workspace readiness and fail visibly if it exits.
- Retain privilege separation: the daemon may install and execute
  `kasm-user`'s crontab, but scheduled commands run as `kasm-user` and receive
  no added Linux capability, host mount, Docker access, or root path.
- Treat the persistent home copy as canonical because `/var/spool/cron` is
  container-local. Validate ownership, mode, syntax, size, and absence of
  NUL/control corruption before atomically installing it at startup.
- Define one safe update convention so an agent cannot successfully change
  only the ephemeral spool while leaving the persistent copy stale. It may be
  a small `onecomputer-crontab` wrapper around standard `crontab`, but it must
  remain a file-oriented cron helper rather than a new scheduler.
- Seed required environment declarations or launch wrappers explicitly.
  Scheduled jobs must not depend on an interactive shell profile or terminal.
- Use lock-based non-overlap in the documented examples and instruction.
  Bound agent-command runtime and append stdout/stderr to per-job persistent
  logs with rotation limits.
- Add a control-plane renewal loop for scoped grants belonging to running
  workspaces. Reuse the deterministic workspace/agent credential and renew its
  upstream lease; do not project a new secret into the container or turn the
  workspace into a credential-renewal authority.
- Re-evaluate workspace state, ownership, assigned agent, verified policy,
  expiry, limits, and revocation before every renewal. A stopped, deleted, replaced,
  unauthorized, or policy-drifted workspace receives no renewal.
- Ensure daemon restart and crontab restoration are idempotent and cannot
  duplicate a job.
- Record daemon lifecycle, crontab restoration result, job identifier, start,
  completion, exit status, timeout, and grant-renewal state without logging
  prompts, outputs, credentials, environment secrets, or command arguments
  that may contain user content.

## Required verification

- [ ] The base image contains the expected cron package and the daemon becomes
      healthy without systemd.
- [ ] `kasm-user` can install, list, update, and remove a crontab without root,
      while another workspace or user cannot alter it.
- [ ] A harmless script-only minute job runs as `kasm-user`, writes persistent
      output, respects timezone, and does not overlap a prior execution.
- [ ] Claude and Codex can independently create valid persistent schedules
      using shell access and the documented cron convention.
- [ ] A scheduled Claude, Codex, and Hermes inference can run after the
      original eight-hour model grant TTL because the control plane renewed
      the same scoped grant without injecting a new secret.
- [ ] A foreign, stopped, deleted, expired, revoked, wrong-agent,
      wrong-policy, wrong-workspace, or wrong-tenant grant is not renewed and
      cannot complete an inference.
- [ ] Closing the Kasm browser leaves jobs running while the container remains
      active; Stop prevents execution; restart restores only future runs;
      Delete purges crontab, scripts, logs, and output.
- [ ] Container recreation, cron restart, Control restart, renewal-loop
      restart, concurrent crontab update, malformed persistent input, full
      disk, job timeout, and agent failure have bounded, observable behavior
      without duplicate catch-up runs.
- [ ] Hermes native cron and Claude session scheduling remain usable and are
      not redirected into or disabled by system cron.
- [ ] Process, filesystem, image, environment, log, and evidence inspection
      finds no added privilege, host authority, customer credential, model
      credential, prompt, or unrestricted output.

## Evidence required

Include the image/package pin and inventory, daemon supervision and readiness
inspection, canonical crontab format and permissions, update/restore tests,
script-only and per-agent scheduled-run probes, timezone and non-overlap
results, grant-renewal/revocation matrix, stop/restart/delete lifecycle proof,
failure and concurrency tests, privilege/process inspection, persistent-volume
inspection, and redacted logs.

## Stop conditions

- Cron requires systemd, a privileged container, a host mount, Docker access,
  an added Linux capability, or execution of user jobs as root.
- Persistence depends only on `/var/spool/cron` or another path outside the
  workspace home volume.
- Unattended inference requires extending a reusable credential indefinitely,
  exposing renewal authority inside the workspace, or skipping policy,
  ownership, limits, expiry, or revocation checks.
- Product requirements expand to waking stopped workspaces, external
  delivery, workflow orchestration, or exactly-once execution without a
  separate architecture issue.

## Completion record

Not complete.
