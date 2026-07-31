import { createHash } from "node:crypto";
import { approvedBedrockApiKeyModelProfiles } from "@onecomputer/contracts";
import type { RateAmount, RateCardInput } from "./usage-ledger.js";

const PRODUCT_PROFILE_ID = "claude-sonnet-4-5-global";
const CATALOGUE_RELEASE = "onecomputer-product-rates-2026-07-31.1";
const EFFECTIVE_FROM = "2026-07-31T00:00:00.000Z";
const SERVICE_TIER = "standard";

const productProfile = approvedBedrockApiKeyModelProfiles.find(
  (candidate) => candidate.id === PRODUCT_PROFILE_ID,
);

if (!productProfile) {
  throw new Error(`Missing approved product model profile: ${PRODUCT_PROFILE_ID}`);
}

// The product contract is token-only. The zero request rate is therefore
// explicit catalogue data, not a fallback for an absent provider price.
const BEDROCK_SONNET_RATES = [
  { unit: "input_uncached_token", amountPerUnit: "3.000000000000", unitScale: "1000000" },
  { unit: "output_token", amountPerUnit: "15.000000000000", unitScale: "1000000" },
  { unit: "reasoning_token", amountPerUnit: "15.000000000000", unitScale: "1000000" },
  { unit: "request", amountPerUnit: "0.000000000000", unitScale: "1" },
] satisfies RateAmount[];

if (
  productProfile.pricing.inputUsdPerMillionTokens !== 3
  || productProfile.pricing.outputUsdPerMillionTokens !== 15
) {
  throw new Error(
    `Pinned rate catalogue is stale for approved product model profile: ${PRODUCT_PROFILE_ID}`,
  );
}

const manifest = {
  catalogueRelease: CATALOGUE_RELEASE,
  currency: "USD",
  effectiveFrom: EFFECTIVE_FROM,
  entries: [{
    provider: "bedrock",
    productProfileId: PRODUCT_PROFILE_ID,
    baseModel: productProfile.litellmModel,
    regions: [...productProfile.regions],
    providerServiceTier: SERVICE_TIER,
    rates: BEDROCK_SONNET_RATES,
    pricingContract: {
      inputUsdPerMillionTokens: productProfile.pricing.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: productProfile.pricing.outputUsdPerMillionTokens,
      reasoningUsesOutputTokenRate: true,
      requestRateIsExplicitlyZero: true,
      cacheRatesAvailable: false,
    },
  }],
} as const;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const SOURCE_HASH = createHash("sha256")
  .update(canonicalJson(manifest))
  .digest("hex");

export const pinnedRateCatalogueEvidence = Object.freeze({
  catalogueRelease: CATALOGUE_RELEASE,
  sourceVersion: CATALOGUE_RELEASE,
  sourceHash: SOURCE_HASH,
  effectiveFrom: EFFECTIVE_FROM,
});

export type PinnedRateCardDeployment = {
  tenantId: string;
  provider: string;
  providerAccountId: string;
  baseModel: string;
  deploymentId: string;
  region?: string;
  providerServiceTier?: string;
};

export type UnsupportedPinnedRateReason =
  | "provider_not_catalogued"
  | "model_not_catalogued"
  | "region_not_catalogued"
  | "service_tier_not_catalogued";

export type PinnedRateCardLookup =
  | {
    status: "supported";
    card: RateCardInput;
    evidence: typeof pinnedRateCatalogueEvidence;
  }
  | {
    status: "unsupported";
    reason: UnsupportedPinnedRateReason;
    evidence: typeof pinnedRateCatalogueEvidence;
  };

const requiredIdentity = (value: string, field: string): string => {
  if (value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
};

/**
 * Materialize an immutable-input rate card for one concrete provider
 * deployment. This function performs no network I/O and never guesses a rate.
 */
export const pinnedRateCardForDeployment = (
  deployment: PinnedRateCardDeployment,
): PinnedRateCardLookup => {
  requiredIdentity(deployment.tenantId, "tenantId");
  requiredIdentity(deployment.providerAccountId, "providerAccountId");
  requiredIdentity(deployment.deploymentId, "deploymentId");

  const evidence = pinnedRateCatalogueEvidence;
  if (deployment.provider !== "bedrock") {
    return { status: "unsupported", reason: "provider_not_catalogued", evidence };
  }
  if (deployment.baseModel !== productProfile.litellmModel) {
    return { status: "unsupported", reason: "model_not_catalogued", evidence };
  }
  if (
    !deployment.region
    || !(productProfile.regions as readonly string[]).includes(deployment.region)
  ) {
    return { status: "unsupported", reason: "region_not_catalogued", evidence };
  }
  if (deployment.providerServiceTier !== SERVICE_TIER) {
    return { status: "unsupported", reason: "service_tier_not_catalogued", evidence };
  }

  return {
    status: "supported",
    evidence,
    card: {
      tenantId: deployment.tenantId,
      provider: deployment.provider,
      providerAccountId: deployment.providerAccountId,
      baseModel: deployment.baseModel,
      deploymentId: deployment.deploymentId,
      region: deployment.region,
      providerServiceTier: deployment.providerServiceTier,
      currency: "USD",
      source: "pinned_catalogue",
      sourceVersion: evidence.sourceVersion,
      sourceHash: evidence.sourceHash,
      catalogueRelease: evidence.catalogueRelease,
      effectiveFrom: new Date(evidence.effectiveFrom),
      rates: BEDROCK_SONNET_RATES.map((rate) => ({ ...rate })),
    },
  };
};
