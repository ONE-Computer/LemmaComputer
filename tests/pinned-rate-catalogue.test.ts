import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  pinnedRateCardForDeployment,
  pinnedRateCatalogueEvidence,
  priceUsage,
} from "@lemmacomputer/workspace-store";

const baseDeployment = {
  tenantId: "tenant-1",
  provider: "bedrock",
  providerAccountId: "credential-prod-bedrock",
  baseModel: "bedrock/converse/global.anthropic.claude-sonnet-4-5-20250929-v1:0",
  deploymentId: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
  region: "ap-southeast-1",
  providerServiceTier: "standard",
};

test("materializes an exact USD card for every approved Bedrock region", () => {
  for (const region of ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"]) {
    const result = pinnedRateCardForDeployment({ ...baseDeployment, region });
    assert.equal(result.status, "supported");
    if (result.status !== "supported") continue;

    assert.deepEqual(
      {
        tenantId: result.card.tenantId,
        providerAccountId: result.card.providerAccountId,
        deploymentId: result.card.deploymentId,
        region: result.card.region,
        currency: result.card.currency,
        source: result.card.source,
        sourceVersion: result.card.sourceVersion,
        sourceHash: result.card.sourceHash,
        catalogueRelease: result.card.catalogueRelease,
        effectiveFrom: result.card.effectiveFrom.toISOString(),
      },
      {
        tenantId: "tenant-1",
        providerAccountId: "credential-prod-bedrock",
        deploymentId: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
        region,
        currency: "USD",
        source: "pinned_catalogue",
        sourceVersion: pinnedRateCatalogueEvidence.sourceVersion,
        sourceHash: pinnedRateCatalogueEvidence.sourceHash,
        catalogueRelease: pinnedRateCatalogueEvidence.catalogueRelease,
        effectiveFrom: pinnedRateCatalogueEvidence.effectiveFrom,
      },
    );
    assert.deepEqual(result.card.rates, [
      { unit: "input_uncached_token", amountPerUnit: "3.000000000000", unitScale: "1000000" },
      { unit: "output_token", amountPerUnit: "15.000000000000", unitScale: "1000000" },
      { unit: "reasoning_token", amountPerUnit: "15.000000000000", unitScale: "1000000" },
      { unit: "request", amountPerUnit: "0.000000000000", unitScale: "1" },
    ]);
  }
});

test("prices input, output, reasoning, and the explicit zero request rate exactly", () => {
  const result = pinnedRateCardForDeployment(baseDeployment);
  assert.equal(result.status, "supported");
  if (result.status !== "supported") return;

  assert.deepEqual(priceUsage([
    { unit: "input_uncached_token", quantity: "1000000" },
    { unit: "output_token", quantity: "1000000" },
    { unit: "reasoning_token", quantity: "1000000" },
    { unit: "request", quantity: "1" },
  ], result.card.rates), {
    providerCost: "33.000000000000",
    priceStatus: "priced",
    buckets: [
      { unit: "input_uncached_token", quantity: "1000000", rateAmountPerUnit: "3.000000000000", rateUnitScale: "1000000", bucketCost: "3.000000000000" },
      { unit: "output_token", quantity: "1000000", rateAmountPerUnit: "15.000000000000", rateUnitScale: "1000000", bucketCost: "15.000000000000" },
      { unit: "reasoning_token", quantity: "1000000", rateAmountPerUnit: "15.000000000000", rateUnitScale: "1000000", bucketCost: "15.000000000000" },
      { unit: "request", quantity: "1", rateAmountPerUnit: "0.000000000000", rateUnitScale: "1", bucketCost: "0.000000000000" },
    ],
  });
});

test("does not invent unavailable cache rates", () => {
  const result = pinnedRateCardForDeployment(baseDeployment);
  assert.equal(result.status, "supported");
  if (result.status !== "supported") return;

  const priced = priceUsage([
    { unit: "input_uncached_token", quantity: "1000000" },
    { unit: "cache_read_token", quantity: "1000000" },
  ], result.card.rates);

  assert.equal(priced.priceStatus, "incomplete");
  assert.equal(priced.providerCost, null);
  assert.equal(priced.buckets[1]?.rateAmountPerUnit, null);
});

test("returns explicit unsupported outcomes for uncatalogued providers and fictional model IDs", () => {
  const cases = [
    [{ ...baseDeployment, provider: "openai", baseModel: "gpt-5.6-luna" }, "provider_not_catalogued"],
    [{ ...baseDeployment, provider: "anthropic", baseModel: "claude-opus-future" }, "provider_not_catalogued"],
    [{ ...baseDeployment, provider: "glm", baseModel: "glm-future" }, "provider_not_catalogued"],
    [{ ...baseDeployment, baseModel: "bedrock/converse/future-model" }, "model_not_catalogued"],
    [{ ...baseDeployment, region: "moon-1" }, "region_not_catalogued"],
    [{ ...baseDeployment, providerServiceTier: "priority" }, "service_tier_not_catalogued"],
  ] as const;

  for (const [deployment, reason] of cases) {
    assert.deepEqual(pinnedRateCardForDeployment(deployment), {
      status: "unsupported",
      reason,
      evidence: pinnedRateCatalogueEvidence,
    });
  }
});

test("rejects incomplete concrete deployment identities", () => {
  for (const field of ["tenantId", "providerAccountId", "deploymentId"] as const) {
    assert.throws(
      () => pinnedRateCardForDeployment({ ...baseDeployment, [field]: " " }),
      new RegExp(`${field} is required`),
    );
  }
});

test("catalogue evidence is fixed, hashed, and implemented without egress", async () => {
  assert.deepEqual(
    {
      catalogueRelease: pinnedRateCatalogueEvidence.catalogueRelease,
      sourceVersion: pinnedRateCatalogueEvidence.sourceVersion,
      effectiveFrom: pinnedRateCatalogueEvidence.effectiveFrom,
    },
    {
      catalogueRelease: "lemmacomputer-product-rates-2026-07-31.1",
      sourceVersion: "lemmacomputer-product-rates-2026-07-31.1",
      effectiveFrom: "2026-07-31T00:00:00.000Z",
    },
  );
  assert.equal(
    pinnedRateCatalogueEvidence.sourceHash,
    "48fa211ad9a802d54c06ac6c8782624a78ce855e1cbb3fdf5e9d84b26ac6128b",
  );

  const source = await readFile(
    new URL("../packages/workspace-store/src/pinned-rate-catalogue.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bfetch\s*\(|https?:\/\/|node:https|node:http/);
});
