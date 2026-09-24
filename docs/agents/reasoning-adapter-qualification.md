# Qualifying agent reasoning adapters

**Use this when adding or upgrading an agent runtime.** The code-owned
registration in `packages/model-router/src/governed.ts` is the current source of
truth. This page explains what a registration means and the evidence needed
before promotion. A registered adapter, a qualified provider route, and an
organization policy must all permit a thinking level before a user can select
it.

`Auto` here is a thinking-effort default resolved to the organization's
maximum. Web Chat's model choice remains the explicit Lite, Balanced, or Pro
tier.

## Current registrations

These exact versions are marked `qualified` in the checked-in registry:

| Runtime | Version | Thinking levels |
| --- | --- | --- |
| Claude CLI | `2.1.215` | Low, Medium, High; product Auto |
| Claude Desktop | `1.22209.3` | Native Low, Medium, High |
| Hermes CLI | `0.21.3` | Low, Medium, High; product Auto |
| Hermes Desktop | `0.17.2` | Native Low, Medium, High |
| Codex CLI | `0.154.0` | Native Low, Medium, High |

Older Hermes `0.19.0`/Desktop `0.17.0` registrations also remain in the
registry; they do not qualify newer versions. An unlisted version has no
registration and fails closed. Registration is code state, not proof that a
specific deployment, provider credential, or human workflow was live-tested.

The route registry separately qualifies direct Anthropic Sonnet 4.6/Opus 4.8
and managed OpenAI GPT 5.6 routes for Low, Medium, and High. Other routes must
be reviewed independently. Exact model and runtime IDs can change; verify the
registry before relying on this table.

## Boundary to preserve

1. Control intersects the exact runtime registration, selected route,
   organization policy, and maximum effort.
2. Control stores effort with the conversation and signs it into each task
   binding. A resumed turn retains the same selection.
3. The agent adapter carries that binding on the first and resumed turns.
   Native client settings are untrusted intent. The loopback gateway strips
   client-supplied provider reasoning fields and the governed route injects
   only the resolved value.
4. The callback verifies the exact provider deployment and records requested
   and resolved effort with usage admission. It must not treat a display model
   name as proof of execution.
5. The adapter emits approved text, tool, progress, source, and terminal
   events. Hidden reasoning never enters transcript, Activity, logs, or
   artifacts.

## Qualification steps

Use an [isolated task worktree](../guides/development-workflow.md). Configure
any provider credential through **AI control plane → Models & routing**, not
through the agent runtime, `.env`, or an evidence file.

1. Pin the package, binary, source, and checksums. Inspect model discovery,
   effort controls, first and resumed turns, streaming, tools, and hidden
   reasoning events.
2. Add a discovery registration first. Prove signed-binding propagation,
   forged-field stripping, over-policy denial, stale-route denial, ordering,
   terminal states, and no hidden reasoning in fixtures.
3. For each proposed effort, run a new credentialed conversation that streams
   and uses a governed tool. Repeat one turn, run concurrent conversations at
   different efforts, and change or revoke a route to prove stale execution
   fails closed. Check actual admission and routing records.
4. Record bounded observations in a JSON evidence file outside the repo and
   validate against the exact commit:

   ```bash
   npm run release:check-reasoning -- --evidence=/absolute/path/to/reasoning-adapter-evidence.json
   ```

5. Review the observations, then promote only the exact runtime and levels
   that passed. Run focused gateway, registry, chat, usage, and browser tests,
   `npm run verify:quick`, plus `npm run verify:db` if persistence changed.

The validator checks structure and commit binding; it cannot independently
prove that a reported live observation occurred. Evidence records should
contain IDs, exact versions, requested/resolved effort, terminal tool and turn
states, provider-confirmed usage availability, and limits. Keep credentials,
prompts, responses, tool payloads, and signed bindings out of the file.

For a native Desktop with no Auto menu, record Auto as `not-exposed`; do not
invent a native Auto run. Cache, latency, cost, and reasoning-token observations
are route- and date-specific. Mark unavailable values unavailable rather than
zero.
