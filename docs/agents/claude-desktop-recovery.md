# Claude Desktop startup and governed effort recovery

Runtime pins: Claude Desktop `1.22209.3`, embedded Claude Code `2.1.215`.
No vendor binary upgrade is required for these fixes.

## Root causes

- `489aa0c` bounded persistent-home initialization and removed recursive
  ownership repair. Claude cache seeding still created intermediate
  `Claude-3p` and `claude-code` directories as root. The profile initializer
  now normalizes only those two directories, including on cache hits. It
  rejects symlinks and does not traverse cached binaries or the workspace home.
- `c1ae88a` dropped container capabilities to the bootstrap minimum. Docker's
  capability-conditional `chroot` seccomp rule consequently stopped covering
  Chromium's namespace-local sandbox. Electron-selected workspaces now allow
  the syscall while retaining kernel capability checks, AppArmor,
  no-new-privileges, and the existing container capability set.
- Virtualization additionally requires the deployment opt-in
  `LEMMACOMPUTER_KASM_LOCAL_KVM_ENABLED=true`. Selecting Claude Desktop does
  not override a disabled deployment flag. The affected local stack had it
  disabled; this was configuration state, not a new selector condition.
- `42948b5` added the governed effort boundary and stripped native
  `thinking`/`output_config` fields without first extracting Desktop's effort
  intent. `9992084` later handled Hermes's `reasoning_effort` spelling, but
  Desktop still sent `output_config.effort` and had no registered adapter.
  Its visible choice therefore produced usage records with no requested or
  resolved effort. Manually supplying `reasoning_effort` instead failed
  closed with `MODEL_REASONING_EFFORT_UNAVAILABLE`.

## Corrected boundary

The broker recognizes Low, Medium, and High from either native spelling as
untrusted intent. Conflicting or unsupported selections fail closed. Control
checks the exact runtime registration, selected organization route, and
organization ceiling before issuing a signed task binding. Normalization still
removes all native thinking controls. The governed route remains the sole
authority that projects provider reasoning parameters.

Desktop and CLI have independent exact-version registrations. Sharing an
embedded engine does not qualify a new Desktop version. Native Desktop has no
Auto effort option; its evidence records that absence explicitly. A resumed
conversation must retain its observed effort and separate concurrent sessions
must preserve independent signed requests.

## Verification

Keep live evidence outside the repository. Record only runtime/source identity,
local conversation and usage-attempt IDs, requested/resolved effort, route
identity, tool and turn outcomes, token counts, latency, and available cost.
Do not retain prompts, responses, tool payloads, credentials, or hidden reasoning
in the qualification artifact. Validate it with `npm run qualify:reasoning-adapter`.

The automated boundary tests cover both native spellings, Low/Medium/High,
conflicting and malformed values, removal of forged thinking fields, concurrent
request isolation, stale runtime pins, route capability intersections, and
organization ceilings. Real Desktop verification additionally needs streamed
responses, a completed function tool at each level, a resumed conversation,
and simultaneous sessions at different levels. UI labels alone are not evidence
that the selected effort reached the provider route.

Local Desktop recovery is not hosted multi-node or release qualification. Use
the dedicated remote-node/Cowork workflow for that separate acceptance boundary.
