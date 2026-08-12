import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { releaseAttestationSchemaVersion, requiredReleaseGates } from "../scripts/release-gates.mjs";

test("release attestation requires an isolated built Hermes workspace readiness smoke", async () => {
  const [verifyRelease, releaseTag, qualifier, workspaceDockerfile] = await Promise.all([
    readFile("scripts/verify-release.mjs", "utf8"),
    readFile("scripts/release-tag.mjs", "utf8"),
    readFile("scripts/qualify-workspace-startup.mts", "utf8"),
    readFile("docker/Dockerfile.workspace", "utf8"),
  ]);

  assert.equal(releaseAttestationSchemaVersion, 3);
  assert.deepEqual(requiredReleaseGates.slice(-2), [
    "workspace-image-build",
    "hermes-workspace-readiness-smoke",
  ]);
  assert.match(verifyRelease, /Release verification requires an isolated worktree/);
  const renderServiceEnvironment = verifyRelease.indexOf('run(process.execPath, ["scripts/render-service-env.mjs"])');
  const firstComposeInvocation = verifyRelease.indexOf('run("docker", ["compose"');
  assert.ok(renderServiceEnvironment >= 0, "release verification must render its ignored service environment files");
  assert.ok(renderServiceEnvironment < firstComposeInvocation, "release verification must render service environments before Compose");
  assert.match(verifyRelease, /"--profile", "build", "build", "workspace-image"/);
  assert.match(verifyRelease, /"compose", "exec", "-T", "control-api"/);
  assert.match(verifyRelease, /"node", "--import", "tsx", "-"/);
  assert.match(verifyRelease, /input: await readFile\(qualifier\)/);
  assert.match(verifyRelease, /stdio: \["pipe", "inherit", "inherit"\]/);
  assert.match(workspaceDockerfile, /workspace-ready[\s\S]+\/dev\/tcp\/127\.0\.0\.1\/6901/);
  assert.match(
    workspaceDockerfile,
    /HEALTHCHECK --interval=5s --timeout=2s --start-period=15s --start-interval=1s --retries=12/,
    "workspace readiness must probe quickly during startup without increasing the steady-state cadence",
  );
  for (const port of [4312, 4314, 4315, 4316, 4317]) {
    assert.ok(
      workspaceDockerfile.includes(`http://127.0.0.1:${port}/healthz`),
      `workspace health must surface terminal authorization failure from broker ${port}`,
    );
  }
  assert.match(releaseTag, /requiredReleaseGates\.some/);
  assert.match(qualifier, /agentProfile: "hermes-claw-managed-v1"/);
  assert.match(qualifier, /chatRuntimes: \[\{/);
  assert.match(qualifier, /AgentBridgeAuthority\(agentBridgeSecret\)/);
  assert.match(qualifier, /new LiteLLMGatewayAdapter\(\{/);
  assert.match(qualifier, /gateway\.ensureGrant\(\{ workspaceId, accessGeneration: 1, identity, agentId, policy \}\)/);
  assert.match(qualifier, /workspaceId,\s+accessGeneration: 1,\s+correlationId/);
  assert.match(qualifier, /http:\/\/lemmacomputer-sandbox-\$\{workspaceId\}:8642\/health/);
  assert.match(qualifier, /hermesHealth\?\.connectors !== "ready"/);
  assert.match(qualifier, /gateway\.revoke\(workspaceId, agentId\)/);
  assert.match(qualifier, /status\?\.state !== "ready"/);
  assert.match(qualifier, /method: "DELETE"/);
  assert.match(qualifier, /\/internal\/v1\/workspaces\/\$\{workspaceId\}\/storage/);
});

test("OAuth release qualification explicitly reviews discovered connector tools", async () => {
  const qualifier = await readFile("scripts/qualify-oauth-renewal.mts", "utf8");
  assert.match(qualifier, /connectorToolPolicy\(alpha, "oauth-qualification"\)/);
  assert.match(qualifier, /saveConnectorToolPolicy\([\s\S]+fixtureReview\.documentHash/);
  assert.match(qualifier, /executeGovernedTool\(\{[\s\S]+accessGeneration: 1,/);
});

test("release verification executes the pinned remote MCP egress qualification", async () => {
  const [verifyRelease, packageDocument, qualifier] = await Promise.all([
    readFile("scripts/verify-release.mjs", "utf8"),
    readFile("package.json", "utf8"),
    readFile("scripts/qualify-mcp-egress.mjs", "utf8"),
  ]);
  assert.ok(requiredReleaseGates.includes("pinned-litellm-remote-mcp-egress-qualification"));
  assert.match(verifyRelease, /run\("npm", \["run", "qualify:mcp-egress"\]\)/);
  assert.match(packageDocument, /"qualify:mcp-egress": "node scripts\/qualify-mcp-egress\.mjs"/);
  assert.match(qualifier, /"--network", "none"/);
  assert.match(qualifier, /tests\/litellm-remote-mcp-egress\.py/);
});
