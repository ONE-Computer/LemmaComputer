# Hermes 0.21.3 / Desktop 0.17.2 qualification candidate

The initial lifecycle, request-context, and Desktop effort-menu regressions are
fixed. Installed-image checks and credentialed Web Chat, CLI, Desktop-backend,
and actual Desktop UI smoke tests now pass on the user-authorized 4174 stack.
Live route revocation, complete retained-surface inspection, and strict
commit-bound acceptance records remain incomplete. The exact new pins remain
in `discovery`; earlier qualified pins retain their original registrations.
The final section below records the current deployed state; earlier rollback
sections describe completed historical runs.

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

The user explicitly authorized the existing local 4174 stack and signed-in
main Chrome profile. Candidate source was
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

Bounded, credential-free observations were saved outside version control and
retained in the task's ignored `.artifacts/hermes-qualification-20260920/`
directory. They contain IDs, usage, and terminal states, not prompts, responses,
tool payloads, or signed bindings.

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
907 passed, 39 normal skips, zero failures. The same expanded checks also pass
inside the rebuilt image below with networking disabled. These fixture results
do not promote any runtime registration.

Native main-model requests also now attach their registered process identity at
Hermes' final Chat Completions kwargs seam. This survives model switching and
avoids relying on the broker's single-active-process inference when CLI
sessions overlap. The helper still replaces reserved headers with the current
API turn context when present. The real AIAgent HTTP smoke verifies both API
binding transport and native identity without caller-supplied overrides.
This additional patch is installed after dependency layers, allowing its
rebuild to reuse the desktop/runtime installation.

## Fixed-image live requalification, 2026-09-20

Implementation commits are `60efa873b5df047ca1f1b3cb172058b2e65fb3be` and
`9646541a604ed9e96c9f5f33b285537c4205cf57`. The tested workspace image is
`sha256:87f422def86572e329d0375576d0de1c259fab876e729ff11a2a5756d62239fc`.
The local stack temporarily staged the candidate registrations in `a336232`
and the native identity fix in `291609b`; the Control image was
`sha256:4ab8f2dd70eb8aa5da2b4ab5fd758bfdb5a70cae8c60ab0d4d9625f3ad5d56ba`.
The task branch retains discovery registrations throughout.

The expanded image qualifier passed using the installed Hermes Python and
`docker run --network none`, including real API/Desktop process coexistence,
real SDK auxiliary requests, concurrent API context isolation, actual MCP 2
transport calls, failed tool events, and native model identity. The repository
gate passed again after the final code change: 907 passed, 39 normal skips,
zero failures. No schema, migration, deployment-profile, or shared broker
implementation changed. No Web source changed.

Live tests used only the dedicated synthetic workspace
`aecaaa2e-26b5-4403-bb01-ce907ed1e1e5` on the authorized 4174 stack:

| Check | Observation | Scope |
| --- | --- | --- |
| CLI Low/Lite, Medium/Balanced, High/Pro | Terminal tools and expected answers completed; requested/resolved effort matched | Real provider smoke passed |
| CLI concurrency and resume | Low/High overlapped with distinct registered process identities; Medium resumed the same stored session successfully | Passed bounded smoke |
| Actual Desktop startup alongside API | Electron started its real backend; original API PID 98 stayed alive and healthy throughout all native tests; sandbox did not restart | Original lifecycle blocker fixed in live image |
| Desktop backend Low/Lite and High/Pro | Concurrent JSON-RPC sessions streamed text and completed terminal tools with expected answers | Backend protocol smoke passed; not a UI test |
| Desktop backend Medium/Balanced | Tool returned the correct result, but the first final sentence gave the wrong number; resumed session completed a new tool turn with the expected answer | Route/tool transport and resume passed; initial answer correctness failed |
| Auxiliary calls | Live title requests completed without the earlier HTTP 400; ledger records successful auxiliary admissions | Bounded native auxiliary smoke passed; Web Chat auxiliary live gate still pending |

The Desktop checks used its documented loopback bootstrap and WebSocket
session API. They did not extract browser credentials or bypass application
login. Chrome's existing 4174 tab remained signed out after reload, so this
fixed image has **not** passed actual Desktop UI interactions or Web Chat
Low/Medium/High/Auto, native-approval projection, and resume/concurrency gates.

