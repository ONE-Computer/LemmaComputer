# AI token operational-emissions estimate

Method version: `operational-token-v1`

This estimate is a deliberately rough operational proxy for dashboard reporting. It is not a product carbon footprint, provider-specific life-cycle assessment, or assurance-ready inventory by itself.

## Formula

For each provider whose administrator has selected an estimated serving grid:

```text
kgCO2e = text_tokens / 1,000,000
         × 0.4 kWh per 1,000,000 text tokens
         × grid_factor_kgCO2e_per_kWh
```

The dashboard calculates each provider separately and then adds the results. It does not extrapolate tokens from providers without a configured grid. Coverage is:

```text
coverage_percent = tokens_with_configured_grid / all_text_tokens × 100
```

Text tokens are the ledger's non-diagnostic `input_uncached_token`, `cache_read_token`, `cache_write_token`, `output_token`, and `reasoning_token` quantities. Image, audio, request, character, and duration units are excluded from this version.

Administrators choose the estimated serving grid under **AI control plane →
Models & providers**. Overview shows the result only when at least one
configured provider has a supported grid selection; its details dialog exposes
the method version, energy factor, regional factors, coverage, and source
links. Changing the selection changes the accounting assumption only. It does
not route traffic or assert a provider's physical serving location.

## Factors

| Estimated serving grid | Grid factor | Result per million text tokens |
| --- | ---: | ---: |
| United States, national average | 0.349667 kgCO2e/kWh | 0.139867 kgCO2e |
| Singapore, national average | 0.402 kgCO2/kWh | 0.160800 kgCO2e (dashboard proxy) |

The energy factor is rounded from the Microsoft Research median of 0.31 Wh for a workload with 500 input and 300 output tokens: `0.31 Wh / 800 × 1,000,000 / 1,000 ≈ 0.3875 kWh per million tokens`, rounded to `0.4`. The study's system boundary includes full-node energy and datacenter overhead through PUE.

Primary sources:

- [Microsoft Research, Energy Use of AI Inference](https://www.microsoft.com/en-us/research/publication/energy-use-of-ai-inference-efficiency-pathways-and-test-time-scaling/)
- [US EPA eGRID summary data](https://www.epa.gov/egrid/summary-data): 2023 US average CO2e output rate of 770.884 lb/MWh, converted to 0.349667 kg/kWh.
- [Singapore Energy Market Authority, Singapore Energy Statistics](https://www.ema.gov.sg/resources/singapore-energy-statistics/chapter2): 2024 grid emission factor of 0.402 kg CO2/kWh.

## Reporting boundary and caveats

- The selected grid is an accounting assumption. It does not control or guarantee a provider's physical inference location.
- The estimate covers inference electricity only. It excludes model training, embodied hardware, networking outside the study boundary, storage, employee devices, and other life-cycle impacts.
- A flat blended factor hides large variation by model, hardware, batching, prompt/output mix, cache behavior, and provider efficiency.
- For a customer buying cloud or AI services, operational emissions may be a Scope 3 Category 1 candidate. The organization's sustainability or assurance owner must confirm its GHG Protocol boundary.
- Preserve the method version, report period, token coverage, provider grid selections, and source factors with any exported ESG number.
