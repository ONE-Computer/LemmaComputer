# Pinned provider-rate catalogue

The pinned rate catalogue turns a concrete provider deployment into an exact
`RateCardInput` without network access. It is deliberately narrow: cataloguing
a provider model is a reviewed product change, not a best-effort price lookup.

## Current catalogue

Release `onecomputer-product-rates-2026-07-31.1` is effective from
`2026-07-31T00:00:00.000Z` and contains the repository-approved
`claude-sonnet-4-5-global` Bedrock profile:

- provider: `bedrock`
- base model:
  `bedrock/converse/global.anthropic.claude-sonnet-4-5-20250929-v1:0`
- regions: `us-east-1`, `us-west-2`, `eu-west-1`, `ap-southeast-1`
- service tier: `standard`
- currency: `USD`
- uncached input: `3.000000000000` per `1000000` tokens
- output: `15.000000000000` per `1000000` tokens
- reasoning: `15.000000000000` per `1000000` tokens
- request: an explicit `0.000000000000` per request

These values translate the product-owned pricing contract in
`@onecomputer/contracts`. The catalogue fails during module initialization if
that contract changes without a reviewed catalogue release. Its canonical
manifest SHA-256 is
`209e32a40ce129ea93d1ea5d5e423b9840eb0e9c6c7668d6b095b122870f3b61`.
Each materialized card carries the release, source version, source hash, and
effective timestamp needed to explain its price.

The product contract does not define cache-read or cache-write prices. The
catalogue does not create zero rates for them. A usage event containing either
bucket is therefore `incomplete` and has no computed provider total until a
reviewed catalogue release adds those rates.

OpenAI, direct Anthropic, GLM, fictional future IDs, unsupported regions, and
unsupported service tiers return an explicit `unsupported` result. They remain
unpriced; hard-budget admission must fail closed rather than substitute a rate.

## Control integration

After provider configuration has produced its stable deployment descriptor,
Control should call:

```ts
const result = pinnedRateCardForDeployment({
  tenantId,
  provider: modelInfo.provider,
  providerAccountId: modelInfo.providerAccountId,
  baseModel: modelInfo.baseModel,
  deploymentId: modelInfo.deploymentId,
  region: modelInfo.region,
  providerServiceTier: modelInfo.providerServiceTier,
});
```

For `supported`, Control must ensure the card exists idempotently using the
tenant, full concrete deployment dimensions, effective time, and source hash
before invoking the ledger's `createRateCard`. It must not blindly insert a
duplicate on every startup. For `unsupported`, Control should preserve the
reason in operational diagnostics and leave the deployment unpriced.

The catalogue is packaged code and performs no egress. A new price, provider,
model, region, tier, currency, or effective interval requires a new release
entry and tests. Never update an effective historical entry in place.