All 32 recorded provider admissions completed successfully, with zero
requested/resolved effort mismatches. Explicit levels reached the existing
Lite/Luna, Balanced/Terra, and Pro/Sol mapping. Native auxiliary requests may
have no selected effort; they are not counted as explicit-level proofs.
Provider-call latency ranged from 1,152 to 11,932 ms, not full-turn latency or
an effort benchmark. Twenty-three calls were estimated/priced and nine were
unpriced/unknown; none is claimed as provider-confirmed cost.

No raw reasoning callback or final reasoning field was observed in the
corrected Desktop protocol checks. All inspected reasoning-column lengths
were zero across the five new Desktop sessions, including resume. The first
harness incorrectly counted upstream `thinking.delta` spinner/status events
as reasoning; source inspection distinguishes them from `reasoning.delta`.
Upstream also names ordinary assistant-content progress `reasoning.available`.
This bounded observation does not prove suppression across all retained logs,
artifacts, product Activity, or other provider routes.

The CLI harness initially missed the upstream `session_id:` label; extracting
the actual stored ID and resuming it succeeded. Neither harness issue changed
the product. The Medium Desktop answer discrepancy is retained as an observed
model-output failure, not silently converted into a passing accuracy result.
The transcript contains the correct terminal result; routing and tools did not
fail in that turn. The cause of the incorrect final sentence is not established.

Credential-free IDs, usage, terminal states, field-length totals, and
preservation checks are retained in the ignored
`.artifacts/hermes-requalification-20260920/` directory. No signed bindings,
provider credentials, prompts, responses, or raw reasoning were added to the
committed report or bounded JSON evidence.

### Remaining acceptance gates

- Reauthenticate the existing main-Chrome 4174 tab, then run the actual Web
  Chat and native Desktop UI flows against this exact candidate image.
- Verify Web Chat Auto resolution and native-approval failure projection live.
- Complete live stale-route/policy denial without modifying unrelated
  workspaces, and check hidden-reasoning suppression across retained surfaces.
- Produce and validate complete, commit-bound qualification records before
  promoting either pin. Existing fixtures are not substitutes for these gates.

No passing strict evidence record, runtime promotion, merge, push, release tag,
or demo deployment is claimed. This task has fixed and tested the identified
integration regressions; release acceptance remains incomplete.

### Local stack restored after the bounded run

The temporary staging commits were explicitly reverted; local source commit
`9ee82d9398666960119003e4054a37253653cd63` has the exact original baseline tree.
The retained original Control and workspace images from the earlier rollback
were restored with `docker compose up -d --no-build --wait --wait-timeout 300`.
The qualification sandbox recovered on the original workspace image and is
healthy, retaining its existing home volume. The candidate image remains
available under the task worktree's image tag for the next qualification run.

Final inspection confirms unchanged IDs, start times, and volume identities
for all seven pre-existing sandbox/egress containers and both PostgreSQL
containers. The local `.env` hash is unchanged. The qualification workspace's
synthetic records and home were retained. `npm run verify:quick` passed on the
final task source/report with 907 passed, 39 normal skips, zero failures.


## Main-Chrome UI requalification and login usability, 2026-09-20

The user reauthenticated main Chrome and authorized fixing regressions. This
run reused only the dedicated qualification workspace and the existing local
provider configuration. It also delivered the separately requested login
usability change in its own branch; no credentials or database rows were
copied between stacks.

### Additional Desktop regression fixed

After the first successful native Desktop response, Hermes resolves the
provider label from `custom` to the configured custom-provider name. Our old
menu filter depended on the literal `custom`, so unsupported effort choices
reappeared. Commit `f3137cf17d3841e77290deb831a748c5e3d46216` keys the filter to
the exact governed Lite/Balanced/Pro model aliases instead. Control still
authorizes effort and routing; this is a UI compatibility fix, not an
alternative security boundary. The contract test checks this label-independent
filter. It changes no shared agent adapter or broker implementation.

