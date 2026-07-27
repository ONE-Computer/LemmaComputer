import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Telegram credential authority exists only in the trusted channel broker", async () => {
  const [compose, entrypoint, kasm, controller, contracts] = await Promise.all([
    source("compose.yaml"),
    source("docker/workspace/onecomputer-workspace-entrypoint.sh"),
    source("packages/kasm-adapter/src/index.ts"),
    source("apps/workspace-controller/src/server.ts"),
    source("packages/contracts/src/index.ts"),
  ]);
  const broker = compose.slice(compose.indexOf("  channel-broker:"), compose.indexOf("  scheduler-worker:"));
  const control = compose.slice(compose.indexOf("  control-api:"), compose.indexOf("  channel-broker:"));
  const workspaceController = compose.slice(compose.indexOf("  workspace-controller:"), compose.indexOf("  control-api:"));

  assert.match(broker, /CHANNEL_CREDENTIAL_SECRET:/);
  assert.match(broker, /networks:\s+- control-private\s+- channel-egress/);
  assert.doesNotMatch(broker, /gateway-private|docker\.sock/);
  assert.doesNotMatch(control, /CHANNEL_CREDENTIAL_SECRET/);
  assert.doesNotMatch(workspaceController, /CHANNEL_CREDENTIAL_SECRET|CHANNEL_BROKER_INTERNAL_TOKEN/);
  assert.doesNotMatch(`${entrypoint}\n${kasm}\n${controller}`, /TELEGRAM_BOT_TOKEN|CHANNEL_CREDENTIAL_SECRET|credentialCiphertext/);
  assert.doesNotMatch(contracts, /controllerCreateSchema[\s\S]{0,2500}botToken/);
});
