# Pinned provider-rate catalogue

The pinned rate catalogue turns a concrete provider deployment into an exact
`RateCardInput` without network access. It is deliberately narrow: cataloguing
a provider model is a reviewed product change, not a best-effort price lookup.

## Current catalogue

Release `lemmacomputer-product-rates-2026-07-31.1` is effective from
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
`@lemmacomputer/contracts`. The catalogue fails during module initialization if
that contract changes without a reviewed catalogue release. Its canonical
manifest SHA-256 is
`48fa211ad9a802d54c06ac6c8782624a78ce855e1cbb3fdf5e9d84b26ac6128b`.
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
Control's pre-dispatch budget path should call the ledger store:

```ts
const rateCard = await usageLedger.selectEffectiveRateCard({
  tenantId,
  provider: modelInfo.provider,
  providerAccountId: modelInfo.providerAccountId,
  baseModel: modelInfo.baseModel,
  deploymentId: modelInfo.deploymentId,
  region: modelInfo.region,
  providerServiceTier: modelInfo.providerServiceTier,
  at: new Date(),
});
```

The store preserves an effective contract override immediately. Otherwise, it
evaluates the local catalogue and, for a supported effective release, takes a
tenant-and-full-route advisory transaction lock, rechecks, materializes the
exact pinned card if necessary, and reselects. Concurrent first use therefore
creates one card. Current pinned releases supersede conservative and older
pinned cards; unsupported routes remain `null`. Historical lookups before the
catalogue entry's effective time do not back-price or materialize it.

Usage-event pricing uses the same lookup within the event transaction, so a
fresh installation is priced even if no pre-dispatch lookup ran first.
Callers must not insert catalogue cards directly on startup.

The catalogue is packaged code and performs no egress. A new price, provider,
model, region, tier, currency, or effective interval requires a new release
entry and tests. Never update an effective historical entry in place.