The rebuilt workspace image is
`sha256:c93b8b11ded78914578db0ff0766e0aaf9badb4c47d4dce2b81950852df945d3`.
`npm run image:workspace` and `npm run verify:quick` passed (907 passed,
39 normal skips, zero failures). The first installed-image qualifier invocation
failed its failed-tool SSE assertion. A bounded synthetic-response diagnostic
was added, then the diagnostic rerun and three consecutive complete reruns
passed. The initial failure did not reproduce; its cause is not established.
It is not being described as a separately diagnosed product fix.

### Actual browser observations

| Surface | Observation | Result and limit |
| --- | --- | --- |
| Web Chat Low/Medium/High | Terminal tools, final answers, and completed Activity records | Passed on the preceding `87f422...` image, whose Python integration is unchanged in the final image |
| Web Chat resume/concurrency | Medium resumed; Low and High conversations overlapped, keeping distinct effort and signed-binding provenance | Passed bounded live smoke |
| Web Chat Auto | Both the earlier fixed image and final `c93b8b...` image completed real tool turns; ledger resolves Auto to organization maximum High | Passed; final-image turn overlapped native Desktop Low |
| Native Desktop Low/Medium/High | Actual Electron UI selections, terminal tools and correct final answers; saved session reopened and resumed on the final image | Passed bounded UI smoke; same-session effort changes are supplementary, not substitutes for separate-conversation qualification records |
| Native Desktop route changes | UI-selected Lite and Pro reached Luna and Sol respectively; Balanced reached Terra | Passed and verified against actual usage admissions |
| Native Desktop effort menu | Only Low/Medium/High after saved-session resume and completed turns with the named custom provider | New menu regression fixed and visually verified |
| Native approval path | A harmless Python command completed through smart approval without hanging | Live auxiliary/approved path passed; human-required blocked fallback is fixture-tested, not established by this live prompt |
| API/Desktop coexistence | Web Chat Auto completed while Desktop was running; API health remained HTTP 200 | Previous lifecycle failure did not recur |

The bounded UI batch contains 46 successful provider admissions, zero explicit
effort mismatches, and nine completed Web Chat turns. All Web Chat admissions
have `explicit_signed` provenance. Provider-call latency ranges from 1,050 to
4,897 ms; this is not full-turn latency or a comparative benchmark. Thirty-eight
calls have estimated costs and eight remain unpriced. No provider-confirmed
cost is claimed.

Product transcript part types were text, progress and terminal; Activity
contains tool, plan, progress and terminal records. All inspected reasoning
columns were empty across 91 CLI/API and 56 Desktop messages in the synthetic
home. Twelve native log files contained no nonempty structured reasoning or
think/analysis-tag markers. These bounded checks do not establish absence of
all unlabelled content across every retained surface. No product artifacts were
created in this batch. Hermes Desktop's automatic self-improvement did create a
native skill after repeated synthetic arithmetic turns. A bounded scan of all
621 native skill files, including that generated file, found no structured or
tagged reasoning markers; this remains a marker-based inspection, not proof
against every possible unlabelled content format.

Credential-free admission IDs, usage units, terminal states and preservation
checks are retained in the local worktree's ignored
`.artifacts/hermes-ui-requalification-20260920/` directory. The live mapping
remains `2db28c83-9d04-48fd-9795-135542162daa` throughout this run.

### Login change delivered independently

Commit `7a1c7dc34786b3cbafc4c7b9787500ba902b112d` on the dedicated login-form
usability task branch makes Enter submit the active sign-in/account form,
including company SSO, while retaining browser validation and preventing
submission during an in-progress action. Password inputs have accessible
Show/Hide eye buttons. Visibility resets when switching account-form modes;
toggling visibility does not submit the form. Account-security password fields
use the same component. Authentication requirements are unchanged.

Validation:

- `CHOKIDAR_USEPOLLING=1 npm run test:e2e -- tests/e2e/customer-authentication.spec.ts tests/e2e/customer-invitation.spec.ts`: 29 passed.
- `CHOKIDAR_USEPOLLING=1 npm run test:customer-auth:e2e`: one real Better Auth/passkey fixture passed.
- Login branch `npm run verify:quick`: 905 passed, 39 normal skips, zero failures.
- Combined local source `npm run verify:quick`: 907 passed, 39 normal skips, zero failures.
- The password-visibility screenshot was inspected. The initial non-polling
  browser invocation hit the host's file-watcher limit; polling resolved it.
  Label-selector ambiguities introduced by the accessible eye button were
  fixed before the final passing browser runs.

