import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_EMISSIONS_METHOD,
  estimateAiTokenEmissions,
  textTokenTotal,
} from "../apps/web/src/ai-emissions.js";

const usage = (quantity: number) => ({
  input_uncached_token: String(quantity),
  cache_read_token: "0",
  cache_write_token: "0",
  output_token: "0",
  reasoning_token: "0",
});

const report = (openAiTokens: number, anthropicTokens: number, unknownTokens = 0) => ({
  totals: {
    usage: usage(openAiTokens + anthropicTokens + unknownTokens),
  },
  breakdowns: {
    resolvedModels: [
      { provider: "openai", usage: usage(openAiTokens) },
      { provider: "anthropic", usage: usage(anthropicTokens) },
      ...(unknownTokens ? [{ provider: "unknown", usage: usage(unknownTokens) }] : []),
    ],
  },
});

test("text-token emissions use the blended energy factor and provider grid mix", () => {
  const providers = [
    { provider: "openai", emissionsRegion: "us" },
    { provider: "anthropic", emissionsRegion: "sg" },
  ];
  const estimate = estimateAiTokenEmissions(
    report(1_000_000, 1_000_000),
    report(500_000, 500_000),
    providers,
  );

  assert.ok(estimate);
  const expectedKg = AI_EMISSIONS_METHOD.energyKwhPerMillionTextTokens
    * (AI_EMISSIONS_METHOD.regions.us.kgCo2ePerKwh + AI_EMISSIONS_METHOD.regions.sg.kgCo2ePerKwh);
  assert.ok(Math.abs(estimate.amountKgCo2e - expectedKg) < 1e-12);
  assert.equal(estimate.coveragePercent, 100);
  assert.equal(estimate.changePercent, 100);
  assert.deepEqual(estimate.regionTokens, { us: 1_000_000, sg: 1_000_000 });
});

test("emissions coverage excludes tokens whose provider has no accounting region", () => {
  const estimate = estimateAiTokenEmissions(
    report(1_000_000, 0, 1_000_000),
    null,
    [{ provider: "openai", emissionsRegion: "us" }],
  );

  assert.ok(estimate);
  assert.equal(estimate.coveragePercent, 50);
  assert.equal(estimate.coveredTokens, 1_000_000);
  assert.equal(estimate.totalTokens, 2_000_000);
  assert.equal(estimate.changePercent, null);
  assert.equal(
    estimate.amountKgCo2e,
    AI_EMISSIONS_METHOD.energyKwhPerMillionTextTokens * AI_EMISSIONS_METHOD.regions.us.kgCo2ePerKwh,
  );
});

test("token accounting counts billed text categories and ignores non-text units", () => {
  assert.equal(textTokenTotal({
    input_uncached_token: "10",
    cache_read_token: "20",
    cache_write_token: "30",
    output_token: "40",
    reasoning_token: "50",
    image: "999",
    request: "999",
  }), 150);
  assert.equal(estimateAiTokenEmissions(report(1, 0), null, []), null);
});
