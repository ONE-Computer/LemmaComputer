const providerConfigurationCodes = new Set([
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_SETTINGS_NOT_CONFIGURED",
]);

const modelRouteConfigurationCodes = new Set([
  "MODEL_NOT_ASSIGNED",
  "MODEL_TIER_ROUTE_UNAVAILABLE",
  "NO_ELIGIBLE_DEPLOYMENT",
]);

const pricingConfigurationCodes = new Set([
  "MODEL_TIER_PRICING_UNAVAILABLE",
]);

const recoveryByKind = Object.freeze({
  provider: Object.freeze({
    message: "A model provider has not been connected for this workspace.",
    action: "Set up a workspace provider",
    contact: "Contact your administrator to connect one.",
    href: "?view=ai-control-plane&section=models-providers&focus=provider",
    permission: "provider",
  }),
  modelRoute: Object.freeze({
    message: "No model route is ready for this workspace.",
    action: "Configure model routes",
    contact: "Contact your administrator to configure one.",
    href: "?view=ai-control-plane&section=models-providers&focus=route",
    permission: "modelRoutes",
  }),
  pricing: Object.freeze({
    message: "Approved pricing is missing for this workspace's model route.",
    action: "Set up pricing",
    contact: "Contact your administrator to add it.",
    href: "?view=ai-control-plane&section=models-providers&focus=pricing",
    permission: "pricing",
  }),
});

const errorCode = (error) => typeof error === "object" && error !== null && typeof error.code === "string"
  ? error.code
  : "";

export const errorMessage = (error) => typeof error === "string"
  ? error
  : typeof error?.message === "string"
    ? error.message
    : "LemmaComputer could not complete the request.";

export const configurationRecoveryFor = (error) => {
  const code = errorCode(error);
  if (providerConfigurationCodes.has(code)) return recoveryByKind.provider;
  if (code === "NO_ELIGIBLE_DEPLOYMENT" && errorMessage(error) === "No policy-approved, priced deployment satisfies the request") {
    return recoveryByKind.pricing;
  }
  if (modelRouteConfigurationCodes.has(code)) return recoveryByKind.modelRoute;
  if (pricingConfigurationCodes.has(code)) return recoveryByKind.pricing;

  // AI SDK transports expose the safe server message but do not retain the
  // structured API error code. Keep these fallbacks exact and narrow so a
  // transient provider outage is never mislabeled as missing configuration.
  const message = errorMessage(error);
  if (message === "That provider is not configured" || message === "Provider settings are not configured") {
    return recoveryByKind.provider;
  }
  if (
    message === "That model route is not assigned by your organization"
    || message === "The selected model route is not assigned by the active policy"
    || message === "The active policy has AI agents but no supported model route"
    || message === "No ready route is available for that model tier"
    || message === "No policy-approved deployment satisfies the request"
  ) {
    return recoveryByKind.modelRoute;
  }
  if (
    message === "Pricing is not ready for that model tier"
    || message === "No policy-approved, priced deployment satisfies the request"
  ) return recoveryByKind.pricing;
  return null;
};
