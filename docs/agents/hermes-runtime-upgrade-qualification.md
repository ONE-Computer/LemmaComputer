# Hermes 0.21.3 / Desktop 0.17.2 qualification candidate

The first live candidate failed qualification on the user-authorized local 4174
stack. The regression fixes below are under requalification. The exact new pins
remain in `discovery` until the complete live gates pass; earlier qualified pins
retain their original registrations.

## Source and installation

- Upstream: NousResearch/hermes-agent tag `v2026.9.14`.
- Commit: `345cd2b057a452236de401d3534b8502a7465e8d`.
- Archive SHA-256: `47df72ebd3f9c96d806a94541163f7fe7d7ce5b84f85c1d3787e6dfeea1d7834`.
- CLI `0.21.3`, Desktop `0.17.2`, Hermes Python `3.13.15`.
- Hermes uses the standalone Python build `20260901`, archive SHA-256
  `8a689a077337bea6d1c4bc0b7df1d52fcaa28f5f67e50df8bf417c1e3f9d8874`,
  with embedded SQLite `3.53.1`. The build and installed-runtime qualifier
  reject a SQLite version affected by the WAL-reset corruption bug.
- The older `3.13.5` environment remains for Office and the separate agent-chat
  SDK; this qualification does not upgrade those other runtimes.
- Upstream now refuses non-editable wheel installation. Use its frozen editable
  source installation under the root-owned image path; employees cannot edit it.
- Enable upstream's locked MCP extra (`mcp==2.0.0`, `httpx2==2.7.0`,
  `starlette==1.3.1`); keep the browser-chat SDK environment separate.
- API-server aiohttp is pinned to upstream's `3.14.3` with matching dependencies.

## Smaller integration boundary

`lemmacomputer_hermes_mcp_identity.py` now owns an immutable turn context. The
API patch parses the paired binding/identity headers, carries that context
explicitly into the worker thread, and copies it into `request_overrides` AFTER
runtime selection. No upstream session-context module changes are required.
Partial header pairs fail instead of falling back to native intent. Control
still validates signatures and authorizes routes; no shared broker change.

The MCP patch captures identity before scheduling on the shared event loop and
passes it explicitly through retries into the SDK's `meta` field. Tool argument
schemas and the shared connector bridge are unchanged. Native processes retain
their launcher's identity; explicit API contexts cannot inherit it accidentally.

The Desktop patch filters the shared model-picker/composer component. The SSE
patch retains the failure flag supplied by upstream's tool callback. These
remain small upstream patches, not optional fail-open middleware.

## Reproducible checks

1. `node --import tsx --test tests/hermes-office-runtime.test.ts tests/hermes-profile-config.test.ts tests/workspace-gateway-normalization.test.ts`
2. Using the installed candidate Hermes Python environment:
   `npm run qualify:hermes-runtime`.
   Add `-- --previous-source=/path/to/old/hermes --previous-python=/path/to/old/python`
   for a synthetic transcript upgrade, resumed write, rollback, and integrity
   check. This always creates a temporary home, never opens an existing one.
3. `npm run verify:quick` and `npm run image:workspace`.
4. Credentialed local-stack checks for CLI, Desktop and product Chat, including
   all permitted effort levels, real tools, resume, concurrency, denial,
   hidden-reasoning suppression, usage evidence, and home-data continuity.
5. Commit-bound `npm run qualify:reasoning-adapter -- --evidence=...` records.

The installed-runtime fixture uses the real patched HTTP handlers, executor,
agent-construction boundary, MCP 2 client, and product stdio bridge. That part
mocks model execution. A separate smoke uses the real AIAgent and SDK against
a synthetic streaming HTTP provider, checking every inference request's
governed headers. Neither is credentialed live evidence.

No product database schema or deployment-profile change is intended. Hermes
has its own local session-database evolution: preserve workspace home data and
qualify its upgrade/rollback separately from product PostgreSQL migrations.

## SQLite finding

