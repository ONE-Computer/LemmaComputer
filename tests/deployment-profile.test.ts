import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  assertCustomerAuthenticationMethodAllowed,
  assertHostedCapability,
  assertOrganizationCountAllowed,
  assertSignInProviderAllowed,
  assertWorkspaceDriverTopologyAllowed,
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

test("the checked-in matrix has exactly two production profiles and development-only worktree", () => {
  assert.deepEqual(productionDeploymentProfileIds, ["customer-managed", "hosted"]);
  assert.deepEqual(deploymentProfileIds, ["customer-managed", "hosted", "worktree"]);
  assert.equal(deploymentProfileCapabilityMatrix.schemaVersion, 3);
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
  assert.doesNotThrow(() => assertSignInProviderAllowed("customer-managed", "workforce-entra"));
  assert.throws(() => assertSignInProviderAllowed("customer-managed", "external-id"), /not allowed/i);
  assert.throws(() => assertSignInProviderAllowed("customer-managed", "enterprise-entra"), /not allowed/i);
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
    assert.throws(() => assertCustomerAuthenticationMethodAllowed(profileId, "workforce-oidc"), /not allowed/i);
    assert.throws(() => assertCustomerAuthenticationMethodAllowed(profileId, "provider-admin-claim"), /not allowed/i);
  }

  const customerManaged = resolveDeploymentProfile("customer-managed");
  assert.equal(customerManaged.customerAuthentication.databaseScope, "installation-local");
  assert.equal(customerManaged.platformOperatorRealm, "absent");
  assert.deepEqual(customerManaged.transitionalCustomerAdapters, ["workforce-entra"]);

  const hosted = resolveDeploymentProfile("hosted");
  assert.equal(hosted.customerAuthentication.databaseScope, "pooled-control-plane");
  assert.equal(hosted.platformOperatorRealm, "separate-workforce");
  assert.deepEqual(hosted.transitionalCustomerAdapters, ["external-id", "enterprise-entra"]);
});

test("hosted requires a qualified remote provider boundary without selecting a vendor", () => {
  assert.doesNotThrow(() => assertSignInProviderAllowed("hosted", "external-id"));
  assert.doesNotThrow(() => assertSignInProviderAllowed("hosted", "enterprise-entra"));
  assert.doesNotThrow(() => assertHostedCapability("hosted", "backgroundJobs"));
  assert.throws(() => assertWorkspaceDriverTopologyAllowed("hosted", "kasm-local"), /local-operator-controlled.*not allowed/i);
  assert.doesNotThrow(() => assertWorkspaceDriverTopologyAllowed("hosted", "kasm"));
  assert.doesNotThrow(() => assertWorkspaceProviderBoundaryAllowed("hosted", "remote-isolated"));
  assert.doesNotThrow(() => assertWorkspaceDriverTopologyAllowed("worktree", "kasm-local"));
  assert.doesNotThrow(() => assertWorkspaceDriverTopologyAllowed("worktree", "kasm"));

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
  const sharedImage = "release-same-commit";
  const customerManaged = {
    ...base,
    LEMMACOMPUTER_INSTALLATION_KIND: "customer-managed",
    LEMMACOMPUTER_IMAGE_TAG: sharedImage,
    LEMMACOMPUTER_ENTRA_TENANT_ID: "customer-directory",
    LEMMACOMPUTER_ENTRA_CLIENT_ID: "customer-client",
    LEMMACOMPUTER_ENTRA_CLIENT_SECRET: "customer-secret",
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
    LEMMACOMPUTER_IMAGE_TAG: sharedImage,
    LEMMACOMPUTER_PUBLIC_WEB_URL: "https://hosted.example.test",
    LEMMACOMPUTER_EXTERNAL_ID_TENANT_ID: "hosted-external-directory",
    LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN: "hosted-test",
    LEMMACOMPUTER_EXTERNAL_ID_CLIENT_ID: "hosted-external-client",
    LEMMACOMPUTER_EXTERNAL_ID_CLIENT_SECRET: "hosted-external-secret",
    LEMMACOMPUTER_PLATFORM_OPERATOR_ENTRA_TENANT_ID: "workforce-directory",
    LEMMACOMPUTER_PLATFORM_OPERATOR_ENTRA_CLIENT_ID: "platform-operator-client",
    LEMMACOMPUTER_PLATFORM_OPERATOR_ENTRA_CLIENT_SECRET: "platform-operator-secret",
    LEMMACOMPUTER_PLATFORM_OPERATOR_SESSION_SECRET: "platform-operator-session-secret-distinct",
    LEMMACOMPUTER_PLATFORM_OPERATOR_STEP_UP_AUTH_CONTEXT: "c1",
    LEMMACOMPUTER_PLATFORM_SECURITY_ALERT_WEBHOOK_URL: "https://security-alerts.example.test/lemma",
    LEMMACOMPUTER_PLATFORM_SECURITY_ALERT_WEBHOOK_SECRET: "security-alert-webhook-secret-at-least-32-characters",
    LEMMACOMPUTER_SANDBOX_DRIVER: "kasm",
    LEMMACOMPUTER_KASM_BASE_URL: "https://workspace.example.test",
    LEMMACOMPUTER_KASM_API_KEY: "kasm-key",
    LEMMACOMPUTER_KASM_API_SECRET: "kasm-secret",
    LEMMACOMPUTER_KASM_USER_ID: "kasm-user",
    LEMMACOMPUTER_KASM_IMAGE_ID: "kasm-image",
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
  assert.equal(customerManaged.LEMMACOMPUTER_IMAGE_TAG, hosted.LEMMACOMPUTER_IMAGE_TAG);
});

test("customer-managed service projection has no LemmaComputer-hosted control-plane dependency", () => {
  const services = projectServiceEnvironment({
    ...initializedEnvironment(),
    LEMMACOMPUTER_INSTALLATION_KIND: "customer-managed",
    LEMMACOMPUTER_ENTRA_TENANT_ID: "customer-directory",
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
  assert.match(smoke.stdout, /preflight smoke passed for customer-managed/i);
});
