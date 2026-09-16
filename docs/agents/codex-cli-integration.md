# Codex CLI integration

The workspace exposes Codex CLI as an opt-in selection wherever organization
policy assigns it. The exact `0.154.0` runtime is staged as a reasoning-adapter
candidate for local live qualification. It must stay off `main` unless the
complete live evidence contract passes. This work advances #76 and #78; it does
not qualify a production release.

## Runtime pins

- Native CLI: `0.154.0`, the latest npm stable version checked on 2026-09-17.
- Linux x64 artifact: `https://registry.npmjs.org/@openai/codex/-/codex-0.154.0-linux-x64.tgz`.
- Artifact SHA-256: `e27c83a49e6031685ee7f956c12aad5f16484d3a80181dd3fea930fb96b3832b`.
- Python SDK and bundled CLI dependency: `openai-codex==0.154.0` and
  `openai-codex-cli-bin==0.154.0`. Both the terminal launcher and chat adapter
  explicitly execute the separately checksum-pinned native binary.

The image verifies the downloaded checksum, CLI version, and SDK version. No
host Codex installation or host Codex credentials are changed.

## Organization routing

The generated Codex catalog contains only assigned `lemmacomputer-lite`,
`lemmacomputer-balanced`, and `lemmacomputer-pro` aliases. The default follows
the workspace configuration, including the legacy Auto-to-Balanced mapping.
Context limits and compaction headroom are projected per alias when route
metadata is available. These are client hints; Control checks current route
readiness and policy on every request. The static client catalog does not
independently certify current provider availability.

Model requests use HTTP Responses through the root-owned loopback broker.
WebSocket transport and request compression are disabled for that broker's
HTTP contract. Provider keys remain in the gateway; user processes receive a
loopback placeholder. MCP uses the same governed connector bridge. Upstream
model catalogs, updates, apps, remote plugins, feedback, and native web search
are not advertised by the generated profile. Configuration regeneration
preserves vendor sessions and history.

The broker recognizes Responses `reasoning.effort` as bounded native intent,
rejects unsupported/conflicting values, and strips it before provider dispatch.
Only Control-issued signed intent may govern provider effort. The staged exact
pin advertises Low, Medium, and High while Control still intersects every choice
with the active organization ceiling and the selected route capability.

## Resume regression

The earlier `0.153.4` app server retained first-turn provider headers when the SDK
resumed a thread in the same process, even when `thread_resume(config=...)`
supplied a new binding. A six-request fixture detected duplicated old bindings.

Each chat turn now starts an app-server process with its own task binding in
the startup configuration. This applies to browser, channel, and schedule
turns. The vendor thread ID and home remain persistent, so the fresh process
resumes the existing conversation. A single startup process initializes the
vendor home before concurrent per-turn processes are launched. Control-issued
agent identities remain independent of vendor thread IDs.

## Verification

Activate a Python environment with the pinned agent-chat requirements, then:

```bash
npm run qualify:codex-runtime -- --binary /path/to/codex
```

The local fixture executes the real native binary and SDK. It checks the
organization-only model catalog, Low/Medium/High presentation, streaming,
three concurrent model modes, saved-thread resume, uncompressed HTTP,
independent instance headers, and six distinct per-turn task bindings. It
executes the production process-config function. Fixture bindings are
synthetic; this is not live policy qualification.

The final `npm run verify:quick` passed: 904 tests passed, 39 were skipped by
the standard non-database suite, and none failed. `npm run image:workspace`
built the candidate image successfully. The native fixture also passed inside
that image as UID 1000 with no external network, a read-only root filesystem,
and no persistent volumes. No Web UI code changed; Playwright and database
verification were not run for this runtime-only slice.

The default Node suite covers profile projection, rejected classes/limits,
history preservation, fresh per-turn processes, native effort validation, and
the existing broker and identity boundaries.

On 2026-09-08, a separate restricted demo workspace named **Codex Qualification**
was created with the already supported Hermes identity. The new Codex binary
was temporarily installed there for transport testing only:

- A real Responses request invoked an approved read-only MCP tool and completed.
- Lite, Balanced, and Pro each completed a new and resumed conversation while
  all three conversations ran concurrently and retained their own markers.
- Eight inference admissions were successful and explicitly signed. The ledger
  resolved Lite to `openai/gpt-5.6-luna`, Balanced to `openai/gpt-5.6-terra`, and
  Pro to `openai/gpt-5.6-sol`. All were priced with estimated cost; recorded
  inference latency ranged from 1,324 to 2,604 ms. These small samples are not
  performance benchmarks or cache evidence.

This live check used that workspace's **Hermes broker identity**. It proves the
new Codex wire/tool transport composes with the existing organization routes;
it does not qualify Codex-specific identity, accounting attribution, Web Chat,
thinking controls, or restart persistence. The demo application services,
environment, production gates, and existing TT-CP workspace were unchanged.
The qualification workspace was stopped afterward, preserving its home.

## Live promotion gates

1. Qualify a separate workspace using an actual Codex policy identity and the
   candidate image, including lifecycle, credential isolation, restart,
   reconnect, chat, tools, and durable resume.
2. Complete #76's live effort, hidden-thinking, accounting, cache-availability,
   and negative-path evidence before retaining the staged runtime record.
3. Complete #78's currently-ready mode presentation and conversation-selection
   contract with the required browser tests. Native model changes must not
   weaken conversation-pinning semantics.

This is a workspace-runtime and dependency change, requiring the full release
workflow for deployment. It is not eligible for the routine `demo:update` path.
There are no schema or migration changes. Both deployment profiles share the
same adapter, broker, and tenant-scoped routing path.

## Local integration checkpoint — 2026-09-08

At the user's request, candidate `9aee7b5` was merged into the existing
`mike/local-stateful-test` branch as `dbc9463`. The merged tree matched the
candidate tree. The local workspace image was rebuilt and `compose:up`
completed with healthy services, reusing the existing environment and volumes.
The environment checksum was unchanged. Existing CP Workspace and Test2
containers retained their running instances; no organization policy was saved.

The merged quick gate passed 905 tests with 39 standard skips and no failures.
All 16 focused workspace Playwright tests passed, including Codex opt-in save
and absence of a selectable Codex control when organization policy denies it.
A behavioral event test proves that text and MCP tool lifecycle survive while
both raw reasoning and provider summaries are discarded by the Codex adapter.

Real Chrome at `localhost:4174` showed Codex CLI disabled by the local
organization's v8 allowlist. A pending, unsaved guardrail revision adds only
Codex to that allowlist. The product applies guardrail revisions to all members
and automatically restarts compatible running workspaces. Live qualification
under a Codex identity awaits authorization for that policy transition.

Additional governed-routing qualification uncovered an outdated fixture. Its
authority responses now include the required workspace access generation,
provider deployment binding, and output limit. The probe uses Responses with
an exact provider/deployment identity, and the fixture verifies that provider
requests exclude internal admission metadata and revoked workspace access
fails before routing. `npm run qualify:governed-routing` passes. Production
policy enforcement was unchanged by this fixture repair.
