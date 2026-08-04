import assert from "node:assert/strict";
import test from "node:test";
import { priceUsage, usageFingerprint } from "@lemmacomputer/workspace-store";

test("provider cost uses exact decimals and mutually exclusive cache/reasoning buckets", () => {
  const priced = priceUsage([
    { unit: "input_uncached_token", quantity: "900" },
    { unit: "cache_read_token", quantity: "100" },
    { unit: "output_token", quantity: "80" },
    { unit: "reasoning_token", quantity: "20" },
  ], [
    { unit: "input_uncached_token", amountPerUnit: "2.50", unitScale: "1000000" },
    { unit: "cache_read_token", amountPerUnit: "0.25", unitScale: "1000000" },
    { unit: "output_token", amountPerUnit: "10", unitScale: "1000000" },
    { unit: "reasoning_token", amountPerUnit: "10", unitScale: "1000000" },
  ]);
  assert.equal(priced.priceStatus, "priced");
  assert.equal(priced.providerCost, "0.003275000000");
  assert.deepEqual(priced.buckets.map((item) => item.bucketCost), ["0.002250000000","0.000025000000","0.000800000000","0.000200000000"]);
});

test("unknown and incomplete prices are never represented as zero", () => {
  assert.deepEqual(priceUsage([{ unit:"output_token", quantity:"1" }], []), {
    providerCost:null, priceStatus:"unknown",
    buckets:[{ unit:"output_token", quantity:"1", rateAmountPerUnit:null, rateUnitScale:null, bucketCost:null }],
  });
  const partial = priceUsage([{ unit:"input_uncached_token", quantity:"1" },{ unit:"output_token", quantity:"1" }], [{ unit:"input_uncached_token", amountPerUnit:"1", unitScale:"1" }]);
  assert.equal(partial.priceStatus, "incomplete");
  assert.equal(partial.providerCost, null);
});

test("diagnostic requests do not interfere with token-only pricing", () => {
  const priced = priceUsage([
    { unit:"input_uncached_token", quantity:"100" },
    { unit:"output_token", quantity:"20" },
    { unit:"request", quantity:"1", diagnostic:true },
  ], [
    { unit:"input_uncached_token", amountPerUnit:"2", unitScale:"1000" },
    { unit:"output_token", amountPerUnit:"5", unitScale:"1000" },
  ]);
  assert.equal(priced.priceStatus, "priced");
  assert.equal(priced.providerCost, "0.300000000000");
  assert.equal(priced.buckets.at(-1)?.bucketCost, null);

  const failedWithoutUsage = priceUsage([
    { unit:"request", quantity:"1", diagnostic:true },
  ], [
    { unit:"request", amountPerUnit:"0.01", unitScale:"1" },
  ]);
  assert.equal(failedWithoutUsage.priceStatus, "unknown");
  assert.equal(failedWithoutUsage.providerCost, null);

  const providerQualifiedRequest = priceUsage([
    { unit:"request", quantity:"1" },
  ], [
    { unit:"request", amountPerUnit:"0.01", unitScale:"1" },
  ]);
  assert.equal(providerQualifiedRequest.providerCost, "0.010000000000");
});

test("diagnostic provider totals cannot be charged", () => {
  const result = priceUsage([{ unit:"provider:total_tokens", quantity:"10", diagnostic:true }], [{ unit:"provider:total_tokens", amountPerUnit:"99", unitScale:"1" }]);
  assert.equal(result.providerCost, null);
  assert.equal(result.buckets[0]!.bucketCost, null);
});

test("canonical fingerprints are stable across object key order", () => {
  assert.equal(usageFingerprint({ b:2,a:1 }), usageFingerprint({ a:1,b:2 }));
  assert.notEqual(usageFingerprint({ a:1 }), usageFingerprint({ a:2 }));
});

test("duplicate and invalid units fail before costing", () => {
  assert.throws(() => priceUsage([
    { unit:"output_token", quantity:"1" }, { unit:"output_token", quantity:"1" },
  ], [{ unit:"output_token", amountPerUnit:"1", unitScale:"1" }]), /Duplicate usage unit/);
  assert.throws(() => priceUsage([
    { unit:"provider:bad space" as never, quantity:"1" },
  ], []), /Invalid usage unit/);
});

