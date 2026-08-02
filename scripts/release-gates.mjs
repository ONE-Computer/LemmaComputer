export const releaseAttestationSchemaVersion = 3;

export const requiredReleaseGates = Object.freeze([
  "pinned-litellm-provider-settings-qualification",
  "pinned-litellm-oauth-renewal-qualification",
  "verify:quick",
  "verify:db",
  "isolated-compose-smoke",
  "workspace-image-build",
  "hermes-workspace-readiness-smoke",
]);
