# 025: add Control-owned agent schedules

Status: `implemented; verification pending`

Priority: P1

## Outcome

An employee can create, edit, pause, resume, run, inspect, and delete a
recurring prompt from the Schedules tab. Every occurrence targets one owned
workspace and one selected chat-capable agent.

This feature is separate from Issue 014 workspace-local cron. Cron syntax is
used only as a recurrence representation; no host or Control-container cron
daemon owns product schedules.

## Product decisions

- Control PostgreSQL is authoritative for schedules and run metadata.
- Saved prompts are application-encrypted with owner-and-schedule-bound
  authenticated encryption.
- A dedicated unprivileged scheduler worker claims due occurrences with
  PostgreSQL row locks and leases.
- Control re-resolves ownership, current policy, selected agent, workspace
  state, and agent health immediately before execution.
- Every occurrence creates a fresh agent chat session.
- Stopped workspaces cause a visible skipped run. Schedules do not wake or
  provision workspaces in this version.
- Downtime does not create catch-up runs. Overlapping occurrences are skipped.
- Once dispatch begins, a lost run is never automatically retried because the
  agent may already have caused an external effect.
- Deleting a workspace cascades to its schedules and run history.

## Runtime path

1. The browser writes a schedule through the authenticated Control API.
2. Control validates the owned workspace and assigned agent, encrypts the
   prompt, calculates the next occurrence in its IANA timezone, and persists it.
3. The scheduler worker selects due schedules with `FOR UPDATE SKIP LOCKED`,
   creates a unique occurrence, advances `next_run_at`, and leases the run.
4. The worker sends only the run ID and lease token to Control over the private
   control network.
5. Control begins the lease, unlocks the prompt, reloads current policy, creates
   a fresh session, and consumes the complete agent event stream.
6. Control stores terminal run metadata and the session ID. Prompt and response
   content stay out of scheduler logs and run rows.

## Lifecycle

- Closing the browser has no effect.
- A running workspace executes future occurrences.
- A stopped workspace records skipped occurrences.
- Pausing retains configuration and history but clears `next_run_at`.
- Resuming computes a new future occurrence; it does not replay missed work.
- Deleting the schedule removes its run history.
- Deleting the workspace removes all attached schedules and run history.

## Verification

- [x] Schedule and run schemas are bounded and owner scoped.
- [x] IANA timezone recurrence covers weekday and DST transitions.
- [x] Prompt ciphertext is owner-and-schedule bound and tamper evident.
- [x] Unique occurrences, row locks, leases, no catch-up, and no-overlap behavior
      are represented in the persistence boundary.
- [x] Scheduled execution revalidates the target and creates a fresh session.
- [x] Worker-to-Control calls contain no prompt.
- [x] TypeScript and production Web builds pass.
- [x] PostgreSQL integration qualification under concurrent worker store clients.
- [ ] Container restart, Control crash, worker crash, and 20-minute unknown
      outcome qualification.
- [ ] Human UI acceptance against a live managed workspace.
