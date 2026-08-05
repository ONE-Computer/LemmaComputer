import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  environmentContract,
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

const lemmacomputerReferences = (contents: string) => new Set(
  [...contents.matchAll(/\$\{(LEMMACOMPUTER_[A-Z0-9_]+)/g)].map(([, key]) => key),
);

const assignmentKeys = (contents: string) => (
  [...contents.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(([, key]) => key)
);

const registeredKeys = () => new Set(environmentContract.map(({ key }) => key));

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
    LEMMACOMPUTER_PUBLIC_WEB_URL: "https://hosted.example.test",
    LEMMACOMPUTER_SANDBOX_DRIVER: "kasm",
    LEMMACOMPUTER_KASM_BASE_URL: "https://workspace.example.test",
    LEMMACOMPUTER_KASM_API_KEY: "test-kasm-api-key",
    LEMMACOMPUTER_KASM_API_SECRET: "test-kasm-api-secret",
    LEMMACOMPUTER_KASM_USER_ID: "test-kasm-user",
    LEMMACOMPUTER_KASM_IMAGE_ID: "test-kasm-image",
    LEMMACOMPUTER_LITELLM_ADMIN_URL: "https://litellm-admin-listener:8443",
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_CA_B64: pemBase64("CERTIFICATE"),
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_CERT_B64: pemBase64("CERTIFICATE"),
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_KEY_B64: pemBase64("PRIVATE KEY"),
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_CERT_B64: pemBase64("CERTIFICATE"),
    LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_KEY_B64: pemBase64("PRIVATE KEY"),
    LEMMACOMPUTER_TELEGRAM_RAW_TOKEN_INPUT_MODE: "reject",
    LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET: "credential-secret-that-is-long-enough-0000001",
    LEMMACOMPUTER_SESSION_SECRET: "session-secret-that-is-long-enough-0000000001",
    LEMMACOMPUTER_WORKSPACE_INGRESS_SECRET: "ingress-secret-that-is-long-enough-0000000001",
  });
  return values;
};

const validCustomerManagedEnvironment = () => {
  const initialized = initializeEnvironment(renderEnvironmentTemplate(), "Etc/UTC");
  const values = Object.fromEntries(parseEnvironment(initialized).values);
  Object.assign(values, {
    LEMMACOMPUTER_INSTALLATION_KIND: "customer-managed",
    LEMMACOMPUTER_ENTRA_TENANT_ID: "customer-directory-tenant",
    LEMMACOMPUTER_ENTRA_CLIENT_ID: "customer-application-client",
    LEMMACOMPUTER_ENTRA_CLIENT_SECRET: "customer-application-secret",
  });
  return values;
};

const initializedCustomerManagedEnvironment = () => initializeEnvironment(
  renderEnvironmentTemplate(),
  "Etc/UTC",
).replace(
  "LEMMACOMPUTER_ENTRA_TENANT_ID=replace-with-entra-directory-tenant-id",
  "LEMMACOMPUTER_ENTRA_TENANT_ID=customer-directory-tenant",
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
    assert.equal(typeof entry.section, "string");
    assert.ok(entry.section.length > 0);
    return entry.key;
  });
  assert.equal(new Set(keys).size, keys.length, "contract keys must be unique");

  const rendered = renderEnvironmentTemplate();
  const checkedIn = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.equal(rendered, checkedIn, ".env.example must be generated from the contract without manual drift");
  assert.deepEqual(assignmentKeys(rendered), keys, "the template must list every registered operator variable once");

  const installationKind = environmentContract.find(({ key }) => key === "LEMMACOMPUTER_INSTALLATION_KIND");
  assert.equal(installationKind?.key, "LEMMACOMPUTER_INSTALLATION_KIND");
  assert.equal(installationKind?.default, "customer-managed");
  const credentialSecret = environmentContract.find(({ key }) => key === "LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET");
  assert.equal(credentialSecret?.generated, true);
  assert.equal(credentialSecret?.secret, true);
});

