# ONEVibe-MonoRepo

ONEVibe-MonoRepo is the **Cowork experience** implemented inside this
ONEComputer monorepo. It is not a standalone deployment, a sibling runtime, or
a second authority plane. ONEComputer remains authoritative for identity,
policy, Computer workspace lifecycle, Cowork session lifecycle, model routing,
audit, artifacts, and approvals.

This document is the migration entry point for work that brings ONEVibe product
capabilities into the monorepo. It deliberately does not replace the security
architecture or local-deployment runbook:

- [Architecture and trust model](architecture.md) remains the source of truth
  for security boundaries and ownership.
- [Local deployment](local-deployment.md) remains the source of truth for
  prerequisites, environment configuration, and boot commands.
- [Extending ONEComputer](extending.md) remains the source of truth for adding
  contracts, agents, sandbox providers, and migrations.

## Product boundary

ONEComputer has two product modes sharing one governed backend:

- **Computer** is the workspace-centric experience: users configure, launch,
  and work in their governed computer.
- **Cowork (ONEVibe)** is the task-centric experience: users direct agents,
  observe execution, inspect artifacts, and resume a bounded ephemeral session.
  It is not a Kasm workspace and does not require a Computer workspace.

Neither mode may bypass the Control API, signed policy projection, scoped
credentials, OpenVTC approval path, or artifact ownership checks. The legacy
standalone ONEVibe repository is reference material only; do not import its
database, authentication, secrets, or infrastructure assumptions.

## Current vertical-slice target

The first supported ONEVibe-MonoRepo journey is intentionally narrow but
end-to-end:

1. an authenticated user creates an owned Cowork session and submits a task;
2. the task is dispatched through the governed agent/harness path;
3. task activity is emitted as durable, ordered events;
4. an editable PowerPoint artifact is generated and stored with tenant,
   subject, session, task, and policy ownership plus an integrity digest;
5. the user can retrieve only their own artifact; and
6. the Cowork UI renders activity, visual execution evidence, and the artifact
   download/preview.

The current compatibility task/evidence endpoints are
`/v1/workspaces/:workspaceId/onevibe/tasks`,
`/v1/workspaces/:workspaceId/onevibe/tasks/:taskId/events`, and
`/v1/workspaces/:workspaceId/onevibe/tasks/:taskId/presentations`. The
artifact helper lives at `apps/control-api/src/onevibe-artifacts.ts`. These
are implementation details retained during the session-store migration, not a
reason to provision or expose a workspace for Cowork. The target session
contract is defined in [COWORK_E2B_ACP_PLAN.md](COWORK_E2B_ACP_PLAN.md).

## VCR definition

VCR is **not** a replay of model tokens. It is an authorized execution timeline
that synchronizes task events with visual evidence from the selected application
(for example browser, document editor, or desktop). Each frame or
trace reference must be bound to tenant, subject, session, task, source
application, timestamp, and event sequence. Access must be checked on every
retrieval. Sensitive visual evidence needs explicit retention and redaction
policy before it can be considered production-ready.

The initial implementation accepts bounded PNG or JPEG screenshots from a
policy-bound capture sidecar and exposes them at the task VCR endpoint. A
capture grant is short-lived and bound to one tenant, subject, workspace, task,
source application, and byte limit; it is never issued to the browser. The
provider-specific capture remains behind an adapter. Chat-only animation,
fabricated screenshots, or fixture events are not production VCR evidence.

## Delivery sequence and proof

Implement and verify in this order:

1. API contract and ownership/integrity tests for the artifact flow.
2. Governed runtime/harness dispatch with durable task-event replay.
3. Visual-capture adapter and timeline authorization tests.
4. Browser E2E: submit task, observe streaming activity and VCR, scrub visual
   evidence, retrieve a real PPTX, and validate the downloaded Office package.

Do not claim the slice complete from unit tests alone. Completion requires an
API E2E run and a browser E2E run against the same local stack, with a real
PPTX file and non-simulated VCR evidence.

## Documentation rules

To avoid renewed ambiguity:

- Put durable security or service ownership changes in the existing
  architecture/service documents in the same change.
- Put a new operator prerequisite or command in `local-deployment.md` and, if
  relevant, `operations.md`.
- Put an extension checklist in `extending.md`, not in ad-hoc plans.
- Keep this page limited to ONEVibe-MonoRepo scope, migration boundary, and
  acceptance criteria. Do not duplicate the full runbook here.
- Archive one-off investigation notes outside the monorepo or link them from a
  dated issue/PR; do not add competing master-plan Markdown files.
