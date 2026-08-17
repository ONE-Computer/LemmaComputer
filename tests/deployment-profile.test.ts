import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  assertCustomerAuthenticationMethodAllowed,
  assertHostedCapability,
  assertOrganizationCountAllowed,
  assertSignInProviderAllowed,
  assertWorkspaceNodeTopologyAllowed,
  assertWorkspaceProviderBoundaryAllowed,
  deploymentProfileCapabilityMatrix,
  deploymentProfileIds,
  productionDeploymentProfileIds,
  resolveDeploymentProfile,
} from "../packages/deployment-profile/src/index.mjs";
import {
  projectServiceEnvironment,
  validateDeploymentEnvironment,
} from "../scripts/deployment-config.mjs";
import {
  initializeEnvironment,
  parseEnvironment,
} from "../scripts/environment-template.mjs";
import { renderEnvironmentTemplate } from "../scripts/deployment-config.mjs";

const initializedEnvironment = () => Object.fromEntries(parseEnvironment(
  initializeEnvironment(renderEnvironmentTemplate(), "Etc/UTC"),
).values);

const productionImages = Object.freeze({
  LEMMACOMPUTER_CONTROL_RUNTIME_IMAGE: `lemmacomputer/control-runtime@sha256:${"a".repeat(64)}`,
  LEMMACOMPUTER_OPENVTC_CONSENT_IMAGE: `lemmacomputer/openvtc-consent@sha256:${"b".repeat(64)}`,
  LEMMACOMPUTER_MS365_MCP_IMAGE: `lemmacomputer/ms365-mcp@sha256:${"c".repeat(64)}`,
  LEMMACOMPUTER_WORKSPACE_IMAGE: `lemmacomputer/workspace@sha256:${"d".repeat(64)}`,
});

test("the checked-in matrix has exactly two production profiles and development-only worktree", () => {
  assert.deepEqual(productionDeploymentProfileIds, ["customer-managed", "hosted"]);
  assert.deepEqual(deploymentProfileIds, ["customer-managed", "hosted", "worktree"]);
  assert.equal(deploymentProfileCapabilityMatrix.schemaVersion, 4);
  assert.equal(resolveDeploymentProfile("customer-managed").maximumOrganizations, 1);
  assert.equal(resolveDeploymentProfile("hosted").organizationCardinality, "multiple");
  assert.equal(resolveDeploymentProfile("worktree").production, false);
  assert.throws(
    () => resolveDeploymentProfile("worktree", { allowDevelopment: false }),
    /development-only/i,
  );
  assert.throws(() => resolveDeploymentProfile(undefined), /explicitly set/i);

  assert.doesNotThrow(() => validateDeploymentEnvironment({
    ...initializedEnvironment(),
    LEMMACOMPUTER_INSTALLATION_KIND: "worktree",
  }, { profile: "worktree", strict: true }));
});

test("customer-managed denies hosted-only capabilities and a second organization", () => {
  assert.doesNotThrow(() => assertOrganizationCountAllowed("customer-managed", 1));
  assert.throws(() => assertOrganizationCountAllowed("customer-managed", 2), /at most 1 organization/i);
  assert.doesNotThrow(() => assertSignInProviderAllowed("customer-managed", "better-auth-customer"));
  assert.throws(() => assertSignInProviderAllowed("customer-managed", "unsupported-provider"), /not allowed/i);
  assert.throws(() => assertHostedCapability("customer-managed", "backgroundJobs"), /hosted-only/i);
  assert.throws(() => assertHostedCapability("customer-managed", "lemmaManagedControlPlane"), /hosted-only/i);
});

test("both production profiles use the same provider-neutral Better Auth customer contract", () => {
  for (const profileId of productionDeploymentProfileIds) {
    const resolved = resolveDeploymentProfile(profileId);
    assert.equal(resolved.customerAuthentication.framework, "better-auth");
    assert.equal(resolved.customerAuthentication.requiredLemmaHostedDependency, false);
    assert.doesNotThrow(() => assertSignInProviderAllowed(profileId, "better-auth-customer"));
    for (const method of ["email-password", "passkey", "google-oauth", "microsoft-oauth", "saml", "oidc"]) {
      assert.doesNotThrow(() => assertCustomerAuthenticationMethodAllowed(profileId, method));
    }
    assert.throws(() => assertCustomerAuthenticationMethodAllowed(profileId, "unsupported-method"), /not allowed/i);
    assert.throws(() => assertCustomerAuthenticationMethodAllowed(profileId, "provider-admin-claim"), /not allowed/i);
  }

  const customerManaged = resolveDeploymentProfile("customer-managed");
  assert.equal(customerManaged.customerAuthentication.databaseScope, "installation-local");
  assert.equal(customerManaged.platformOperatorRealm, "absent");

  const hosted = resolveDeploymentProfile("hosted");
  assert.equal(hosted.customerAuthentication.databaseScope, "pooled-control-plane");
  assert.equal(hosted.platformOperatorRealm, "separate-passkey");
});