The initial candidate retained Python `3.13.5` / SQLite `3.49.1`. New Hermes
uses DELETE journaling for a fresh database on vulnerable SQLite, but preserves
WAL on an existing database to avoid changing it under concurrent openers.
Therefore that mitigation does not fix existing homes. Python `3.13.13` from
the pinned uv catalog also contains vulnerable SQLite `3.50.4`; simply asking
uv for its newest Python is insufficient. The separately checksummed Hermes
interpreter above fixes the embedded library without replacing system SQLite
or the interpreter for other agents. See [SQLite's upstream explanation](https://sqlite.org/wal.html#walresetbug).

## Findings for future updates

Keep the shared Control/broker contract. Only the Hermes integration hooks and
its runtime pins changed here. The helper now owns context propagation instead
of patching Hermes' internal session-context implementation. This removes one
upstream modification, but provider plugins cannot replace API ingress,
cross-thread MCP metadata, Desktop controls, or error-event mapping.

Separate runtime packaging remains a follow-up: the current Dockerfile combines
desktop package installation and Hermes installation in one layer. Changing a
Hermes patch therefore repeats unrelated application installation, as observed
in this qualification. A separate versioned Hermes build stage/artifact would
make that layer reusable; it does not require another repository or a rewrite
of the shared adapter.

## Bounded results, 2026-09-20

- `npm run verify:quick`: 907 passed, 39 skipped by the normal quick suite,
  zero failures. No product persistence change; `verify:db` was not required
  and was not run.
- Focused browser routing/model-administration specs: 13 passed. The final
  discovery-state change was also checked against the Chat routing spec.
- Installed-runtime qualifier: four concurrent/resumed HTTP turns, partial
  identity rejection, failed-tool event mapping, two MCP bridge calls, and a
  real SDK streaming request with governed headers passed.
- Synthetic old/new/old history: Hermes `0.19.0` -> `0.21.3` -> `0.19.0`
  retained the sentinel and resumed writes; integrity checks passed. This is
  basic transcript evidence, not all home-state or disaster-recovery coverage.
- `npm run image:workspace`: passed. Local image
  `lemmacomputer/workspace:dev-1f37aafb9e`, content ID
  `sha256:c8df108d1484e7c8ddcb08cc89b2df2077d7939c666066f9df897e65e760a7f7`.
  The installed-runtime qualifier also passed inside this image with
  `--network none` and only the qualification source mounted read-only.
- Image CLI reports `0.21.3`, Python `3.13.15`; Desktop stamp records the exact
  upstream commit above. Desktop remained running for 20 seconds in a
  disposable container with a ready Xvnc display. This is launch evidence,
  not visual or credentialed Desktop acceptance.
- The credentialed run below temporarily replaced the local application image
  and the default image for new workspaces. Existing workspace containers and
  homes remained on their original image. No provider credentials, `.env`, or
  database volumes were copied or replaced.

## Credentialed local run and rejection, 2026-09-20

The user explicitly authorized the existing `http://localhost:4174` stack and
signed-in main Chrome profile. Candidate source was
`be0f1cee7c547bf0fa53768f18a8612da9a1f850` in `local-stateful-test`, with the same
source tree as qualification commit `2126d1a0512feb6a573d7e1b29209549a4d657b1`.
The workspace image was the exact `c8df108...` content ID above. A new restricted
workspace, **Hermes 0 21 3 Qualification**, held only synthetic arithmetic tests.

| Surface | Observation | Result |
| --- | --- | --- |
| Web Chat Low / Lite | Three admitted calls, Luna, Low requested/resolved, terminal tool and final answer | Passed bounded smoke |
| Web Chat Medium / Balanced | Five admitted calls across initial/resumed turns, Terra, Medium requested/resolved | Passed bounded smoke and resume |
| Web Chat High / Pro | Two admitted calls, Sol, High requested/resolved, terminal tool and final answer | Passed bounded smoke |
| Native CLI Low / Lite | Real terminal result and final answer, Low requested/resolved | Passed bounded smoke |
| Native CLI High / Pro | Real terminal result and final answer, High requested/resolved | Passed bounded smoke |
| Native Desktop | Opened successfully; model menu has Lite/Balanced/Pro; effort menu has Low/Medium/High | Visual controls passed; inference not qualified |
| Web Chat Auto | Failed after Desktop startup terminated its API gateway; no inference admission | Failed availability gate; Auto resolution unproven |

The route mapping was `2db28c83-9d04-48fd-9795-135542162daa`, using the separately
qualified OpenAI Responses effort route. Every admitted Web Chat call carried
`explicit_signed` task-binding provenance and matched its conversation effort.
Provider-call latency samples ranged from 1,763 to 4,746 ms; these are not full
turn latency or comparative effort benchmarks. Ledger units included input,
output, cache reads, and diagnostic provider reasoning/total tokens. Web Chat
costs were estimated, not provider-confirmed; unpriced native auxiliary calls
remain unpriced. Missing units are not treated as zero.

The first Medium prompt used Python `-c`, which correctly encountered a native
approval gate. A resumed arithmetic-only `expr` command completed without
changing approval settings. The pending native approval was not actionable in
Web Chat. Auxiliary title generation and smart-approval requests also returned
HTTP 400; their routing/context propagation needs investigation. Some native
auxiliary usage records have no selected effort, so this run does not establish
that every auxiliary request inherits the conversation selection.

### Blocking lifecycle regression

At 13:49:00 UTC, Desktop's `hermes_cli/web_server.py::_lifespan` called
`_reap_unsupervised_gateway_orphans()`. The new reaper scans gateway processes
but excludes PID/lock records only from the Desktop home. Our API gateway lives
in the separate `.hermes` home and is launched by the container entrypoint,
not systemd. The reaper sent it SIGTERM. Its log records graceful shutdown of
port 8652 immediately after Desktop startup. The next Web Chat turn failed.
The workspace controller subsequently reported `WORKSPACE_HEALTHCHECK_FAILED`
and recreated only the qualification sandbox at access generation 2, preserving
its home volume. There was no container OOM.

The fix should remain Hermes-specific: make cleanup respect verified ownership
of separately managed gateways in other Hermes homes, and add a process-level
regression test that launches CLI/API and Desktop together. Do not weaken the
shared broker, route signing, or workspace health checks. Re-run against a new
immutable image; a runtime-only hot patch would not qualify the release image.

Then qualify auxiliary calls and approval projection, all Desktop effort/tool
turns, Auto resolution, simultaneous different-effort conversations, stale
route/policy denial, and hidden-reasoning suppression across retained surfaces.
These gates remain unpassed. No passing strict qualification record was
produced; the evidence validator was not run on an incomplete record.

Bounded, credential-free observations were saved outside version control at
`/tmp/hermes-live-qualification-20260920.json` and retained in the task's ignored
`.artifacts/hermes-qualification-20260920/` directory. They contain IDs, usage,
and terminal states, not prompts, responses, tool payloads, or signed bindings.

The candidate promotions were removed after this failure. No main merge,
remote push, release tag, or demo deployment is part of this qualification.

## Rollback verified

The local stack source was restored to its original tree through explicit
revert commits (final local commit `7781e66866987e825c55f3c65a54c61c96b92432`).
Its original Control image `sha256:cb001d593ac88c7ac0bf667f9a9be846433349c7e4e3e36a19f19da524c588a7`
and workspace image `sha256:da90f915fa05df4f2a920afa695a363ef3a53169564f0dc94ec2bc85a27c1659`
were restored with `docker compose up -d --no-build --wait --wait-timeout 300`.
All 14 services became healthy. Existing sandbox/egress containers and both
PostgreSQL containers retained their IDs, start times and volume identities;
the local `.env` hash is unchanged.

The new qualification sandbox was stopped and normal workspace recovery
recreated it using the original workspace image, retaining the same home
volume. No candidate runtime remains deployed in that sandbox. The synthetic
chat records and test home remain available for inspection. The main Chrome
session had returned to the sign-in page before the final Auto retry, so no
successful Auto result is claimed.

After reverting the candidate registrations to discovery, `npm run verify:quick`
passed again: 907 passed, 39 normal quick-suite skips, zero failures. The first
sandboxed invocation could not open the test runner IPC socket; the permitted
rerun completed. This branch is a rejected qualification candidate with a
recorded follow-up plan, not a completed Hermes upgrade eligible for release.

## Regression fixes under requalification

- Scope the upstream orphan reaper to the candidate process's actual Linux
  `HERMES_HOME` (or `HOME/.hermes` when absent). It does not signal a process
  with another home or unreadable ownership. This leaves the container-managed
  API gateway outside Desktop's cleanup ownership without disabling cleanup
  for Desktop's own home or weakening workspace health checks.
- Copy the calling context into background title threads. Inject the immutable
  per-turn binding and agent identity at the shared auxiliary wire seam,
  covering sync/async, streaming and retries without modifying cached SDK
  clients. A governed auxiliary request cannot forward those headers outside
  the fixed loopback broker endpoints. Native side tasks still request their
  own effort semantics; Control remains their authorization authority.
- If the native safety gate needs a human decision in Product Chat, return a
  definite blocked tool result explaining that native approval is unavailable.
  Do not manufacture an approval, leave an unanswerable pending action, change
  approval settings, or interfere with Control's separate signed approvals.

New reproducible checks are part of `qualify:hermes-runtime`:

- `tests/hermes-lifecycle-smoke.py` runs a real API gateway and starts/stops the
  real Desktop backend twice in separate disposable homes; API health survives
  every transition.
- `tests/hermes-auxiliary-smoke.py` makes six real SDK requests to a synthetic
  broker from concurrent Lite/Pro contexts, including async calls and real
  background title threads. It verifies route/header isolation, no retained
  signed bindings, and fail-closed native approval behavior in Web Chat.
- `tests/hermes-turn-context.py` covers known/unknown process ownership and
  rejects auxiliary context forwarding to other destinations.

All installed-source checks above passed. `npm run verify:quick` passed with
907 passed, 39 normal skips, zero failures. The rebuilt image and credentialed
live requalification are still required; these fixture results do not promote
any runtime registration.

Native main-model requests also now attach their registered process identity at
Hermes' final Chat Completions kwargs seam. This survives model switching and
avoids relying on the broker's single-active-process inference when CLI
sessions overlap. The helper still replaces reserved headers with the current
API turn context when present. The real AIAgent HTTP smoke verifies both API
binding transport and native identity without caller-supplied overrides.
This additional patch is installed after dependency layers, allowing its
rebuild to reuse the desktop/runtime installation.
