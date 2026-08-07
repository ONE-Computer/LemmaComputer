import assert from "node:assert/strict";
import {
  projectServiceEnvironment,
  renderEnvironmentTemplate,
  validateDeploymentEnvironment,
} from "./deployment-config.mjs";
import {
  initializeEnvironment,
  parseEnvironment,
} from "./environment-template.mjs";

const requested = process.argv.find((argument) => argument.startsWith("--profile="))?.slice("--profile=".length);
const profiles = requested ? [requested] : ["customer-managed", "hosted"];
const supported = new Set(["customer-managed", "hosted"]);
for (const profile of profiles) {
  if (!supported.has(profile)) throw new Error("Profile smoke accepts only customer-managed or hosted");
}

const sharedImageTag = "profile-smoke-same-commit";
const baseEnvironment = () => Object.fromEntries(parseEnvironment(initializeEnvironment(
  renderEnvironmentTemplate(),
  "Etc/UTC",
)).values);

const environmentFor = (profile) => {
  const values = {
    ...baseEnvironment(),
    LEMMACOMPUTER_INSTALLATION_KIND: profile,
    LEMMACOMPUTER_IMAGE_TAG: sharedImageTag,
  };
  if (profile === "customer-managed") {
    return {
      ...values,
      LEMMACOMPUTER_ENTRA_TENANT_ID: "profile-smoke-customer-directory",
      LEMMACOMPUTER_ENTRA_CLIENT_ID: "profile-smoke-customer-client",
      LEMMACOMPUTER_ENTRA_CLIENT_SECRET: "profile-smoke-customer-secret",
    };
  }
  return {
    ...values,
    LEMMACOMPUTER_PUBLIC_WEB_URL: "https://profile-smoke.example.test",
    LEMMACOMPUTER_EXTERNAL_ID_TENANT_ID: "profile-smoke-external-directory",
    LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN: "profile-smoke",
    LEMMACOMPUTER_EXTERNAL_ID_CLIENT_ID: "profile-smoke-external-client",
    LEMMACOMPUTER_EXTERNAL_ID_CLIENT_SECRET: "profile-smoke-external-secret",
    LEMMACOMPUTER_SANDBOX_DRIVER: "kasm",
    LEMMACOMPUTER_KASM_BASE_URL: "https://workspace.profile-smoke.example.test",
    LEMMACOMPUTER_KASM_API_KEY: "profile-smoke-kasm-key",
    LEMMACOMPUTER_KASM_API_SECRET: "profile-smoke-kasm-secret",
    LEMMACOMPUTER_KASM_USER_ID: "profile-smoke-kasm-user",
    LEMMACOMPUTER_KASM_IMAGE_ID: "profile-smoke-kasm-image",
    LEMMACOMPUTER_LITELLM_ADMIN_URL: "https://litellm-admin-listener:8443",
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_CA_B64: "cHJvZmlsZS1zbW9rZQ==",
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_CERT_B64: "cHJvZmlsZS1zbW9rZQ==",
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_KEY_B64: "cHJvZmlsZS1zbW9rZQ==",
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_CERT_B64: "cHJvZmlsZS1zbW9rZQ==",
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_KEY_B64: "cHJvZmlsZS1zbW9rZQ==",
    LEMMACOMPUTER_TELEGRAM_RAW_TOKEN_INPUT_MODE: "reject",
  };
};

const qualified = profiles.map((profile) => {
  const values = validateDeploymentEnvironment(environmentFor(profile), { profile, strict: true });
  const services = projectServiceEnvironment(values);
  assert.ok(Object.keys(services).length > 0);
  assert.equal(values.LEMMACOMPUTER_IMAGE_TAG, sharedImageTag);
  if (profile === "customer-managed") {
    assert.doesNotMatch(JSON.stringify(services), /https:\/\/[^\"/]*lemmacomputer/i);
  }
  return { profile, services: Object.keys(services).sort() };
});

if (qualified.length === 2) {
  assert.deepEqual(qualified[0].services, qualified[1].services, "both profiles must project the same service topology");
}

process.stdout.write(`Deployment profile preflight smoke passed for ${profiles.join(" and ")} using image ${sharedImageTag}.\n`);
