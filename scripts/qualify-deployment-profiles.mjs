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
const sharedWorkspaceImage = "lemmacomputer/workspace@sha256:profile-smoke-same-image";
const baseEnvironment = () => Object.fromEntries(parseEnvironment(initializeEnvironment(
  renderEnvironmentTemplate(),
  "Etc/UTC",
)).values);

const environmentFor = (profile) => {
  const values = {
    ...baseEnvironment(),
    LEMMACOMPUTER_INSTALLATION_KIND: profile,
    LEMMACOMPUTER_IMAGE_TAG: sharedImageTag,
    LEMMACOMPUTER_WORKSPACE_IMAGE: sharedWorkspaceImage,
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
    LEMMACOMPUTER_RUNTIME_ENVIRONMENT: "production",
    LEMMACOMPUTER_AUTH_TRUSTED_PROXY_CIDRS: "192.0.2.10/32",
    LEMMACOMPUTER_AUTH_EMAIL_TRANSPORT: "postmark",
    LEMMACOMPUTER_POSTMARK_SERVER_TOKEN: "profile-smoke-postmark-token",
    LEMMACOMPUTER_POSTMARK_FROM: "login@profile-smoke.example.test",
    LEMMACOMPUTER_INVITATION_DELIVERY_MODE: "email",
    LEMMACOMPUTER_PUBLIC_WEB_URL: "https://profile-smoke.example.test",
    LEMMACOMPUTER_EXTERNAL_ID_TENANT_ID: "profile-smoke-external-directory",
    LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN: "profile-smoke",
    LEMMACOMPUTER_EXTERNAL_ID_CLIENT_ID: "profile-smoke-external-client",
    LEMMACOMPUTER_EXTERNAL_ID_CLIENT_SECRET: "profile-smoke-external-secret",
    LEMMACOMPUTER_PLATFORM_OPERATOR_ENTRA_TENANT_ID: "profile-smoke-workforce-directory",
    LEMMACOMPUTER_PLATFORM_OPERATOR_ENTRA_CLIENT_ID: "profile-smoke-platform-client",
    LEMMACOMPUTER_PLATFORM_OPERATOR_ENTRA_CLIENT_SECRET: "profile-smoke-platform-secret",
    LEMMACOMPUTER_PLATFORM_OPERATOR_SESSION_SECRET: "profile-smoke-platform-session-secret-0001",
    LEMMACOMPUTER_PLATFORM_OPERATOR_STEP_UP_AUTH_CONTEXT: "c1",
    LEMMACOMPUTER_PLATFORM_SECURITY_ALERT_WEBHOOK_URL: "https://security-alerts.profile-smoke.example.test/lemma",
    LEMMACOMPUTER_PLATFORM_SECURITY_ALERT_WEBHOOK_SECRET: "profile-smoke-security-alert-webhook-secret-0001",
    LEMMACOMPUTER_WORKSPACE_NODE_TOPOLOGY: "remote",
    LEMMACOMPUTER_WORKSPACE_NODE_URL: "https://workspace.profile-smoke.example.test",
    LEMMACOMPUTER_WORKSPACE_NODE_AUTH_MODE: "mtls",
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_CA_B64: "cHJvZmlsZS1zbW9rZQ==",
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_SERVER_CERT_B64: "cHJvZmlsZS1zbW9rZQ==",
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_SERVER_KEY_B64: "cHJvZmlsZS1zbW9rZQ==",
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_CLIENT_CERT_B64: "cHJvZmlsZS1zbW9rZQ==",
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_CLIENT_KEY_B64: "cHJvZmlsZS1zbW9rZQ==",
    LEMMACOMPUTER_WORKSPACE_NODE_PRIVATE_HOST: "workspace.profile-smoke.example.test",
    LEMMACOMPUTER_WORKSPACE_RELAY_BIND_HOST: "10.0.1.10",
    LEMMACOMPUTER_WORKSPACE_NODE_APPLICATION_NETWORK: "workspace-app-private",
    LEMMACOMPUTER_WORKSPACE_NODE_GATEWAY_URL: "https://gateway.internal.profile-smoke.example.test",
    LEMMACOMPUTER_WORKSPACE_NODE_CONTROL_URL: "https://control.internal.profile-smoke.example.test",
    LEMMACOMPUTER_WORKSPACE_INGRESS_VERIFY_UPSTREAM_TLS: "true",
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
  assert.equal(services["workspace-controller"].KASM_LOCAL_IMAGE, sharedWorkspaceImage);
  if (profile === "customer-managed") {
    assert.doesNotMatch(JSON.stringify(services), /https:\/\/[^\"/]*lemmacomputer/i);
  }
  return { profile, services: Object.keys(services).sort() };
});

if (qualified.length === 2) {
  assert.deepEqual(qualified[0].services, qualified[1].services, "both profiles must project the same service topology");
}

process.stdout.write(`Deployment profile preflight smoke passed for ${profiles.join(" and ")} using image ${sharedImageTag}.\n`);