test("every production Compose operator reference and worktree override is registered", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  const keys = registeredKeys();
  const unregisteredComposeReferences = [...lemmacomputerReferences(compose)].filter((key) => !keys.has(key));
  assert.deepEqual(unregisteredComposeReferences, [], "Compose must not introduce an unregistered operator variable");

  const overrides = worktreeEnvironmentOverrides({
    slug: "oc-a1b2c3d4e5",
    id: "a1b2c3d4e5",
    portOffset: 1234,
  });
  assert.ok(overrides instanceof Map);
  assert.equal(overrides.get("LEMMACOMPUTER_COMPOSE_PROJECT_NAME"), "oc-a1b2c3d4e5");
  assert.equal(overrides.get("LEMMACOMPUTER_WEB_PORT"), "5408");
  assert.equal(overrides.get("LEMMACOMPUTER_INSTALLATION_KIND"), "worktree");
  assert.deepEqual([...overrides.keys()].filter((key) => !keys.has(key)), [], "worktree initialization must not create unregistered configuration");
});

test("qualification Compose inputs are registered separately from deployment inputs", async () => {
  const [oauthCompose, providerCompose, qualificationExample] = await Promise.all([
    readFile(new URL("../compose.oauth-qualification.yaml", import.meta.url), "utf8"),
    readFile(new URL("../compose.provider-qualification.yaml", import.meta.url), "utf8"),
    readFile(new URL("../.env.qualification.example", import.meta.url), "utf8"),
  ]);
  const references = [...lemmacomputerReferences(oauthCompose), ...lemmacomputerReferences(providerCompose)];
  assert.deepEqual(references.filter((key) => !allEnvironmentVariableNameSet.has(key)), []);
  assert.equal(qualificationExample, renderQualificationEnvironmentTemplate());
});

test("a complete hosted configuration passes the shared profile validation", () => {
  assert.doesNotThrow(() => validateDeploymentEnvironment(validHostedEnvironment(), {
    profile: "hosted",
    strict: true,
  }));
});

test("a complete customer-managed configuration passes the shared profile validation", () => {
  assert.doesNotThrow(() => validateDeploymentEnvironment(validCustomerManagedEnvironment(), {
    profile: "customer-managed",
    strict: true,
  }));
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
});

test("hosted validation rejects secret reuse and raw Telegram token compatibility mode", () => {
  const reusedSessionSecret = validHostedEnvironment();
  reusedSessionSecret.LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET = reusedSessionSecret.LEMMACOMPUTER_SESSION_SECRET;
  assert.throws(
    () => validateDeploymentEnvironment(reusedSessionSecret, { profile: "hosted", strict: true }),
    /LITELLM_CREDENTIAL_SECRET.*SESSION_SECRET|must not equal/i,
  );

  const reusedIngressSecret = validHostedEnvironment();
  reusedIngressSecret.LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET = reusedIngressSecret.LEMMACOMPUTER_WORKSPACE_INGRESS_SECRET;
  assert.throws(
    () => validateDeploymentEnvironment(reusedIngressSecret, { profile: "hosted", strict: true }),
    /LITELLM_CREDENTIAL_SECRET.*WORKSPACE_INGRESS_SECRET|must not equal/i,
  );

  const legacyTelegram = validHostedEnvironment();
  legacyTelegram.LEMMACOMPUTER_TELEGRAM_RAW_TOKEN_INPUT_MODE = "legacy";
  assert.throws(
    () => validateDeploymentEnvironment(legacyTelegram, { profile: "hosted", strict: true }),
    /TELEGRAM_RAW_TOKEN_INPUT_MODE.*reject|broker-only/i,
  );
});

test("profile validation rejects workspace and hosted-control contradictions", () => {
  const localHosted = validHostedEnvironment();
  localHosted.LEMMACOMPUTER_SANDBOX_DRIVER = "kasm-local";
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

  const unconfiguredCustomerIssuer = validCustomerManagedEnvironment();
  unconfiguredCustomerIssuer.LEMMACOMPUTER_ENTRA_TENANT_ID = "replace-with-entra-directory-tenant-id";
  assert.throws(
    () => validateDeploymentEnvironment(unconfiguredCustomerIssuer, { profile: "customer-managed", strict: true }),
    /ENTRA_TENANT_ID must identify the customer directory/i,
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
  assert.ok(!("LEMMACOMPUTER_WEB_PROXY_TOKEN" in services["channel-broker"]));
  assert.match(serializeEnvironment(services["channel-broker"]), /^CHANNEL_CREDENTIAL_SECRET=/m);
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
