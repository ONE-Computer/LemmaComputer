# Governed thinking-effort qualification

This document is the reviewed capability record for LemmaComputer's first qualified route and agent adapter; it is not a requirement that other adapters use Anthropic. The product control is exposed only when both the selected agent runtime and governed model route match reviewed qualifications. Unknown or discovery-only agents, providers, models, or client versions fail closed and do not expose an effort selector. The provider-neutral cross-runtime and route-registration contract is defined in [Reasoning adapter qualification](reasoning-adapter-qualification.md).

Route qualification ID: `anthropic-claude-4.6-4.8-effort-route-2026-08-13`

Agent-adapter qualification ID: `claude-cli-2.1.215-governed-effort-adapter-2026-08-13`

## Qualified model routes

| Provider route | Provider model | Product levels | Provider mechanism | Status |
| --- | --- | --- | --- | --- |
| Direct Anthropic | `claude-sonnet-4-6` | Low, Medium, High | Adaptive thinking plus `output_config.effort` | Qualified by documented contract |
| Direct Anthropic | `claude-opus-4-8` | Low, Medium, High | Adaptive thinking plus `output_config.effort` | Qualified by documented contract |
| Amazon Bedrock | Current Sonnet 4.5 profile | None | Not assumed equivalent to the direct Anthropic effort contract | Unsupported; fail closed |
| Any other provider or model | Any | None | Unknown | Unsupported; fail closed |

## Qualified agent adapters

| Agent runtime | Pinned version | Product levels | Status |
| --- | --- | --- | --- |
| Claude CLI | `2.1.215` | Auto, Low, Medium, High | Qualified for signed, conversation-pinned propagation |
| Claude Desktop | `1.22209.3` | Low, Medium, High | Native effort intent uses `output_config.effort`; separate exact-version registration and [recovery evidence](claude-desktop-recovery.md) |
| Hermes Agent CLI | `0.19.0` | Low, Medium, High | Qualified separately under `hermes-claw-0.19.0-governed-effort-adapter-2026-08-13`; route capability still intersects independently |
| Hermes Desktop | `0.17.0` | Low, Medium, High | Qualified separately under `hermes-desktop-0.17.0-governed-effort-adapter-2026-08-13`; unsupported upstream levels are hidden on LemmaComputer routes |
| Codex CLI | `0.144.4` | None | Discovery recorded; credentialed reasoning-plus-tool evidence remains incomplete; fail closed |
| Any other runtime or version | Any | None | No reviewed registration; fail closed |

`Auto` is a LemmaComputer product setting, not a provider effort value. Control resolves it to the organization maximum (`low`, `medium`, or `high`) before route selection. The protected maximum `max` is deliberately clipped to product `high`; `xhigh` and `max` are not user-selectable in this phase.

This is Auto **thinking effort**, not Auto **model mode**. Employee Web Chat exposes only the explicit `Lite`, `Balanced`, and `Pro` model tiers from #68.

The qualification is based on Anthropic's current documented contracts for [adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking), [effort](https://platform.claude.com/docs/en/build-with-claude/effort), [extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking), the [Messages API](https://platform.claude.com/docs/en/api/go/messages), and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/cli-usage). A provider or Claude Code upgrade must add a new reviewed qualification ID rather than widening the existing match.

## Enforcement path

1. Routing administration derives route capability from the provider and model. A separate code-owned registry derives agent-adapter capability from the agent catalog ID and pinned client version. Administrator-supplied capability claims are ignored.
2. Control intersects route capability, agent-adapter capability, the employee's Team route, and the protected organization maximum. Only that intersection reaches the UI.
3. The conversation stores the selected product effort. Once created, the selector is locked; a different effort starts a new conversation so prompt-cache behavior remains predictable.
4. Control signs the requested effort and maximum into the AI task binding. The workspace gateway removes client-supplied `thinking`, `output_config`, `reasoning`, and enabled `reasoning_effort` fields. The only client-side value it may preserve is the non-escalating Chat Completions opt-out `reasoning_effort: none` for unqualified tool-capable runtimes.
5. After governed route resolution, the LiteLLM callback injects only the resolved `low`, `medium`, or `high` value. The route must advertise that exact capability or routing fails closed.
6. Usage admission records both requested and resolved effort. Provider-reported reasoning tokens remain a separate `reasoning_token` usage bucket; hidden reasoning text is never stored or exposed.

## Adapter extension contract

Adding an agent does not add a new Web or Control conditional. Exact runtime pins may first land as discovery records, which remain ineligible for product controls. Promotion adds a reviewed qualified registration containing the exact catalog ID, pinned runtime version, supported product levels, and completed runtime evidence. Provider/model route qualifications remain separate because an agent transport and a model route can support different subsets. A level is exposed only when both sides include it.

`Auto`, `Low`, `Medium`, and `High` are stable LemmaComputer product intents, not claims that different providers use identical token budgets or reasoning semantics. Each adapter or route may translate or narrow them. No adapter may expose hidden thinking content.

## Expected behavior and evidence limits

Higher effort can increase latency and reasoning-token cost. Changing effort can also invalidate prompt-cache reuse, which is why the phase-0.5 control is stable for the life of a conversation. The Activity panel continues to show only allow-listed summaries and actions, never hidden chain-of-thought.

This record qualifies the documented direct-Anthropic request/response contract, the Claude CLI adapter, and the local gateway behavior. Hermes is qualified by its own exact adapter registrations and separately qualified organization route, not merely because its upstream runtime has a similarly named setting. Codex and any other agent remain unqualified until their own gates pass. This record also does not claim a live Anthropic account smoke test or comparative latency/cost benchmark; those require an explicitly provisioned direct Anthropic route and provider credentials. See the [Agent model and reasoning adapter playbook](agent-reasoning-adapter-playbook.md) for the Claude/Hermes implementation comparison and failure lessons.