No schema/migration or deployment-profile changes; `verify:db` was not required.

### Current local state and remaining acceptance

Local source is `80ab30f906c8f2ff5ccc2acd84c97715b1d9d323`, combining temporary
candidate registrations, Hermes fixes and the login change. Control image
`sha256:9d44adbe8212b62b15cde9818cc53253ccf6f4561cdee89d25b6d73e0c6a0dd9`
is deployed on 4174. The dedicated test sandbox is healthy on `c93b8b...`, with
its original home volume. The previous Control/workspace images remain
available. The ordinary local workspace tag was restored to original
`sha256:da90f915fa05df4f2a920afa695a363ef3a53169564f0dc94ec2bc85a27c1659`
after testing; the running test container retains the candidate. A future
candidate restart must explicitly stage the retained candidate tag
`lemmacomputer/workspace:hermes-ui-candidate-cbf2f9ac06-20260920` again.

All seven pre-existing sandbox/egress containers and both PostgreSQL containers
retain their original IDs, start times and volume identities. The local `.env`
hash is unchanged. No unrelated workspace was restarted.

Publishing routing, even identical assignments, invokes
`reconcileTenantWorkspaceRoutePolicies` and restarts every ready/open workspace.
The live revoke/alter-route check therefore needs an interruption decision for
the other local workspaces. That specific confirmation was requested; no route
publication occurred during this run. Remaining work is that live denial gate,
complete retained-surface/approval evidence, and strict commit-bound records
including the required separate-conversation observations. The validator has
not been run on an incomplete record. The task registrations stay discovery.
No main merge, remote push, release tag or demo deployment occurred.

## User-authorized workspace cleanup and CP upgrade, 2026-09-20

The user requested deletion of every workspace except **CP Workspace**, then
explicitly included the four workspaces in other local test organizations.
Seven live/stopped workspace records were deleted: the Hermes and Codex
qualification workspaces, Issue 85 Lite Traces, and four older test workspaces.
The three METECH workspaces used the signed-in product deletion flow. The four
other test-organization workspaces used an exact-ID local maintenance operation
through the installed store, controller and gateway lifecycle interfaces:
claim stop, revoke access and gateway grants, destroy runtime, purge home,
end agent instances, and tombstone with `contentDisposition=preserve`.
No raw SQL deletion, organization closure, provider removal or database-volume
cleanup was used. Durable chats/artifacts were retained separately from the
removed workspace homes. A final database read found only CP undeleted; Docker
found only CP's sandbox/egress/relay and its single workspace-home volume.

CP Workspace `a447eeeb-6bd2-43b0-90a3-f545bb67b634` had no queued/running Chat
turns before its restart. Its SQLite database was consistently backed up inside
the workspace user's existing local-state directory. The backup integrity check
passed. The source contained 703 messages.

The tested `c93b8b...` workspace image is now the local default, and CP was
restarted through the product onto that exact image. Its original volume
`lemmacomputer-cbf2f9ac06-workspace-home-a447eeeb-6bd2-43b0-90a3-f545bb67b634-g1`
was retained. Installed Hermes CLI is `0.21.3`, Python `3.13.15`, SQLite
`3.53.1`; the Desktop installation stamp retains upstream commit
`345cd2b057a452236de401d3534b8502a7465e8d`. CP's existing agent assignment is
CLI only; this operation did not add Desktop to its selected agents.

Post-upgrade API health returned 200 and SQLite integrity passed. All 703
original messages retained matching IDs, session IDs, roles and content.
A real browser Chat turn in conversation
`a4916708-9289-4dc3-b9c2-51a0b1e3361b` completed a terminal calculation with
the correct answer. All three associated provider admissions succeeded with
Balanced/Terra, Medium requested/resolved, and `explicit_signed` provenance.
The UI still exposes Auto/Low/Medium/High. This verifies the CP upgrade; it is
not a substitute for full runtime qualification.

