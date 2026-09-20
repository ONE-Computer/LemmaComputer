# Hermes 0.21.3 / Desktop 0.17.2 qualification candidate

This task branch contains the exact new runtime registrations in discovery.
They are NOT evidence of a completed live qualification. Do not deploy this
candidate as a finished upgrade: the new pins deliberately do not expose
thinking controls until the gates in reasoning-adapter-qualification.md pass.
A temporary promotion may be staged on this branch for local live testing.
The earlier qualified pins remain registered; their evidence is not widened.

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
- No running local service, provider credential, existing workspace home,
  database, or `.env` was replaced. No deployment-profile behavior changed.

Credentialed CLI/Desktop/product Chat runs at Low/Medium/High, governed tools,
resume/concurrency, stale-policy denial, usage evidence, and hidden-reasoning
checks remain outstanding. The local stack at `http://localhost:4174` is the
authorized live target; it does not require provider credentials to be copied
into the new worktree. Browser access was blocked by an open Chrome extension
panel. No commit-bound live qualification record or release promotion has
been produced. This candidate is not eligible for integration as the completed
upgrade.
