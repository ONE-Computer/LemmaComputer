const TEXT_TOKEN_UNITS = [
  "input_uncached_token",
  "cache_read_token",
  "cache_write_token",
  "output_token",
  "reasoning_token",
];

export const AI_EMISSIONS_METHOD = Object.freeze({
  version: "operational-token-v1",
  energyKwhPerMillionTextTokens: 0.4,
  energyMethodologyUrl: "https://www.microsoft.com/en-us/research/publication/energy-use-of-ai-inference-efficiency-pathways-and-test-time-scaling/",
  regions: Object.freeze({
    us: Object.freeze({
      label: "United States · national grid average",
      kgCo2ePerKwh: 0.349667,
      sourceUrl: "https://www.epa.gov/egrid/summary-data",
    }),
    sg: Object.freeze({
      label: "Singapore · national grid average",
      kgCo2ePerKwh: 0.402,
      sourceUrl: "https://www.ema.gov.sg/resources/singapore-energy-statistics/chapter2",
    }),
  }),
});

export const emissionsRegionOptions = Object.entries(AI_EMISSIONS_METHOD.regions)
  .map(([value, region]) => ({ value, label: region.label }));

const finiteNumber = (value) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const textTokenTotal = (usage = {}) => Math.max(0, TEXT_TOKEN_UNITS
  .reduce((sum, unit) => sum + finiteNumber(usage[unit]), 0));

const estimatePeriod = (report, providers) => {
  const configuredRegions = new Map((providers ?? [])
    .filter((provider) => AI_EMISSIONS_METHOD.regions[provider.emissionsRegion])
    .map((provider) => [provider.provider, provider.emissionsRegion]));
  if (!configuredRegions.size) return null;

  const totalTokens = textTokenTotal(report?.totals?.usage);
  let coveredTokens = 0;
  let amountKgCo2e = 0;
  const regionTokens = {};

  for (const row of report?.breakdowns?.resolvedModels ?? []) {
    const emissionsRegion = configuredRegions.get(row.provider);
    if (!emissionsRegion) continue;
    const tokens = textTokenTotal(row.usage);
    const region = AI_EMISSIONS_METHOD.regions[emissionsRegion];
    coveredTokens += tokens;
    regionTokens[emissionsRegion] = (regionTokens[emissionsRegion] ?? 0) + tokens;
    amountKgCo2e += (tokens / 1_000_000)
      * AI_EMISSIONS_METHOD.energyKwhPerMillionTextTokens
      * region.kgCo2ePerKwh;
  }

  return {
    amountKgCo2e: Math.max(0, amountKgCo2e),
    amountTco2e: Math.max(0, amountKgCo2e) / 1_000,
    coveragePercent: totalTokens > 0
      ? Math.min(100, Math.round((coveredTokens / totalTokens) * 100))
      : 100,
    coveredTokens,
    totalTokens,
    regionTokens,
  };
};

export const estimateAiTokenEmissions = (report, priorReport, providers) => {
  const current = estimatePeriod(report, providers);
  if (!current) return null;
  const prior = estimatePeriod(priorReport, providers);
  const changePercent = prior?.amountKgCo2e > 0
    ? Math.round(((current.amountKgCo2e - prior.amountKgCo2e) / prior.amountKgCo2e) * 100)
    : null;
  return {
    ...current,
    changePercent,
    methodologyVersion: AI_EMISSIONS_METHOD.version,
    energyKwhPerMillionTextTokens: AI_EMISSIONS_METHOD.energyKwhPerMillionTextTokens,
    methodologyUrl: AI_EMISSIONS_METHOD.energyMethodologyUrl,
    regionSources: Object.entries(current.regionTokens).map(([region, tokens]) => ({
      region,
      tokens,
      label: AI_EMISSIONS_METHOD.regions[region].label,
      sourceUrl: AI_EMISSIONS_METHOD.regions[region].sourceUrl,
    })),
  };
};