No route mapping was republished in this operation. The remaining acceptance
work is the live stale-route denial test, live human-required approval fallback,
complete retained-surface checks and the required final-build conversation
observations, followed by strict commit-bound evidence validation and runtime
promotion. With the other workspaces removed, route publication would now
interrupt only CP. It has not been performed or claimed as passed. Temporary
local registrations remain in Control; task-source registrations remain
`discovery`. No schema, application-code, main-branch, remote or demo change
was made during this cleanup/CP-upgrade operation.

## CP final-image qualification continuation, 2026-09-21

The user authorized the remaining validations on the running 4174 stack. CP
remained healthy on workspace image
`sha256:c93b8b11ded78914578db0ff0766e0aaf9badb4c47d4dce2b81950852df945d3`.
Only the qualification report changed after runtime commit
`f3137cf17d3841e77290deb831a748c5e3d46216`; the workspace-image source tree is
otherwise identical.

Fresh product-chat observations against CP passed:

| Gate | Bounded result |
| --- | --- |
| Low | Conversation `d2e34833-291e-4f27-962b-13ddd301b393` completed a terminal tool and returned `2870`; requested and resolved effort were Low |
| Medium and resume | Conversation `d4bc921e-67b0-4182-9572-f3770286cf06` completed two terminal-tool turns and returned `4095` then `4466`; both turns retained Medium |
| High | Conversation `c4334362-bc4a-4006-b569-ce4bc467812a` completed a terminal tool and returned `3795`; requested and resolved effort were High |
| Auto | Conversation `75770aa9-7ff2-4739-96e0-91c70cdc6db2` completed a terminal tool and returned `4900`; the ledger resolved Auto to the organization maximum High |
| Concurrency | Low ran from `02:16:41.665Z` to `02:17:17.424Z`; High ran from `02:16:42.065Z` to `02:16:47.255Z`. Distinct conversation, task and usage-attempt IDs retained their requested efforts and `explicit_signed` provenance |

Every observed turn has ordered tool `running` and terminal tool `completed`
Activity followed by terminal `completed`. The selected final provider attempt
for each explicit level reports input, output and cache-read units. The provider
does not report reasoning-token or cache-write units. Costs are rate-card
estimates rather than provider-confirmed charges.

The live human-required approval fallback also passed. CP was temporarily set
to Hermes `manual` approval mode through the supported approval command. A
harmless terminal request failed deterministically in Web Chat with a visible
explanation that native Hermes approval is unavailable there; the turn itself
completed and did not hang. The configuration was restored byte-for-byte:
SHA-256 `553b2064a954cbab2bbdcc15316f3093e1bff3c4aab314ec26bc5a3ecb2a371a`,
and Hermes reports persistent mode `smart`.

Retained-surface checks found only `text`, `data-progress`, and `data-terminal`
parts in the four final conversations; Activity contained only plan, tool,
progress and terminal records. No product artifacts were linked. In CP's native
Hermes state, `reasoning`, `reasoning_content`, `reasoning_details`, and
`codex_reasoning_items` are all empty. Nine native log files contained zero
known structured reasoning markers. Token counts and finish reasons remain
ordinary metadata, not hidden reasoning content. These are marker- and
field-based checks and do not prove the absence of arbitrary unlabelled prose.

The bounded external record passed `npm run qualify:reasoning-adapter` against
qualification commit `9223fa877c89b995a5aad126d57955327cd48d05`. It includes
no prompts, responses, tool payloads, signed bindings, credentials, or hidden
reasoning. The record explicitly states that the live route-revocation gate is
still missing, so this validator pass is a schema and historical commit-binding
check and is not promotion evidence for later review commits.

After the earlier cleanup, a new ready/open **Test Agents** workspace appeared
in the same tenant. It has no queued or running Chat turn, but its interactive
workspace remains open. Publishing even an identical route mapping invokes
tenant-wide workspace-policy reconciliation and restarts both CP and Test
Agents. No route was republished and Test Agents was not restarted, modified,
or deleted. The one remaining live gate is route revocation or alteration after
capability projection, followed by confirmation that stale execution fails
closed. Hermes CLI `0.21.3` and Desktop `0.17.2` therefore remain discovery and
are not promoted.
