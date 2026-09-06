export const providerTitle = (value) => ({
  openai: "OpenAI",
  anthropic: "Anthropic",
  glm: "Z.ai",
  bedrock: "Amazon Bedrock",
  foundry: "Azure AI Foundry",
  azure: "Azure AI Foundry",
  google: "Google",
  vertex: "Google Vertex AI",
}[value] ?? value);

const valueOf = (...values) => values.find((value) => typeof value === "string" && value.trim())?.trim() ?? "";

const modelCapabilities = (value) => {
  if (!value || typeof value !== "object") return null;
  const { vision, tools, streaming } = value;
  if (typeof vision !== "boolean" || typeof tools !== "boolean" || typeof streaming !== "boolean") return null;
  return { vision, tools, streaming };
};

export const providerModelCapabilityLabels = (capabilities) => {
  if (!capabilities) return [];
  return [
    capabilities.tools ? "Function tools" : null,
    capabilities.vision ? "Vision" : null,
    capabilities.streaming ? "Streaming" : null,
  ].filter(Boolean);
};

export const providerDeploymentKey = (deployment) => [
  deployment.provider,
  deployment.providerAccountId,
  deployment.providerModel,
  deployment.providerDeployment,
  deployment.region ?? "",
  deployment.providerServiceTier ?? "",
].join("\0");

export const configuredProviderDeployments = (providers = []) => providers
  .filter((provider) => provider.state === "active")
  .flatMap((provider) => {
    const deployments = Array.isArray(provider.deployments) ? provider.deployments : [];
    return deployments.map((deployment) => {
      const providerName = valueOf(deployment.provider, provider.provider);
      const providerAccountId = valueOf(deployment.providerAccountId, provider.providerAccountId);
      const providerModel = valueOf(deployment.providerModelId, deployment.baseModel, deployment.providerModel, deployment.modelId);
      const providerDeployment = valueOf(deployment.providerDeployment, deployment.deploymentId);
      const region = valueOf(deployment.region, provider.region) || null;
      const providerServiceTier = valueOf(deployment.providerServiceTier) || null;
      const displayName = valueOf(deployment.displayName, provider.upstreamModelDisplayName, providerModel);
      const declaredCapabilities = modelCapabilities(deployment.modelCapabilities);
      const normalized = {
        id: valueOf(deployment.id) || providerDeploymentKey({ provider: providerName, providerAccountId, providerModel, providerDeployment, region, providerServiceTier }),
        provider: providerName,
        providerAccountId,
        providerModel,
        providerDeployment,
        region,
        providerServiceTier,
        displayName,
        ...(deployment.metadata ? { metadata: deployment.metadata } : {}),
        ...(deployment.modelLimits ? { modelLimits: deployment.modelLimits } : {}),
        ...(declaredCapabilities ? { modelCapabilities: declaredCapabilities } : {}),
      };
      return normalized.provider && normalized.providerAccountId && normalized.providerModel && normalized.providerDeployment ? normalized : null;
    });
  })
  .filter(Boolean)
  .filter((deployment, index, all) => all.findIndex((candidate) => providerDeploymentKey(candidate) === providerDeploymentKey(deployment)) === index);

export const rateCardMatchesDeployment = (card, deployment) => card.provider === deployment.provider
  && card.providerAccountId === deployment.providerAccountId
  && card.baseModel === deployment.providerModel
  && card.deploymentId === deployment.providerDeployment
  && (card.region ?? null) === (deployment.region ?? null)
  && (card.providerServiceTier ?? null) === (deployment.providerServiceTier ?? null);

export const latestRateCardForDeployment = (rateCards, deployment) => rateCards.find((card) => rateCardMatchesDeployment(card, deployment)) ?? null;

export const providerDeploymentLabel = (deployment) => `${deployment.displayName} · ${providerTitle(deployment.provider)}`;
