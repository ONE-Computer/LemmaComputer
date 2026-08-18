import assert from "node:assert/strict";
import test from "node:test";
import { configurationRecoveryFor, errorMessage } from "../apps/web/src/configuration-recovery.js";

test("configuration recovery maps provider, model-route, and pricing codes to exact admin pages", () => {
  assert.deepEqual(configurationRecoveryFor({ code: "PROVIDER_NOT_CONFIGURED", message: "ignored" }), {
    message: "A model provider has not been connected for this workspace.",
    action: "Set up a workspace provider",
    contact: "Contact your administrator to connect one.",
    href: "?view=ai-control-plane&section=models-providers",
    permission: "provider",
  });
  assert.equal(
    configurationRecoveryFor({ code: "MODEL_TIER_ROUTE_UNAVAILABLE" })?.href,
    "?view=ai-control-plane&section=model-routes",
  );
  assert.equal(
    configurationRecoveryFor({ code: "MODEL_TIER_PRICING_UNAVAILABLE" })?.href,
    "?view=ai-control-plane&section=pricing",
  );
  assert.equal(
    configurationRecoveryFor({
      code: "NO_ELIGIBLE_DEPLOYMENT",
      message: "No policy-approved, priced deployment satisfies the request",
    })?.href,
    "?view=ai-control-plane&section=pricing",
  );
  assert.equal(
    configurationRecoveryFor({
      code: "NO_ELIGIBLE_DEPLOYMENT",
      message: "No policy-approved deployment satisfies the request",
    })?.href,
    "?view=ai-control-plane&section=model-routes",
  );
});

test("configuration recovery recognizes exact AI transport messages without relabeling outages", () => {
  assert.equal(configurationRecoveryFor("That provider is not configured")?.permission, "provider");
  assert.equal(configurationRecoveryFor("No ready route is available for that model tier")?.permission, "modelRoutes");
  assert.equal(configurationRecoveryFor("Pricing is not ready for that model tier")?.permission, "pricing");
  assert.equal(configurationRecoveryFor("No policy-approved, priced deployment satisfies the request")?.permission, "pricing");
  assert.equal(configurationRecoveryFor("That model tier is temporarily unavailable"), null);
  assert.equal(errorMessage({ message: "Original safe message" }), "Original safe message");
});
