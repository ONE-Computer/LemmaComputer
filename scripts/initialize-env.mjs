import { generateKeyPairSync, randomBytes } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import webPush from "web-push";

const destination = process.argv.find((argument) => argument.startsWith("--file="))?.slice("--file=".length) ?? ".env";
const force = process.argv.includes("--force");

if (!force && await access(destination).then(() => true).catch(() => false)) {
  throw new Error(`${destination} already exists; use --force only if replacing its local secrets is intentional`);
}

let contents = await readFile(".env.example", "utf8");
const randomSecret = () => randomBytes(32).toString("base64url");
const replace = (name, value) => {
  const expression = new RegExp(`^${name}=.*$`, "m");
  if (!expression.test(contents)) throw new Error(`${name} is missing from .env.example`);
  contents = contents.replace(expression, `${name}=${value}`);
};

for (const name of [
  "ONECOMPUTER_WEB_PROXY_TOKEN",
  "ONECOMPUTER_CONTROLLER_TOKEN",
  "ONECOMPUTER_POSTGRES_PASSWORD",
  "ONECOMPUTER_LITELLM_SALT_KEY",
  "ONECOMPUTER_LITELLM_CREDENTIAL_SECRET",
  "ONECOMPUTER_LITELLM_POSTGRES_PASSWORD",
  "ONECOMPUTER_LITELLM_UI_PASSWORD",
  "ONECOMPUTER_FIXTURE_APPROVAL_SECRET",
  "ONECOMPUTER_OPENVTC_CONSENT_TOKEN",
  "ONECOMPUTER_WEB_PUSH_SUBSCRIPTION_SECRET",
  "ONECOMPUTER_SESSION_SECRET",
  "ONECOMPUTER_WORKSPACE_INGRESS_SECRET",
  "ONECOMPUTER_EGRESS_GRANT_SECRET",
  "ONECOMPUTER_HERMES_API_SECRET",
  "ONECOMPUTER_CHANNEL_CREDENTIAL_SECRET",
  "ONECOMPUTER_CHANNEL_BROKER_TOKEN",
  "ONECOMPUTER_SCHEDULE_PROMPT_SECRET",
  "ONECOMPUTER_SCHEDULER_TOKEN",
]) replace(name, randomSecret());

replace("ONECOMPUTER_LITELLM_MASTER_KEY", `sk-${randomSecret()}`);
replace("ONECOMPUTER_OPENVTC_EXECUTOR_SEED_B64", randomBytes(32).toString("base64"));
replace("ONECOMPUTER_WORKSPACE_IMAGE", "onecomputer/workspace:dev");

const vapid = webPush.generateVAPIDKeys();
replace("ONECOMPUTER_WEB_PUSH_VAPID_PUBLIC_KEY", vapid.publicKey);
replace("ONECOMPUTER_WEB_PUSH_VAPID_PRIVATE_KEY", vapid.privateKey);

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keyId = `psk_policy_${new Date().toISOString().slice(0, 10).replaceAll("-", "_")}`;
const keySet = {
  profile: "onecomputer-policy-key-set/v1",
  keys: [{
    keyId,
    algorithm: "Ed25519",
    publicKeySpkiBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    status: "active",
    activatedAt: new Date().toISOString(),
    expiresAt: null,
  }],
};
replace("ONECOMPUTER_POLICY_SIGNING_KEY_ID", keyId);
replace(
  "ONECOMPUTER_POLICY_SIGNING_PRIVATE_KEY_B64",
  privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
);
replace(
  "ONECOMPUTER_POLICY_VERIFICATION_KEYS_B64",
  Buffer.from(JSON.stringify(keySet), "utf8").toString("base64"),
);

await writeFile(destination, contents, { mode: 0o600 });
process.stdout.write([
  `Created ${destination} with fresh local service, signing, and encryption secrets.`,
  "Configure the provider and Microsoft Entra values that remain marked as placeholders before starting the stack.",
  "",
].join("\n"));
