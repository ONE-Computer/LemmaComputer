import {
  resolveDeploymentProfile,
  type DeploymentProfileCapabilities,
  type DeploymentProfileId,
} from "./index.mjs";

const selected: DeploymentProfileId = "customer-managed";
const capabilities: DeploymentProfileCapabilities = resolveDeploymentProfile(selected);
void capabilities.organizationCardinality;