test("hosted requires a qualified remote provider boundary without selecting a vendor", () => {
  assert.doesNotThrow(() => assertSignInProviderAllowed("hosted", "better-auth-customer"));
  assert.doesNotThrow(() => assertHostedCapability("hosted", "backgroundJobs"));
  assert.throws(() => assertWorkspaceNodeTopologyAllowed("hosted", "colocated"), /local-operator-controlled.*not allowed/i);
  assert.doesNotThrow(() => assertWorkspaceNodeTopologyAllowed("hosted", "remote"));
  assert.doesNotThrow(() => assertWorkspaceProviderBoundaryAllowed("hosted", "remote-isolated"));
  assert.doesNotThrow(() => assertWorkspaceNodeTopologyAllowed("worktree", "colocated"));
  assert.doesNotThrow(() => assertWorkspaceNodeTopologyAllowed("worktree", "remote"));

  const hostedPolicy = resolveDeploymentProfile("hosted").workspaceProviderPolicy;
  assert.deepEqual(hostedPolicy.allowedExecutionBoundaries, ["remote-isolated"]);
  assert.equal(hostedPolicy.minimumQualification, "platform-qualified");
  assert.deepEqual(hostedPolicy.requiredControls, [
    "tenant-context",
    "signed-policy",
    "governed-egress",
    "lifecycle-audit",
    "verified-purge",
  ]);
});

test("both production profiles render the same service topology from the same image contract", () => {
  const base = initializedEnvironment();
  const customerManaged = {
    ...base,
    LEMMACOMPUTER_INSTALLATION_KIND: "customer-managed",
    LEMMACOMPUTER_RUNTIME_ENVIRONMENT: "production",
    LEMMACOMPUTER_AUTH_EMAIL_TRANSPORT: "postmark",
    LEMMACOMPUTER_POSTMARK_SERVER_TOKEN: "postmark-test-token",
    LEMMACOMPUTER_POSTMARK_FROM: "login@example.test",
    ...productionImages,
  };
  const hosted = {
    ...base,
    LEMMACOMPUTER_INSTALLATION_KIND: "hosted",
    LEMMACOMPUTER_RUNTIME_ENVIRONMENT: "production",
    LEMMACOMPUTER_AUTH_TRUSTED_PROXY_CIDRS: "192.0.2.10/32",
    LEMMACOMPUTER_AUTH_EMAIL_TRANSPORT: "postmark",
    LEMMACOMPUTER_POSTMARK_SERVER_TOKEN: "postmark-test-token",
    LEMMACOMPUTER_POSTMARK_FROM: "login@example.test",
    LEMMACOMPUTER_INVITATION_DELIVERY_MODE: "email",
    ...productionImages,
    LEMMACOMPUTER_PUBLIC_WEB_URL: "https://hosted.example.test",
    LEMMACOMPUTER_PLATFORM_AUTH_BOOTSTRAP_EMAIL: "operator@hosted.example.test",
    LEMMACOMPUTER_PLATFORM_SECURITY_ALERT_WEBHOOK_URL: "https://security-alerts.example.test/lemma",
    LEMMACOMPUTER_PLATFORM_SECURITY_ALERT_WEBHOOK_SECRET: "security-alert-webhook-secret-at-least-32-characters",
    LEMMACOMPUTER_ARTIFACT_STORE_BACKEND: "s3",
    LEMMACOMPUTER_ARTIFACT_S3_BUCKET: "hosted-artifacts",
    LEMMACOMPUTER_ARTIFACT_S3_REGION: "us-east-1",
    LEMMACOMPUTER_ARTIFACT_S3_KMS_KEY_ID: "arn:aws:kms:us-east-1:111122223333:key/11111111-2222-3333-4444-555555555555",
    LEMMACOMPUTER_WORKSPACE_NODE_TOPOLOGY: "remote",
    LEMMACOMPUTER_WORKSPACE_NODE_URL: "https://workspace.example.test",
    LEMMACOMPUTER_WORKSPACE_NODE_AUTH_MODE: "mtls",
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_CA_B64: "dGVzdA==",
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_SERVER_CERT_B64: "dGVzdA==",
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_SERVER_KEY_B64: "dGVzdA==",
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_CLIENT_CERT_B64: "dGVzdA==",
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_CLIENT_KEY_B64: "dGVzdA==",
    LEMMACOMPUTER_WORKSPACE_INGRESS_TLS_CLIENT_CERT_B64: "dGVzdA==",
    LEMMACOMPUTER_WORKSPACE_INGRESS_TLS_CLIENT_KEY_B64: "dGVzdA==",
    LEMMACOMPUTER_WORKSPACE_NODE_PRIVATE_HOST: "workspace.example.test",
    LEMMACOMPUTER_WORKSPACE_RELAY_BIND_HOST: "10.0.1.10",
    LEMMACOMPUTER_WORKSPACE_NODE_RELAY_NETWORK: "workspace-relay-private",
    LEMMACOMPUTER_WORKSPACE_NODE_APPLICATION_NETWORK: "workspace-app-private",
    LEMMACOMPUTER_WORKSPACE_NODE_APPLICATION_TLS_CA_B64: "dGVzdA==",
    LEMMACOMPUTER_WORKSPACE_NODE_APPLICATION_TLS_CLIENT_CERT_B64: "dGVzdA==",
    LEMMACOMPUTER_WORKSPACE_NODE_APPLICATION_TLS_CLIENT_KEY_B64: "dGVzdA==",
    LEMMACOMPUTER_WORKSPACE_NODE_GATEWAY_URL: "https://gateway.internal.example.test",
    LEMMACOMPUTER_WORKSPACE_NODE_CONTROL_URL: "https://control.internal.example.test",
    LEMMACOMPUTER_WORKSPACE_INGRESS_VERIFY_UPSTREAM_TLS: "true",
    LEMMACOMPUTER_LITELLM_ADMIN_URL: "https://litellm-admin-listener:8443",
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_CA_B64: "dGVzdA==",
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_CERT_B64: "dGVzdA==",
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_KEY_B64: "dGVzdA==",
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_CERT_B64: "dGVzdA==",
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_KEY_B64: "dGVzdA==",
    LEMMACOMPUTER_TELEGRAM_RAW_TOKEN_INPUT_MODE: "reject",
  };

  assert.doesNotThrow(() => validateDeploymentEnvironment(customerManaged, { profile: "customer-managed", strict: true }));
  assert.doesNotThrow(() => validateDeploymentEnvironment(hosted, { profile: "hosted", strict: true }));
  assert.deepEqual(
    Object.keys(projectServiceEnvironment(customerManaged)).sort(),
    Object.keys(projectServiceEnvironment(hosted)).sort(),
  );
  assert.equal(customerManaged.LEMMACOMPUTER_CONTROL_RUNTIME_IMAGE, hosted.LEMMACOMPUTER_CONTROL_RUNTIME_IMAGE);
  assert.equal(projectServiceEnvironment(customerManaged)["workspace-controller"].KASM_LOCAL_IMAGE, productionImages.LEMMACOMPUTER_WORKSPACE_IMAGE);
  assert.equal(projectServiceEnvironment(hosted)["workspace-controller"].KASM_LOCAL_IMAGE, productionImages.LEMMACOMPUTER_WORKSPACE_IMAGE);
});

