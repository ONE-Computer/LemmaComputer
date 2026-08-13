# Claude thinking-effort qualification

This document is the reviewed capability record for LemmaComputer's Claude Code thinking-effort control. The product control is exposed only when the selected governed deployment matches every qualified field below. Unknown providers, models, or client versions fail closed and do not expose an effort selector.

Qualification ID: `claude-code-2.1.215-anthropic-effort-2026-08-13`

## Qualified combinations

| Client | Provider route | Provider model | Product levels | Provider mechanism | Status |
| --- | --- | --- | --- | --- | --- |
| Claude Code `2.1.215` | Direct Anthropic | `claude-sonnet-4-6` | Auto, Low, Medium, High | Adaptive thinking plus `output_config.effort` | Qualified by documented contract |
| Claude Code `2.1.215` | Direct Anthropic | `claude-opus-4-8` | Auto, Low, Medium, High | Adaptive thinking plus `output_config.effort` | Qualified by documented contract |
| Claude Code `2.1.215` | Amazon Bedrock | Current Sonnet 4.5 profile | None | Not assumed equivalent to the direct Anthropic effort contract | Unsupported; fail closed |
| Any other version, provider, or model | Any | Any | None | Unknown | Unsupported; fail closed |

`Auto` is a LemmaComputer product setting, not a provider effort value. Control resolves it to the organization maximum (`low`, `medium`, or `high`) before route selection. The protected maximum `max` is deliberately clipped to product `high`; `xhigh` and `max` are not user-selectable in this phase.

The qualification is based on Anthropic's current documented contracts for [adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking), [effort](https://platform.claude.com/docs/en/build-with-claude/effort), [extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking), the [Messages API](https://platform.claude.com/docs/en/api/go/messages), and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/cli-usage). A provider or Claude Code upgrade must add a new reviewed qualification ID rather than widening the existing match.

## Enforcement path

1. Routing administration derives the capability from the provider, model, and pinned Claude Code version. Administrator-supplied capability claims are ignored.
2. Control intersects those capabilities with the employee's Team route and the protected organization maximum. Only that intersection reaches the UI.
3. The conversation stores the selected product effort. Once created, the selector is locked; a different effort starts a new conversation so prompt-cache behavior remains predictable.
4. Control signs the requested effort and maximum into the AI task binding. The workspace gateway removes client-supplied `thinking`, `output_config`, `reasoning`, and `reasoning_effort` fields.
5. After governed route resolution, the LiteLLM callback injects only the resolved `low`, `medium`, or `high` value. The route must advertise that exact capability or routing fails closed.
6. Usage admission records both requested and resolved effort. Provider-reported reasoning tokens remain a separate `reasoning_token` usage bucket; hidden reasoning text is never stored or exposed.

## Expected behavior and evidence limits

Higher effort can increase latency and reasoning-token cost. Changing effort can also invalidate prompt-cache reuse, which is why the phase-0.5 control is stable for the life of a conversation. The Activity panel continues to show only allow-listed summaries and actions, never hidden chain-of-thought.

This record qualifies the documented request/response contract and the local gateway behavior. It does not claim a live Anthropic account smoke test or comparative latency/cost benchmark; those require an explicitly provisioned direct Anthropic route and provider credentials.
