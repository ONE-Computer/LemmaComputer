import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  assertHostedCapability,
  assertOrganizationCountAllowed,
  assertSignInProviderAllowed,
  assertWorkspaceDriverAllowed,
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
  assert.equal(deploymentProfileCapabilityMatrix.schemaVersion, 1);
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

test("hosted requires remote workspaces while worktree can exercise either driver", () => {
  assert.doesNotThrow(() => assertSignInProviderAllowed("hosted", "external-id"));
  assert.doesNotThrow(() => assertSignInProviderAllowed("hosted", "enterprise-entra"));
  assert.doesNotThrow(() => assertHostedCapability("hosted", "backgroundJobs"));
  assert.throws(() => assertWorkspaceDriverAllowed("hosted", "kasm-local"), /not allowed/i);
  assert.doesNotThrow(() => assertWorkspaceDriverAllowed("hosted", "kasm"));
  assert.doesNotThrow(() => assertWorkspaceDriverAllowed("worktree", "kasm-local"));
  assert.doesNotThrow(() => assertWorkspaceDriverAllowed("worktree", "kasm"));
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
    LEMMACOMPUTER_IMAGE_TAG: sharedImage,
    LEMMACOMPUTER_PUBLIC_WEB_URL: "https://hosted.example.test",
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