test("production profiles fail closed unless all first-party images use immutable digests", () => {
  for (const profile of ["customer-managed", "hosted"] as const) {
    const values = profile === "customer-managed"
      ? {
          ...initializedEnvironment(),
          LEMMACOMPUTER_INSTALLATION_KIND: profile,
          LEMMACOMPUTER_RUNTIME_ENVIRONMENT: "production",
        }
      : {
          ...initializedEnvironment(),
          ...productionImages,
          LEMMACOMPUTER_INSTALLATION_KIND: profile,
          LEMMACOMPUTER_RUNTIME_ENVIRONMENT: "production",
          LEMMACOMPUTER_CONTROL_RUNTIME_IMAGE: "lemmacomputer/control-runtime:latest",
        };
    assert.throws(
      () => validateDeploymentEnvironment(values, { profile, strict: true }),
      /CONTROL_RUNTIME_IMAGE.*immutable|OPENVTC_CONSENT_IMAGE.*immutable|MS365_MCP_IMAGE.*immutable|WORKSPACE_IMAGE.*immutable/i,
    );
  }
});

test("worktree development preserves isolated mutable image tags", () => {
  const values = {
    ...initializedEnvironment(),
    LEMMACOMPUTER_INSTALLATION_KIND: "worktree",
  };
  assert.doesNotThrow(() => validateDeploymentEnvironment(values, { profile: "worktree", strict: true }));
  assert.match(values.LEMMACOMPUTER_CONTROL_RUNTIME_IMAGE, /:dev$/);
  assert.match(values.LEMMACOMPUTER_OPENVTC_CONSENT_IMAGE, /:dev$/);
  assert.match(values.LEMMACOMPUTER_MS365_MCP_IMAGE, /:0\.131\.2$/);
  assert.match(values.LEMMACOMPUTER_WORKSPACE_IMAGE, /:dev$/);
});

test("customer-managed service projection has no LemmaComputer-hosted control-plane dependency", () => {
  const services = projectServiceEnvironment({
    ...initializedEnvironment(),
    LEMMACOMPUTER_INSTALLATION_KIND: "customer-managed",
  });
  const projection = JSON.stringify(services);
  assert.doesNotMatch(projection, /https:\/\/[^\"/]*lemmacomputer/i);
  assert.doesNotMatch(projection, /PLATFORM_OPERATOR|PLATFORM_SUPPORT_APPROVAL/i);
  assert.equal(resolveDeploymentProfile("customer-managed").lemmaManagedControlPlane, "not-required");
});

test("customer-managed preflight passes with Node network access denied", () => {
  const smoke = spawnSync(process.execPath, [
    "--import",
    new URL("fixtures/deny-node-network.mjs", import.meta.url).pathname,
    new URL("../scripts/qualify-deployment-profiles.mjs", import.meta.url).pathname,
    "--profile=customer-managed",
  ], { encoding: "utf8" });
  assert.equal(smoke.status, 0, smoke.stderr);
});
