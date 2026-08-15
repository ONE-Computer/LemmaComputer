# ADR 0005: Catalog-gated Electron sandbox profiles

- Status: Accepted
- Date: 2026-08-15

## Context

LemmaComputer workspaces run untrusted user activity inside a container with
`no-new-privileges`, dropped capabilities, a seccomp allowlist, an AppArmor
profile, bounded resources, isolated storage, and governed network egress.
Applications based on Chromium, including Google Chrome, Visual Studio Code,
and Obsidian, expect Chromium's own process sandbox to remain enabled. On an
AppArmor-enforcing Linux host that sandbox needs permission to create an
unprivileged user namespace and a small set of namespace-related system calls.

Disabling Chromium's sandbox makes the applications start, but removes a
defence-in-depth boundary between renderer or extension code and the main
application process. Making the workspace privileged, adding broad
capabilities, or using unconfined AppArmor or seccomp would weaken the whole
workspace boundary. None of those options is acceptable.

The smallest working host exception is nevertheless meaningful. AppArmor is
attached to the container, not to one executable, so the `userns` permission is
available to every process in a workspace using the Electron profile. The
seccomp additions are argument-filtered, but they still expose more kernel
namespace functionality than the default workspace profile. Arbitrary Electron
packages also introduce unreviewed launchers, bundled Chromium versions,
extensions, update behavior, native modules, and helper processes. Their
runtime behavior cannot be inferred safely from the fact that another Electron
application passed qualification.

Allowing a member to install any Electron application and automatically receive
the broader profile would therefore turn a narrow, reviewed exception into an
open-ended execution class. It would also bypass the organization application
catalog and make the effective runtime depend on mutable software inside a
persistent home volume.

## Decision

Electron-capable sandboxing is a release-qualified, catalog-gated capability.
It is not a general permission for arbitrary user-installed applications.

The Phase 0.5 application catalog contains Firefox ESR, Google Chrome, Visual
Studio Code, and Obsidian. Only the exact catalog identifiers for Google Chrome,
Visual Studio Code, and Obsidian cause the workspace node to apply the fixed
`lemmacomputer-workspace-electron` AppArmor profile and its associated pinned
seccomp profile. Firefox-only workspaces retain Docker's default AppArmor and
seccomp confinement.

This AppArmor profile is a node-selected confinement detail, not a workspace
type that a member can select directly. Governed agent clients such as Claude
Desktop and Hermes Desktop remain in the separate agent catalog and require
their own runtime-specific qualification; their use of Electron does not make
them, or another downloaded binary, inherit this application qualification.

The Electron profile:

- retains Chromium's upstream sandbox; launchers must not use `--no-sandbox`;
- retains `no-new-privileges`, a complete default capability drop with only
  the entrypoint's `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, and `SETUID`
  bootstrap requirements restored, PID and memory limits,
  workspace network isolation, governed egress, and persistent-volume
  boundaries;
- adds AppArmor `userns` permission to the Docker default policy shape;
- adds only argument-filtered `clone` and `unshare` rules involving
  `CLONE_NEWUSER`, plus a `clone` rule whose namespace-flag mask requires
  `CLONE_NEWPID` and no other namespace flag for the transition Chromium uses
  after entering its user namespace;
- leaves `clone3` on the pinned Moby `ENOSYS` fallback and denies unrelated
  namespace combinations; and
- does not include Cowork's `AF_VSOCK` exception unless Claude Cowork is also
  selected.

The profile is selected from the signed workspace configuration by the trusted
workspace node. A process inside the workspace cannot opt itself into the
profile. The node must fail closed when the profile is required but absent,
disabled, mislabeled, or unable to create an unprivileged namespace. Hosted
deployments may use it only on a remote-isolated workspace node.

Installing or downloading other applications inside a workspace does not make
them supported catalog applications and does not change the sandbox profile.
LemmaComputer does not promise that an arbitrary Electron binary will run. A
future application must be added through the catalog and release process before
an administrator can assign it.

## Application qualification contract

Adding an Electron or Chromium application requires evidence for the exact
pinned build and launcher:

1. Add a stable application identifier, pinned source/version, desktop entry,
   and reviewed icon to the workspace image and catalog.
2. Prove the application starts with its upstream sandbox enabled under the
   existing fixed profile. Do not widen the profile merely because the first
   launch fails.
3. Trace any new denied system call or namespace transition and justify the
   narrowest argument-filtered rule. A new exception requires security review
   and updated structural tests.
4. Prove renderer/workbench startup, file persistence, clipboard policy,
   governed egress, restart, stop, and removal behavior in a disposable runtime.
5. Prove the host preflight and runtime readiness probes fail closed when the
   required AppArmor or namespace capability is unavailable.
6. Run the live workspace qualification on every supported placement. Local
   split-node testing does not qualify hosted production isolation.

An application that has not completed this contract remains absent or marked
unavailable in the product catalog. Similar technology or vendor ownership is
not qualification evidence.

## Consequences

Members receive a smaller application catalog than a general-purpose Linux
desktop, and some downloaded Electron applications may not launch. This is an
intentional product security boundary, not an installation defect.

The trusted catalog, image pin, launcher, sandbox profile, and qualification
evidence must move together. Updating an application can change its Chromium
sandbox behavior and therefore requires regression qualification before the
new image is released.

The current profile is container-scoped. If LemmaComputer later needs safe
self-service installation of arbitrary desktop software, it requires a new
isolation design—such as per-application containers or launchers with distinct
confinement—not a broader version of this profile.

## Rejected alternatives

- **Disable Chromium's sandbox.** Rejected because renderer or extension
  compromise would lose Chromium's process isolation.
- **Run the workspace privileged or unconfined.** Rejected because it exposes
  substantially more host attack surface than the applications require.
- **Allow the namespace operations unconditionally.** Rejected because the
  known applications need only specific flag combinations and `clone3` can
  retain Moby's safer fallback behavior.
- **Enable the Electron profile for every workspace.** Rejected because
  Firefox-only workspaces do not need the additional user-namespace surface.
- **Enable the profile for any user-installed Electron binary.** Rejected
  because the exception is container-wide and the binary, helpers, update
  channel, and native modules would be unqualified and mutable.

## Related documentation

- [Workspace node deployment](../architecture/workspace-node.md#chromium-and-electron-process-sandbox)
- [Workspace node runtime operations](../guides/operations.md#workspace-node-runtime)
- [Component extension contracts](../guides/extending.md)
