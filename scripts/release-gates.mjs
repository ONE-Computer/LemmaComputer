export const releaseAttestationSchemaVersion = 4;

export const requiredReleaseGates = Object.freeze([
  "pinned-litellm-provider-settings-qualification",
  "pinned-litellm-remote-mcp-egress-qualification",
  "pinned-litellm-oauth-renewal-qualification",
  "microsoft365-tool-contract-drift-qualification-v1",
  "verify:quick",
  "verify:db",
  "isolated-compose-smoke",
  "workspace-image-build",
  "hermes-workspace-readiness-smoke",
]);
