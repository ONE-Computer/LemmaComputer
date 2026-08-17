import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  environmentContract,
  firstPartyImageVariables,
  allEnvironmentVariableNameSet,
  projectServiceEnvironment,
  renderEnvironmentTemplate,
  renderQualificationEnvironmentTemplate,
  serializeEnvironment,
  validateDeploymentEnvironment,
  worktreeEnvironmentOverrides,
} from "../scripts/deployment-config.mjs";
import {
  initializeEnvironment,
  mergeEnvironment,
  parseEnvironment,
} from "../scripts/environment-template.mjs";

const environmentReferences = (contents: string) => new Set(
  [...contents.matchAll(/\$\{((?:LEMMACOMPUTER|QUALIFICATION)_[A-Z0-9_]+)/g)].map(([, key]) => key),
);

const assignmentKeys = (contents: string) => (
  [...contents.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(([, key]) => key)
);

const registeredKeys = () => new Set(environmentContract.map(({ key }) => key));

test("runtime sources do not retain the retired OneComputer namespace", () => {
  const result = spawnSync("git", [
    "grep", "-n", "-i", "onecomputer", "--",
    "apps", "docker", "integrations", "packages", "scripts", "skills",
    ":(exclude)packages/workspace-store/migrations/**",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stdout || result.stderr);
});

const pemBase64 = (kind: "CERTIFICATE" | "PRIVATE KEY") => Buffer
  .from(`-----BEGIN ${kind}-----\ntest-fixture\n-----END ${kind}-----\n`)
  .toString("base64");

const validHostedEnvironment = () => {
  const initialized = initializeEnvironment(renderEnvironmentTemplate(), "Etc/UTC");
  const values = Object.fromEntries(parseEnvironment(initialized).values);

  for (const [key, value] of Object.entries(values)) {
    if (!value || value.startsWith("replace-with-")) values[key] = `test-${key.toLowerCase()}`;
  }

  Object.assign(values, {
    LEMMACOMPUTER_INSTALLATION_KIND: "hosted",
    LEMMACOMPUTER_RUNTIME_ENVIRONMENT: "production",
    LEMMACOMPUTER_AUTH_TRUSTED_PROXY_CIDRS: "192.0.2.10/32",
    LEMMACOMPUTER_AUTH_EMAIL_TRANSPORT: "postmark",
    LEMMACOMPUTER_POSTMARK_SERVER_TOKEN: "postmark-test-token",
    LEMMACOMPUTER_POSTMARK_FROM: "login@example.test",
    LEMMACOMPUTER_POSTMARK_MESSAGE_STREAM: "auth",
    LEMMACOMPUTER_INVITATION_DELIVERY_MODE: "email",
    LEMMACOMPUTER_ARTIFACT_STORE_BACKEND: "s3",
    LEMMACOMPUTER_ARTIFACT_S3_BUCKET: "hosted-artifacts",
    LEMMACOMPUTER_ARTIFACT_S3_REGION: "ap-southeast-1",
    LEMMACOMPUTER_ARTIFACT_S3_ENDPOINT: "",
    LEMMACOMPUTER_ARTIFACT_S3_KMS_KEY_ID: "alias/lemmacomputer-artifacts",
    LEMMACOMPUTER_PUBLIC_WEB_URL: "https://hosted.example.test",
    LEMMACOMPUTER_PLATFORM_AUTH_BOOTSTRAP_EMAIL: "operator@hosted.example.test",
    LEMMACOMPUTER_PLATFORM_SECURITY_ALERT_WEBHOOK_URL: "https://security-alerts.example.test/lemma",
    LEMMACOMPUTER_PLATFORM_SECURITY_ALERT_WEBHOOK_SECRET: "security-alert-webhook-secret-at-least-32-characters",
    LEMMACOMPUTER_WORKSPACE_NODE_TOPOLOGY: "remote",
    LEMMACOMPUTER_WORKSPACE_NODE_URL: "https://workspace.example.test",
    LEMMACOMPUTER_WORKSPACE_NODE_AUTH_MODE: "mtls",
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_CA_B64: pemBase64("CERTIFICATE"),
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_SERVER_CERT_B64: pemBase64("CERTIFICATE"),
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_SERVER_KEY_B64: pemBase64("PRIVATE KEY"),
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_CLIENT_CERT_B64: pemBase64("CERTIFICATE"),
    LEMMACOMPUTER_WORKSPACE_NODE_TLS_CLIENT_KEY_B64: pemBase64("PRIVATE KEY"),
    LEMMACOMPUTER_WORKSPACE_INGRESS_TLS_CLIENT_CERT_B64: pemBase64("CERTIFICATE"),
    LEMMACOMPUTER_WORKSPACE_INGRESS_TLS_CLIENT_KEY_B64: pemBase64("PRIVATE KEY"),
    LEMMACOMPUTER_WORKSPACE_NODE_PRIVATE_HOST: "workspace.example.test",
    LEMMACOMPUTER_WORKSPACE_RELAY_BIND_HOST: "10.0.1.10",
    LEMMACOMPUTER_WORKSPACE_NODE_RELAY_NETWORK: "workspace-relay-private",
    LEMMACOMPUTER_WORKSPACE_NODE_APPLICATION_NETWORK: "workspace-app-private",
    LEMMACOMPUTER_WORKSPACE_NODE_APPLICATION_TLS_CA_B64: pemBase64("CERTIFICATE"),
    LEMMACOMPUTER_WORKSPACE_NODE_APPLICATION_TLS_CLIENT_CERT_B64: pemBase64("CERTIFICATE"),
    LEMMACOMPUTER_WORKSPACE_NODE_APPLICATION_TLS_CLIENT_KEY_B64: pemBase64("PRIVATE KEY"),
    LEMMACOMPUTER_WORKSPACE_NODE_GATEWAY_URL: "https://gateway.internal.example.test",
    LEMMACOMPUTER_WORKSPACE_NODE_CONTROL_URL: "https://control.internal.example.test",
    LEMMACOMPUTER_WORKSPACE_INGRESS_VERIFY_UPSTREAM_TLS: "true",
    LEMMACOMPUTER_KASM_LOCAL_KVM_ENABLED: "true",
    LEMMACOMPUTER_LITELLM_ADMIN_URL: "https://litellm-admin-listener:8443",
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_CA_B64: pemBase64("CERTIFICATE"),
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_CERT_B64: pemBase64("CERTIFICATE"),
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_KEY_B64: pemBase64("PRIVATE KEY"),
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_CERT_B64: pemBase64("CERTIFICATE"),
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_KEY_B64: pemBase64("PRIVATE KEY"),
    LEMMACOMPUTER_TELEGRAM_RAW_TOKEN_INPUT_MODE: "reject",
    LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET: "credential-secret-that-is-long-enough-0000001",
    LEMMACOMPUTER_WORKSPACE_INGRESS_SECRET: "ingress-secret-that-is-long-enough-0000000001",
    LEMMACOMPUTER_CONTROL_RUNTIME_IMAGE: `lemmacomputer/control-runtime@sha256:${"a".repeat(64)}`,
    LEMMACOMPUTER_OPENVTC_CONSENT_IMAGE: `lemmacomputer/openvtc-consent@sha256:${"b".repeat(64)}`,
    LEMMACOMPUTER_MS365_MCP_IMAGE: `lemmacomputer/ms365-mcp@sha256:${"c".repeat(64)}`,
    LEMMACOMPUTER_WORKSPACE_IMAGE: `lemmacomputer/workspace@sha256:${"d".repeat(64)}`,
  });
  return values;
};

const validCustomerManagedEnvironment = () => {
  const initialized = initializeEnvironment(renderEnvironmentTemplate(), "Etc/UTC");
  const values = Object.fromEntries(parseEnvironment(initialized).values);
  Object.assign(values, {
    LEMMACOMPUTER_INSTALLATION_KIND: "customer-managed",
    LEMMACOMPUTER_CONTROL_RUNTIME_IMAGE: `lemmacomputer/control-runtime@sha256:${"a".repeat(64)}`,
    LEMMACOMPUTER_OPENVTC_CONSENT_IMAGE: `lemmacomputer/openvtc-consent@sha256:${"b".repeat(64)}`,
    LEMMACOMPUTER_MS365_MCP_IMAGE: `lemmacomputer/ms365-mcp@sha256:${"c".repeat(64)}`,
    LEMMACOMPUTER_WORKSPACE_IMAGE: `lemmacomputer/workspace@sha256:${"d".repeat(64)}`,
  });
  return values;
};

const initializedCustomerManagedEnvironment = () => initializeEnvironment(
  renderEnvironmentTemplate(),
  "Etc/UTC",
).replace(
  "LEMMACOMPUTER_CONTROL_RUNTIME_IMAGE=lemmacomputer/control-runtime:dev",
  `LEMMACOMPUTER_CONTROL_RUNTIME_IMAGE=lemmacomputer/control-runtime@sha256:${"a".repeat(64)}`,
).replace(
  "LEMMACOMPUTER_OPENVTC_CONSENT_IMAGE=lemmacomputer/openvtc-consent:dev",
  `LEMMACOMPUTER_OPENVTC_CONSENT_IMAGE=lemmacomputer/openvtc-consent@sha256:${"b".repeat(64)}`,
).replace(
  "LEMMACOMPUTER_MS365_MCP_IMAGE=lemmacomputer/ms365-mcp:0.131.2",
  `LEMMACOMPUTER_MS365_MCP_IMAGE=lemmacomputer/ms365-mcp@sha256:${"c".repeat(64)}`,
).replace(
  "LEMMACOMPUTER_WORKSPACE_IMAGE=lemmacomputer/workspace:dev",
  `LEMMACOMPUTER_WORKSPACE_IMAGE=lemmacomputer/workspace@sha256:${"d".repeat(64)}`,
);

test("the checked-in environment example is rendered from the canonical deployment contract", async () => {
  assert.ok(Array.isArray(environmentContract));
  assert.ok(environmentContract.length > 0);

  const keys = environmentContract.map((entry) => {
    assert.equal(typeof entry.key, "string");
    assert.ok(entry.key.length > 0);
    assert.ok(Object.hasOwn(entry, "default"));
    assert.equal(typeof entry.description, "string");
    assert.ok(entry.description.length > 0);
    assert.match(entry.description, /[.!?]$/, `${entry.key} needs a complete purpose sentence`);
    if (entry.requiredWhen !== undefined) {
      assert.equal(typeof entry.requiredWhen, "string");
      assert.match(entry.requiredWhen, /[.!?]$/, `${entry.key} needs a complete conditional-requirement sentence`);
    }
    assert.equal(typeof entry.section, "string");
    assert.ok(entry.section.length > 0);
    return entry.key;
  });
  assert.equal(new Set(keys).size, keys.length, "contract keys must be unique");

  const rendered = renderEnvironmentTemplate();
  const checkedIn = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.equal(rendered, checkedIn, ".env.example must be generated from the contract without manual drift");
  assert.deepEqual(assignmentKeys(rendered), keys, "the template must list every registered operator variable once");
  assert.match(rendered, /Scope: every operator-owned input accepted in a deployment \.env is listed/);
  assert.match(rendered, /Service-local and per-workspace variables are derived/);
  assert.match(rendered, /Qualification-only inputs are documented in \.env\.qualification\.example/);
  assert.match(rendered, /Accepted values: customer-managed, hosted, worktree\./);
  assert.match(rendered, /Sensitive: keep this value out of source control and logs/);
  assert.match(rendered, /Required when: The hosted profile is selected\./);

  const installationKind = environmentContract.find(({ key }) => key === "LEMMACOMPUTER_INSTALLATION_KIND");
  assert.equal(installationKind?.key, "LEMMACOMPUTER_INSTALLATION_KIND");
  assert.equal(installationKind?.default, "customer-managed");
  const credentialSecret = environmentContract.find(({ key }) => key === "LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET");
  assert.equal(credentialSecret?.generated, true);
  assert.equal(credentialSecret?.secret, true);
});

test("every production Compose operator reference and worktree override is registered", async () => {
  const root = new URL("..", import.meta.url);
  const composeFiles = (await readdir(root))
    .filter((name) => /^compose(?:\.[^.]+)?\.ya?ml$/.test(name))
    .filter((name) => !name.includes("qualification"));
  const keys = registeredKeys();
  const references = new Set<string>();
  for (const name of composeFiles) {
    const compose = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
    for (const key of environmentReferences(compose)) references.add(key);
  }
  const unregisteredComposeReferences = [...references].filter((key) => !keys.has(key));
  assert.deepEqual(unregisteredComposeReferences, [], "Compose must not introduce an unregistered operator variable");
  for (const key of firstPartyImageVariables) {
    assert.ok(references.has(key), `Compose must consume the complete ${key} reference`);
  }

  const overrides = worktreeEnvironmentOverrides({
    slug: "lemmacomputer-a1b2c3d4e5",
    id: "a1b2c3d4e5",
    portOffset: 1234,
  });
  assert.ok(overrides instanceof Map);
  assert.equal(overrides.get("LEMMACOMPUTER_COMPOSE_PROJECT_NAME"), "lemmacomputer-a1b2c3d4e5");
  assert.equal(overrides.get("LEMMACOMPUTER_WEB_PORT"), "5408");
  assert.equal(overrides.get("LEMMACOMPUTER_INSTALLATION_KIND"), "worktree");
  assert.equal(overrides.get("LEMMACOMPUTER_CONTROL_RUNTIME_IMAGE"), "lemmacomputer/control-runtime:dev-a1b2c3d4e5");
  assert.equal(overrides.get("LEMMACOMPUTER_OPENVTC_CONSENT_IMAGE"), "lemmacomputer/openvtc-consent:dev-a1b2c3d4e5");
  assert.equal(overrides.get("LEMMACOMPUTER_MS365_MCP_IMAGE"), "lemmacomputer/ms365-mcp:dev-a1b2c3d4e5");
  assert.equal(overrides.get("LEMMACOMPUTER_WORKSPACE_IMAGE"), "lemmacomputer/workspace:dev-a1b2c3d4e5");
  assert.deepEqual([...overrides.keys()].filter((key) => !keys.has(key)), [], "worktree initialization must not create unregistered configuration");
});

test("qualification inputs are registered separately from deployment inputs", async () => {
  const [oauthCompose, providerCompose, remoteQualifier, qualificationExample] = await Promise.all([
    readFile(new URL("../compose.oauth-qualification.yaml", import.meta.url), "utf8"),
    readFile(new URL("../compose.provider-qualification.yaml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/qualify-remote-workspace-node.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.env.qualification.example", import.meta.url), "utf8"),
  ]);
  const references = [
    ...environmentReferences(oauthCompose),
    ...environmentReferences(providerCompose),
    ...environmentReferences(remoteQualifier),
  ];
  assert.deepEqual(references.filter((key) => !allEnvironmentVariableNameSet.has(key)), []);
  assert.equal(qualificationExample, renderQualificationEnvironmentTemplate());
  assert.match(qualificationExample, /reference inventory, not a file that operators must populate/);
});

test("a complete hosted configuration passes the shared profile validation", () => {
  assert.doesNotThrow(() => validateDeploymentEnvironment(validHostedEnvironment(), {
    profile: "hosted",
    strict: true,
  }));
});

test("hosted artifact storage accepts SSE-S3 without a KMS key override", () => {
  const values = validHostedEnvironment();
  values.LEMMACOMPUTER_ARTIFACT_S3_KMS_KEY_ID = "";
  assert.doesNotThrow(() => validateDeploymentEnvironment(values, {
    profile: "hosted",
    strict: true,
  }));
});

test("hosted Cowork projects KVM only with the required remote node topology", () => {
  const values = validHostedEnvironment();
  const services = projectServiceEnvironment(values);
  assert.equal(services["workspace-controller"].WORKSPACE_NODE_TOPOLOGY, "remote");
  assert.equal(services["control-api"].WORKSPACE_NODE_TOPOLOGY, "remote");
  assert.equal(
    Number(services["control-api"].CONTROLLER_REQUEST_TIMEOUT_MS),
    Number(services["workspace-controller"].KASM_LOCAL_STARTUP_TIMEOUT_MS) + 30_000,
  );
  assert.equal(services["workspace-controller"].KASM_LOCAL_KVM_ENABLED, "true");

  assert.throws(
    () => validateDeploymentEnvironment({
      ...values,
      LEMMACOMPUTER_WORKSPACE_NODE_TOPOLOGY: "colocated",
    }, { profile: "hosted", strict: true }),
    /local-operator-controlled workspace execution is not allowed/i,
  );
});

test("remote workspace grants use only the configured private HTTPS relay upstreams", () => {
  const values = validHostedEnvironment();
  const services = projectServiceEnvironment(values);
  assert.equal(services["control-api"].LITELLM_WORKSPACE_URL, values.LEMMACOMPUTER_WORKSPACE_NODE_GATEWAY_URL);
  assert.equal(services["control-api"].AGENT_BRIDGE_URL, values.LEMMACOMPUTER_WORKSPACE_NODE_CONTROL_URL);

  const insecure = { ...values, LEMMACOMPUTER_WORKSPACE_NODE_GATEWAY_URL: "http://gateway.internal.example.test" };
  assert.throws(
    () => validateDeploymentEnvironment(insecure, { profile: "hosted", strict: true }),
    /WORKSPACE_NODE_GATEWAY_URL must use https/i,
  );
});

test("a complete customer-managed configuration passes the shared profile validation", () => {
  assert.doesNotThrow(() => validateDeploymentEnvironment(validCustomerManagedEnvironment(), {
    profile: "customer-managed",
    strict: true,
  }));
});

test("both production profiles reject every mutable first-party image reference", () => {
  for (const [profile, environment] of [
    ["customer-managed", {
      ...validCustomerManagedEnvironment(),
      LEMMACOMPUTER_RUNTIME_ENVIRONMENT: "production",
      LEMMACOMPUTER_AUTH_EMAIL_TRANSPORT: "postmark",
      LEMMACOMPUTER_POSTMARK_SERVER_TOKEN: "postmark-test-token",
      LEMMACOMPUTER_POSTMARK_FROM: "login@example.test",
    }],
    ["hosted", validHostedEnvironment()],
  ] as const) {
    for (const key of firstPartyImageVariables) {
      assert.throws(
        () => validateDeploymentEnvironment({ ...environment, [key]: "registry.example.test/lemma:latest" }, {
          profile,
          strict: true,
        }),
        new RegExp(`${key}.*immutable`, "i"),
      );
    }
  }
});

test("customer-managed development permits local first-party image tags", () => {
  const environment = validCustomerManagedEnvironment();
  environment.LEMMACOMPUTER_CONTROL_RUNTIME_IMAGE = "lemmacomputer/control-runtime:local";
  environment.LEMMACOMPUTER_OPENVTC_CONSENT_IMAGE = "lemmacomputer/openvtc-consent:local";
  environment.LEMMACOMPUTER_MS365_MCP_IMAGE = "lemmacomputer/ms365-mcp:local";
  environment.LEMMACOMPUTER_WORKSPACE_IMAGE = "lemmacomputer/workspace:local";
  assert.doesNotThrow(() => validateDeploymentEnvironment(environment, {
    profile: "customer-managed",
    strict: true,
  }));
});

test("optional OAuth applications require complete credential pairs", () => {
  assert.throws(
    () => validateDeploymentEnvironment({
      ...validCustomerManagedEnvironment(),
      LEMMACOMPUTER_GITHUB_MCP_CLIENT_ID: "github-client-without-secret",
    }, { profile: "customer-managed", strict: true }),
    /GitHub MCP OAuth client ID and secret must be configured together/i,
  );
  assert.throws(
    () => validateDeploymentEnvironment({
      ...validCustomerManagedEnvironment(),
      LEMMACOMPUTER_GOOGLE_WORKSPACE_MCP_CLIENT_SECRET: "google-workspace-secret-without-client",
    }, { profile: "customer-managed", strict: true }),
    /Google Workspace MCP OAuth client ID and secret must be configured together/i,
  );
  const services = projectServiceEnvironment({
    ...validCustomerManagedEnvironment(),
    LEMMACOMPUTER_GOOGLE_WORKSPACE_MCP_CLIENT_ID: "google-workspace-client",
    LEMMACOMPUTER_GOOGLE_WORKSPACE_MCP_CLIENT_SECRET: "google-workspace-secret",
  });
  assert.equal(services.litellm.GOOGLE_WORKSPACE_MCP_CLIENT_ID, "google-workspace-client");
  assert.equal(services.litellm.GOOGLE_WORKSPACE_MCP_CLIENT_SECRET, "google-workspace-secret");
  // Control publishes credential-gated connectors from this signal, so it must
  // name the configured groups and must never carry the secrets themselves.
  assert.equal(services["control-api"].CONFIGURED_STATIC_MCP_CLIENTS, "google-workspace");
  assert.equal(services["control-api"].GOOGLE_WORKSPACE_MCP_CLIENT_SECRET, undefined);

  const none = projectServiceEnvironment(validCustomerManagedEnvironment());
  assert.equal(none["control-api"].CONFIGURED_STATIC_MCP_CLIENTS, "");

  const both = projectServiceEnvironment({
    ...validCustomerManagedEnvironment(),
    LEMMACOMPUTER_GOOGLE_WORKSPACE_MCP_CLIENT_ID: "google-workspace-client",
    LEMMACOMPUTER_GOOGLE_WORKSPACE_MCP_CLIENT_SECRET: "google-workspace-secret",
    LEMMACOMPUTER_GITHUB_MCP_CLIENT_ID: "github-client",
    LEMMACOMPUTER_GITHUB_MCP_CLIENT_SECRET: "github-secret",
  });
  assert.equal(both["control-api"].CONFIGURED_STATIC_MCP_CLIENTS, "google-workspace,github");
});

test("strict profile validation rejects implicit and mixed profile selection", () => {
  const implicit = validCustomerManagedEnvironment();
  delete implicit.LEMMACOMPUTER_INSTALLATION_KIND;
  assert.throws(
    () => validateDeploymentEnvironment(implicit, { strict: true }),
    /must be explicitly set/i,
  );

  assert.throws(
    () => validateDeploymentEnvironment(validCustomerManagedEnvironment(), { profile: "hosted", strict: true }),
    /must be hosted for this preflight/i,
  );
});

test("the public ingress owns the browser-facing LiteLLM OAuth callback", () => {
  const values = validHostedEnvironment();
  const services = projectServiceEnvironment(values);
  const publicOrigin = new URL(values.LEMMACOMPUTER_PUBLIC_WEB_URL).origin;
  const litellmPublicUrl = `${publicOrigin}/oauth/mcp`;

  assert.equal(
    services["workspace-ingress"].WORKSPACE_INGRESS_LITELLM_PUBLIC_URL,
    litellmPublicUrl,
  );
  assert.equal(services["workspace-ingress"].WORKSPACE_INGRESS_LITELLM_OAUTH_UPSTREAM, "http://litellm:4000");
  assert.equal(services.litellm.PROXY_BASE_URL, litellmPublicUrl);
  assert.equal(services["control-api"].LITELLM_PUBLIC_URL, litellmPublicUrl);
  assert.equal(services["ms365-mcp"].MS365_MCP_PUBLIC_URL, `${publicOrigin}/m365`);
  assert.equal(services["ms365-mcp"].MS365_MCP_ALLOWED_REDIRECT_URIS, `${litellmPublicUrl}/callback`);
  assert.equal(services.litellm.LEMMACOMPUTER_M365_AUTHORIZATION_URL, `${publicOrigin}/m365/authorize`);
});

test("the configured Postmark message stream reaches only Control's email adapter", () => {
  const services = projectServiceEnvironment(validHostedEnvironment());
  assert.equal(services["control-api"].POSTMARK_MESSAGE_STREAM, "auth");
  for (const [service, environment] of Object.entries(services)) {
    if (service !== "control-api") assert.ok(!("POSTMARK_MESSAGE_STREAM" in environment));
  }
});

test("env:update normalizes a historical blank LiteLLM admin URL to the catalog default", () => {
  const template = renderEnvironmentTemplate();
  const initialized = initializeEnvironment(template, "Etc/UTC");
  const merged = mergeEnvironment(template, "LEMMACOMPUTER_LITELLM_ADMIN_URL=\n", initialized);
  const values = Object.fromEntries(parseEnvironment(merged.contents).values);
  const services = projectServiceEnvironment(values);

  assert.equal(values.LEMMACOMPUTER_LITELLM_ADMIN_URL, "http://litellm-admin-listener:8443");
  assert.equal(services["control-api"].LITELLM_ADMIN_URL, "http://litellm-admin-listener:8443");
});

test("environment migration preserves retired variables without projecting them into services", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemmacomputer-env-migration-"));
  const source = join(root, "deployment.env");
  const destination = join(root, "service-env");
  const retiredValue = "legacy-provider-key-that-must-not-reach-services";
  try {
    await writeFile(source, `${initializedCustomerManagedEnvironment()}LEMMACOMPUTER_OPENAI_API_KEY=${retiredValue}\n`, { mode: 0o600 });
    const update = spawnSync(process.execPath, [
      new URL("../scripts/update-env.mjs", import.meta.url).pathname,
      `--file=${source}`,
      "--write",
    ], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
    assert.equal(update.status, 0, update.stderr);
    assert.match(await readFile(source, "utf8"), new RegExp(`LEMMACOMPUTER_OPENAI_API_KEY=${retiredValue}`));

    const render = spawnSync(process.execPath, [
      new URL("../scripts/render-service-env.mjs", import.meta.url).pathname,
      `--file=${source}`,
      `--directory=${destination}`,
    ], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
    assert.equal(render.status, 0, render.stderr);
    assert.doesNotMatch(await readFile(join(destination, "litellm.env"), "utf8"), new RegExp(retiredValue));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hosted validation fails closed for missing or non-HTTPS LiteLLM mutual TLS", () => {
  const missingMaterial = validHostedEnvironment();
  missingMaterial.LEMMACOMPUTER_LITELLM_ADMIN_TLS_CA_B64 = "";
  assert.throws(
    () => validateDeploymentEnvironment(missingMaterial, { profile: "hosted", strict: true }),
    /LEMMACOMPUTER_LITELLM_ADMIN_TLS_CA_B64/i,
  );

  const insecureTransport = validHostedEnvironment();
  insecureTransport.LEMMACOMPUTER_LITELLM_ADMIN_URL = "http://litellm-admin-listener:8443";
  assert.throws(
    () => validateDeploymentEnvironment(insecureTransport, { profile: "hosted", strict: true }),
    /HTTPS|LEMMACOMPUTER_LITELLM_ADMIN_URL/i,
  );

  const insecureAlertDestination = validHostedEnvironment();
  insecureAlertDestination.LEMMACOMPUTER_PLATFORM_SECURITY_ALERT_WEBHOOK_URL = "http://security-alerts.example.test/lemma";
  assert.throws(
    () => validateDeploymentEnvironment(insecureAlertDestination, { profile: "hosted", strict: true }),
    /HTTPS|PLATFORM_SECURITY_ALERT_WEBHOOK_URL/i,
  );
});

test("hosted remote nodes require mutual TLS on desktop and application relay routes", () => {
  const missingIngressIdentity = validHostedEnvironment();
  missingIngressIdentity.LEMMACOMPUTER_WORKSPACE_INGRESS_TLS_CLIENT_CERT_B64 = "";
  assert.throws(
    () => validateDeploymentEnvironment(missingIngressIdentity, { profile: "hosted", strict: true }),
    /WORKSPACE_INGRESS_TLS_CLIENT_CERT_B64/i,
  );

  const missingApplicationIdentity = validHostedEnvironment();
  missingApplicationIdentity.LEMMACOMPUTER_WORKSPACE_NODE_APPLICATION_TLS_CLIENT_KEY_B64 = "";
  assert.throws(
    () => validateDeploymentEnvironment(missingApplicationIdentity, { profile: "hosted", strict: true }),
    /WORKSPACE_NODE_APPLICATION_TLS_CLIENT_KEY_B64/i,
  );
});

test("hosted validation rejects secret reuse and raw Telegram token compatibility mode", () => {
  const reusedSessionSecret = validHostedEnvironment();
  reusedSessionSecret.LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET = reusedSessionSecret.LEMMACOMPUTER_BETTER_AUTH_SECRET;
  assert.throws(
    () => validateDeploymentEnvironment(reusedSessionSecret, { profile: "hosted", strict: true }),
    /customer authentication.*distinct|must be distinct/i,
  );

  const reusedIngressSecret = validHostedEnvironment();
  reusedIngressSecret.LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET = reusedIngressSecret.LEMMACOMPUTER_WORKSPACE_INGRESS_SECRET;
  assert.throws(
    () => validateDeploymentEnvironment(reusedIngressSecret, { profile: "hosted", strict: true }),
    /workspace ingress secrets must be distinct|must not equal/i,
  );

  const legacyTelegram = validHostedEnvironment();
  legacyTelegram.LEMMACOMPUTER_TELEGRAM_RAW_TOKEN_INPUT_MODE = "legacy";
  assert.throws(
    () => validateDeploymentEnvironment(legacyTelegram, { profile: "hosted", strict: true }),
    /TELEGRAM_RAW_TOKEN_INPUT_MODE.*reject|broker-only/i,
  );
});

test("hosted validation requires an isolated platform-operator passkey realm", () => {
  const missingOperatorIdentity = validHostedEnvironment();
  missingOperatorIdentity.LEMMACOMPUTER_PLATFORM_AUTH_BOOTSTRAP_EMAIL = "";
  assert.throws(
    () => validateDeploymentEnvironment(missingOperatorIdentity, { profile: "hosted", strict: true }),
    /PLATFORM_AUTH_BOOTSTRAP_EMAIL.*required/i,
  );

  const enrolledDeployment = validHostedEnvironment();
  enrolledDeployment.LEMMACOMPUTER_PLATFORM_AUTH_BOOTSTRAP_SECRET = "";
  assert.doesNotThrow(
    () => validateDeploymentEnvironment(enrolledDeployment, { profile: "hosted", strict: true }),
  );
});

test("profile validation rejects workspace and hosted-control contradictions", () => {
  const localHosted = validHostedEnvironment();
  localHosted.LEMMACOMPUTER_WORKSPACE_NODE_TOPOLOGY = "colocated";
  assert.throws(
    () => validateDeploymentEnvironment(localHosted, { profile: "hosted", strict: true }),
    /local-operator-controlled workspace execution is not allowed/i,
  );

  const hostedControlInCustomerDeployment = validCustomerManagedEnvironment();
  hostedControlInCustomerDeployment.LEMMACOMPUTER_HOSTED_MCP_EGRESS_ORIGINS = "https://hosted-control.example.test";
  assert.throws(
    () => validateDeploymentEnvironment(hostedControlInCustomerDeployment, { profile: "customer-managed", strict: true }),
    /HOSTED_MCP_EGRESS_ORIGINS is hosted-only/i,
  );

  const platformOperatorInCustomerDeployment = validCustomerManagedEnvironment();
  platformOperatorInCustomerDeployment.LEMMACOMPUTER_PLATFORM_AUTH_BOOTSTRAP_EMAIL = "operator@example.test";
  assert.throws(
    () => validateDeploymentEnvironment(platformOperatorInCustomerDeployment, { profile: "customer-managed", strict: true }),
    /PLATFORM_AUTH_BOOTSTRAP_EMAIL.*hosted-only/i,
  );
});

test("strict validation rejects unregistered LEMMACOMPUTER variables", () => {
  assert.throws(
    () => validateDeploymentEnvironment({
      ...validHostedEnvironment(),
      LEMMACOMPUTER_UNREGISTERED_FLAG: "unexpected",
    }, { profile: "hosted", strict: true }),
    /LEMMACOMPUTER_UNREGISTERED_FLAG.*unknown|unknown.*LEMMACOMPUTER_UNREGISTERED_FLAG/i,
  );
});

test("service projections preserve credential and TLS key custody", () => {
  const services = projectServiceEnvironment(validHostedEnvironment());

  assert.ok("CHANNEL_CREDENTIAL_SECRET" in services["channel-broker"]);
  assert.ok("TELEGRAM_INTAKE_ENCRYPTION_PRIVATE_KEY_B64" in services["channel-broker"]);
  assert.ok(!("CHANNEL_CREDENTIAL_SECRET" in services["control-api"]));
  assert.ok(!("TELEGRAM_INTAKE_ENCRYPTION_PRIVATE_KEY_B64" in services["control-api"]));
  assert.ok("TELEGRAM_INTAKE_ENCRYPTION_PUBLIC_KEY_B64" in services["control-api"]);
  assert.ok("LITELLM_ADMIN_PROXY_TLS_SERVER_KEY_B64" in services["litellm-admin-proxy"]);
  assert.ok(!("LITELLM_ADMIN_PROXY_TLS_SERVER_KEY_B64" in services["control-api"]));
  assert.ok("LITELLM_ADMIN_TLS_CLIENT_KEY_B64" in services["control-api"]);
  assert.ok(!("LITELLM_ADMIN_TLS_CLIENT_KEY_B64" in services["litellm-admin-proxy"]));
  assert.ok("WORKSPACE_INGRESS_TLS_CLIENT_KEY_B64" in services["workspace-ingress"]);
  assert.ok(!("WORKSPACE_INGRESS_TLS_CLIENT_KEY_B64" in services["workspace-controller"]));
  assert.ok("WORKSPACE_NODE_APPLICATION_TLS_CLIENT_KEY_B64" in services["workspace-controller"]);
  assert.ok(!("WORKSPACE_NODE_APPLICATION_TLS_CLIENT_KEY_B64" in services["workspace-ingress"]));
  assert.ok(!("LEMMACOMPUTER_WEB_PROXY_TOKEN" in services["channel-broker"]));
  assert.ok("PLATFORM_AUTH_DATABASE_URL" in services["control-api"]);
  assert.ok("PLATFORM_BETTER_AUTH_SECRETS" in services["control-api"]);
  assert.ok("PLATFORM_AUTH_BOOTSTRAP_SECRET" in services["control-api"]);
  assert.match(serializeEnvironment(services["channel-broker"]), /^CHANNEL_CREDENTIAL_SECRET=/m);
});

test("worktree platform authentication uses isolated credentials projected only to its owners", () => {
  const values = validCustomerManagedEnvironment();
  values.LEMMACOMPUTER_INSTALLATION_KIND = "worktree";
  values.LEMMACOMPUTER_RUNTIME_ENVIRONMENT = "development";
  const services = projectServiceEnvironment(values);

  assert.match(services["control-api"].PLATFORM_AUTH_DATABASE_URL, /lemmacomputer_platform_auth_runtime/);
  assert.equal(services["control-api"].PLATFORM_AUTH_BOOTSTRAP_SECRET, values.LEMMACOMPUTER_PLATFORM_AUTH_BOOTSTRAP_SECRET);
  assert.match(services["platform-auth-db-migrate"].AUTH_DATABASE_URL, /lemmacomputer_platform_auth_migrator/);
  assert.ok(!("PLATFORM_BETTER_AUTH_SECRETS" in services.web));
  assert.ok(!("PLATFORM_AUTH_BOOTSTRAP_SECRET" in services.web));

  assert.throws(
    () => validateDeploymentEnvironment({
      ...values,
      LEMMACOMPUTER_PLATFORM_BETTER_AUTH_SECRET: values.LEMMACOMPUTER_BETTER_AUTH_SECRET,
    }, { profile: "worktree", strict: true }),
    /authentication secrets.*distinct/i,
  );
});

test("the hosted Compose overlay does not select a deployment policy", async () => {
  const hostedOverlay = await readFile(new URL("../compose.hosted.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(hostedOverlay, /^\s+LEMMACOMPUTER_INSTALLATION_KIND:\s*hosted\s*$/m);
  assert.doesNotMatch(hostedOverlay, /^\s+LITELLM_ADMIN_URL:\s*https:\/\//m);
});

test("reference service env files use raw Compose parsing and renderer repairs restrictive permissions", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  const serviceNames = Object.keys(projectServiceEnvironment());
  const rawServiceNames = [...compose.matchAll(/env_file:\s*\n\s*- path: \.runtime-env\/([^\s]+)\.env\s*\n\s*format: raw/g)].map(([, name]) => name);
  assert.deepEqual(new Set(rawServiceNames), new Set(serviceNames));

  const root = await mkdtemp(join(tmpdir(), "lemmacomputer-service-env-"));
  const source = join(root, "deployment.env");
  const destination = join(root, "service-env");
  try {
    await writeFile(source, initializedCustomerManagedEnvironment(), { mode: 0o600 });
    await mkdir(destination, { mode: 0o755 });
    const existing = join(destination, "control-api.env");
    await writeFile(existing, "stale=true\n", { mode: 0o644 });
    const rendered = spawnSync(process.execPath, [
      new URL("../scripts/render-service-env.mjs", import.meta.url).pathname,
      `--file=${source}`,
      `--directory=${destination}`,
    ], { encoding: "utf8" });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.equal((await stat(destination)).mode & 0o777, 0o700);
    assert.equal((await stat(existing)).mode & 0o777, 0o600);
    assert.equal(
      await readFile(existing, "utf8"),
      serializeEnvironment(projectServiceEnvironment(Object.fromEntries(parseEnvironment(await readFile(source, "utf8")).values))["control-api"]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("raw Compose env files preserve secret literals without interpolation", async (t) => {
  const docker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  const image = spawnSync("docker", ["image", "inspect", "alpine:3.22"], { encoding: "utf8" });
  if (docker.status !== 0 || image.status !== 0) {
    t.skip("Docker Compose or the local Alpine test image is unavailable in this test environment");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "lemmacomputer-raw-env-"));
  const project = `lemmacomputer-raw-env-${root.split("-").at(-1)?.toLowerCase()}`;
  const literal = " leading $VALUE # quote' and backslash\\ trailing ";
  try {
    await writeFile(join(root, "service.env"), serializeEnvironment({ TEST_SECRET: literal }), { mode: 0o600 });
    await writeFile(join(root, "compose.yaml"), [
      "services:",
      "  app:",
      "    image: alpine:3.22",
      "    network_mode: none",
      "    env_file:",
      "      - path: ./service.env",
      "        format: raw",
      "",
    ].join("\n"));
    const run = spawnSync("docker", ["compose", "--project-name", project, "-f", join(root, "compose.yaml"), "run", "--rm", "--no-deps", "-T", "app", "/bin/sh", "-c", "printf %s \"$TEST_SECRET\""], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, literal);
  } finally {
    spawnSync("docker", ["compose", "--project-name", project, "-f", join(root, "compose.yaml"), "down", "--remove-orphans"], { encoding: "utf8" });
    await rm(root, { recursive: true, force: true });
  }
});
