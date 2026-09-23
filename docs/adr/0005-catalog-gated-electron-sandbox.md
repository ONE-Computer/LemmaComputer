# ADR 0005: Catalog-gated Electron sandbox

- Status: accepted
- Date: 2026-08-15

## Context

Chrome, VS Code, and Obsidian need Chromium's process sandbox inside a
workspace container. On AppArmor-enforcing hosts, that needs a narrow
user-namespace exception. The exception applies to the whole container, so
arbitrary downloaded Electron applications must not inherit it merely because
one reviewed application worked.

## Decision

Only exact, release-qualified application catalog entries select the fixed
`lemmacomputer-workspace-electron` AppArmor and seccomp profiles. Firefox-only
workspaces retain the default confinement. Agent clients such as Claude
Desktop and Hermes Desktop require their own exact-version qualification.

The trusted workspace node selects the profile from signed workspace policy;
a process in the workspace cannot opt in. Keep Chromium's own sandbox enabled.
The container still has `no-new-privileges`, bounded resources, dropped
capabilities apart from entrypoint bootstrap needs, isolated storage, and
governed egress. Add only reviewed namespace operations and fail closed if the
required host profile is absent or unusable. Hosted use requires a remote
workspace node.

The fixed profile is a container-level exception, not a guarantee that every
Electron binary will run. User-installed software does not change the catalog
or sandbox profile.

## Application qualification contract

Before adding or upgrading a Chromium or Electron catalog application:

1. Pin and review its build, launcher, desktop entry, and icon.
2. Prove its upstream sandbox remains enabled under the existing profile.
3. Trace any denied syscall and justify the narrowest rule with security
   review and structural tests before changing the profile.
4. Prove launch, file persistence, clipboard policy, egress, restart, stop,
   and removal in a disposable runtime.
5. Prove host preflight and runtime readiness fail closed without the
   required AppArmor and namespace capabilities.
6. Qualify the exact supported placement. Local split-node testing does not
   establish hosted production isolation.

## Consequences

The supported catalog is smaller than a general-purpose desktop. Updating an
application can change its Chromium behavior and requires requalification.
Self-service arbitrary Electron apps would require a different isolation
design, such as per-application confinement.

See [Workspace node deployment](../architecture/workspace-node.md#chromium-and-electron-process-sandbox),
[operations](../guides/operations.md#workspace-node-runtime), and
[extension contracts](../reference/extension-contracts.md).
