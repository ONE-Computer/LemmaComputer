import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { projectServiceEnvironment } from "../scripts/deployment-config.mjs";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Telegram credential authority exists only in the trusted channel broker", async () => {
  const [compose, hostedCompose, entrypoint, kasm, controller, contracts, web, vite, intakePaths, brokerServer] = await Promise.all([
    source("compose.yaml"),
    source("compose.hosted.yaml"),
    source("docker/workspace/lemmacomputer-workspace-entrypoint.sh"),
    source("packages/kasm-adapter/src/index.ts"),
    source("apps/workspace-controller/src/server.ts"),
    source("packages/contracts/src/index.ts"),
    source("apps/web/server.mjs"),
    source("apps/web/vite.config.mjs"),
    source("apps/web/telegram-intake-path.mjs"),
    source("apps/channel-broker/src/server.ts"),
  ]);
  const broker = compose.slice(compose.indexOf("  channel-broker:"), compose.indexOf("  scheduler-worker:"));
  const control = compose.slice(compose.indexOf("  control-api:"), compose.indexOf("  channel-broker:"));
  const workspaceController = compose.slice(compose.indexOf("  workspace-controller:"), compose.indexOf("  control-api:"));
  const projected = projectServiceEnvironment();
  const brokerEnvironment = projected["channel-broker"];
  const controlEnvironment = projected["control-api"];

  assert.match(broker, /env_file:\s+- path: \.runtime-env\/channel-broker\.env\s+format: raw/);
  assert.match(control, /env_file:\s+- path: \.runtime-env\/control-api\.env\s+format: raw/);
  assert.ok("CHANNEL_CREDENTIAL_SECRET" in brokerEnvironment);
  assert.ok("TELEGRAM_INTAKE_ENCRYPTION_PRIVATE_KEY_B64" in brokerEnvironment);
  assert.equal(brokerEnvironment.LEMMACOMPUTER_INSTALLATION_KIND, "customer-managed");
  assert.equal(controlEnvironment.LEMMACOMPUTER_INSTALLATION_KIND, "customer-managed");
  assert.match(hostedCompose, /services:\s*\{\}/);
  assert.match(broker, /networks:\s+- control-private\s+- web-edge\s+- channel-egress/);
  assert.doesNotMatch(broker, /gateway-private|docker\.sock/);
  assert.ok(!("CHANNEL_CREDENTIAL_SECRET" in controlEnvironment));
  assert.ok(!("TELEGRAM_INTAKE_ENCRYPTION_PRIVATE_KEY_B64" in controlEnvironment));
  assert.doesNotMatch(workspaceController, /CHANNEL_CREDENTIAL_SECRET|CHANNEL_BROKER_INTERNAL_TOKEN/);
  assert.doesNotMatch(`${entrypoint}\n${kasm}\n${controller}`, /TELEGRAM_BOT_TOKEN|CHANNEL_CREDENTIAL_SECRET|credentialCiphertext/);
  assert.doesNotMatch(contracts, /controllerCreateSchema[\s\S]{0,2500}botToken/);
  assert.match(intakePaths, /telegramTokenIntakePath = "\/api\/channel-intake\/v1\/telegram"/);
  assert.match(web, /rewriteTelegramTokenIntakePath/);
  assert.match(vite, /rewriteTelegramTokenIntakePath/);
  assert.match(intakePaths, /channelBrokerTelegramIntakePath = "\/public\/v1\/telegram\/intake"/);
  assert.match(brokerServer, /app\.post\("\/public\/v1\/telegram\/intake"/);
  assert.doesNotMatch(web, /proxyTelegramIntake[\s\S]{0,1200}\{ \.\.\.request\.headers/);
});
