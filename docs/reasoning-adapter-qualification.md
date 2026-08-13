# Reasoning adapter qualification

LemmaComputer exposes one provider-neutral thinking-effort control. An agent runtime becomes eligible only when its exact client pin has a qualified adapter and the selected organization route separately qualifies the same effort level. No runtime requires an Anthropic, OpenAI, or other named provider; it works through the organization's assigned model alias.

`Auto` in this document means only the thinking-effort default that follows the organization's allowed maximum. Employee Web Chat does not expose an Auto model mode: model selection remains the explicit `Lite`, `Balanced`, or `Pro` tier shipped by #68.

The adapter does not own provider reasoning policy. Its job is to preserve the conversation selection, carry Control's signed task binding to the loopback gateway on every turn, stream text and tool lifecycle events, and suppress hidden reasoning content. The gateway removes native reasoning fields supplied by any workspace client; the governed route injects the resolved provider value after policy evaluation. Exact provider/model routes join through a separate code-owned registration, without provider branches in Web, Control, or the runtime adapter.

## Review states

The code-owned registry distinguishes two states:

- `discovery`: the exact upstream client and LemmaComputer transport have been inspected, but required live evidence is incomplete. The runtime receives no thinking-effort options in Web Chat.
- `qualified`: the exact runtime pin has a qualification ID and all required evidence. Control intersects its levels with organization policy and route capability; Web Chat needs no runtime-specific conditional.

Changing a record from discovery to qualified is a reviewed product change. Administrator metadata, a provider's similarly named field, or a passing fixture test cannot promote it.

## Current adapter matrix

| Runtime | Exact pin | Review state | Provider-effort authority | Product behavior |
| --- | --- | --- | --- | --- |
| Claude CLI | `2.1.215` | Qualified under `claude-cli-2.1.215-governed-effort-adapter-2026-08-13` | Governed route from signed task binding | Eligible for Auto, Low, Medium, and High when the route and organization policy also allow them |
| Hermes Agent CLI | `0.19.0` from tag `v2026.7.20`, upstream commit `3ef6bbd201263d354fd83ec55b3c306ded2eb72a` | Discovery under `hermes-claw-0.19.0-governed-effort-discovery-2026-08-13` | Governed route; Hermes global `reasoning_effort` remains disabled | No selector until the live gates pass |
| Codex CLI | `0.144.4` | Discovery under `codex-cli-0.144.4-governed-effort-discovery-2026-08-13` | Governed route; no Codex-native `effort` is trusted as policy | No selector until the live gates pass |
| Any other runtime or version | Any | Unreviewed | None | Fail closed |

Hermes and Codex both expose upstream reasoning controls, but that does not make their labels or behavior equivalent to Claude or to one another. LemmaComputer's Low, Medium, and High values are bounded product intents. The separately qualified provider route decides their concrete wire meaning. Direct Anthropic is the first existing route registration from #69, not a prerequisite for these adapters or for future route registrations.

## Shared transport contract

Every qualifying runtime must prove the same boundary:

1. Web Chat stores `Auto`, `Low`, `Medium`, or `High` when the conversation is created. Later turns must match that stored value.
2. Control intersects the agent review, exact route capability, effective organization policy, and maximum effort.
3. Control signs the requested effort and ceiling into the per-turn AI task binding.
4. The runtime adapter carries that binding request-locally to the loopback gateway before the first model call and on every resumed turn.
5. The gateway strips `thinking`, `output_config`, `reasoning`, and `reasoning_effort` supplied by the runtime.
6. The route authority injects only the resolved qualified value and records requested and resolved effort in usage evidence.
7. The adapter projects allow-listed text, tool, progress, source, and terminal events. It never emits or persists hidden reasoning text.

This is why the Codex discovery branch's native `AsyncThread.turn(..., effort=...)` experiment is not copied into the shared implementation. It would create a second, client-side effort setting even though the gateway must discard that setting. Codex continues to carry the signed binding in its model-provider headers; Hermes carries the same binding through its request-local API-server override. Hermes's mutable global reasoning setting remains disabled.

## Promotion gates

Run these gates against the exact runtime version and a separately qualified route that supports the proposed levels. The adapter evidence remains valid for any other route that satisfies the same signed gateway contract; provider semantics are evidenced by that route's own qualification. Use an isolated worktree deployment. Add any chosen provider credential through **AI control plane -> Models & providers**; do not place credentials in `.env`, documentation, test output, or evidence artifacts.

### 1. Static and fixture evidence

- Verify the package, binary, source tag, and checksums match the proposed pin.
- Prove the signed binding reaches the runtime's first and resumed model calls without process-global or cross-session state.
- Prove forged native reasoning fields are stripped and cannot override the signed request.
- Prove Low, Medium, High, over-policy, stale-version, unsupported-route, and provider-mismatch behavior.
- Prove streamed text and MCP/function-tool lifecycle events retain stable ordering and terminal states.
- Prove raw reasoning/thinking events are absent from transcript, Activity, logs, and artifacts.

### 2. Credentialed live smoke

For each proposed level, start a new conversation and run a prompt that requires both multi-step reasoning and at least one governed MCP/function tool. Record only bounded evidence:

- runtime catalog ID and exact version;
- route qualification ID, provider, model, and immutable deployment/mapping version;
- conversation, task, and usage-attempt identifiers;
- requested and resolved effort;
- streamed text observed, tool started, tool terminal state, and turn terminal state;
- provider-confirmed usage units, including reasoning tokens when available;
- latency and cost, explicitly marked unavailable where the provider does not report them;
- confirmation that no hidden reasoning content appeared in product surfaces or retained logs.

Repeat one conversation turn to exercise resume behavior. Run concurrent conversations at different permitted levels and confirm their signed bindings and usage records do not cross. Revoke or alter the route after capability projection and confirm stale or mismatched execution fails closed.

### 3. Cache and comparative evidence

Effort is immutable within a conversation. Compare repeated same-effort turns inside one conversation with separate conversations at other efforts. Record provider-confirmed cache-read/write units when available; do not infer a cache hit from latency alone. Cost or latency samples describe only the qualified route and date, not a universal relationship between product levels.

### 4. Promotion

- Replace the discovery record with a `qualified` registration and a new immutable qualification ID tied to the evidence record.
- Register only the levels that passed. A runtime may expose a narrower subset than its upstream API advertises.
- Add the exact runtime/route combinations and evidence limits to the matrix.
- Run focused registry, gateway, chat adapter, usage, and Playwright tests, then `npm run verify:quick`. Run `npm run verify:db` if persistence or migration behavior changed.
- A client or provider upgrade requires a new discovery and qualification record; never widen an old exact-version match.

## Current discovery evidence and limits

The Hermes branch `codex/hermes-reasoning-adapter` at local commit `4741eb934c605eaa030c4d36605613327c166d1a` and Codex branch `codex/codex-reasoning-adapter` at local commit `1d80ca3eef5129c75cdb72f1cae77128e9721e46` are research inputs. Their pinned-source inspection, compilation, fixture, streaming/tool, browser, and quick-gate results support the discovery records. They do not supply a credentialed live reasoning-plus-tool run, provider-confirmed usage/cost/latency/cache evidence, or a basis for merging either branch wholesale.

Until those live gates pass, both runtimes remain discoverable to qualification tooling but intentionally absent from the Web Chat thinking selector.
