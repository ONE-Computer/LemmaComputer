import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { releaseAttestationSchemaVersion, requiredReleaseGates } from "../scripts/release-gates.mjs";

test("release attestation requires an isolated built Hermes workspace readiness smoke", async () => {
  const [verifyRelease, releaseTag, qualifier] = await Promise.all([
    readFile("scripts/verify-release.mjs", "utf8"),
    readFile("scripts/release-tag.mjs", "utf8"),
    readFile("scripts/qualify-workspace-startup.mts", "utf8"),
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
  assert.match(verifyRelease, /"compose", "run", "--rm", "--no-deps"/);
  assert.match(verifyRelease, /qualify-workspace-startup\.mts:ro/);
  assert.match(releaseTag, /requiredReleaseGates\.some/);
  assert.match(qualifier, /agentProfile: "hermes-claw-managed-v1"/);
  assert.match(qualifier, /chatRuntimes: \[\{/);
  assert.match(qualifier, /AgentBridgeAuthority\(agentBridgeSecret\)/);
  assert.match(qualifier, /status\?\.state !== "ready"/);
  assert.match(qualifier, /method: "DELETE"/);
  assert.match(qualifier, /\/internal\/v1\/workspaces\/\$\{workspaceId\}\/storage/);
});
