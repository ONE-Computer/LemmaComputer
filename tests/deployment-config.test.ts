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

const onecomputerReferences = (contents: string) => new Set(
  [...contents.matchAll(/\$\{(ONECOMPUTER_[A-Z0-9_]+)/g)].map(([, key]) => key),
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
    ONECOMPUTER_INSTALLATION_KIND: "hosted",
    ONECOMPUTER_LITELLM_ADMIN_URL: "https://litellm-admin-listener:8443",
    ONECOMPUTER_LITELLM_ADMIN_TLS_CA_B64: pemBase64("CERTIFICATE"),
    ONECOMPUTER_LITELLM_ADMIN_TLS_SERVER_CERT_B64: pemBase64("CERTIFICATE"),
    ONECOMPUTER_LITELLM_ADMIN_TLS_SERVER_KEY_B64: pemBase64("PRIVATE KEY"),
    ONECOMPUTER_LITELLM_ADMIN_TLS_CLIENT_CERT_B64: pemBase64("CERTIFICATE"),
    ONECOMPUTER_LITELLM_ADMIN_TLS_CLIENT_KEY_B64: pemBase64("PRIVATE KEY"),
    ONECOMPUTER_TELEGRAM_RAW_TOKEN_INPUT_MODE: "reject",
    ONECOMPUTER_LITELLM_CREDENTIAL_SECRET: "credential-secret-that-is-long-enough-0000001",
    ONECOMPUTER_SESSION_SECRET: "session-secret-that-is-long-enough-0000000001",
    ONECOMPUTER_WORKSPACE_INGRESS_SECRET: "ingress-secret-that-is-long-enough-0000000001",
  });
  return values;
};

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

  const installationKind = environmentContract.find(({ key }) => key === "ONECOMPUTER_INSTALLATION_KIND");
  assert.equal(installationKind?.key, "ONECOMPUTER_INSTALLATION_KIND");
  assert.equal(installationKind?.default, "customer-managed");
  const credentialSecret = environmentContract.find(({ key }) => key === "ONECOMPUTER_LITELLM_CREDENTIAL_SECRET");
  assert.equal(credentialSecret?.generated, true);
  assert.equal(credentialSecret?.secret, true);
});

test("every production Compose operator reference and worktree override is registered", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  const keys = registeredKeys();
  const unregisteredComposeReferences = [...onecomputerReferences(compose)].filter((key) => !keys.has(key));
  assert.deepEqual(unregisteredComposeReferences, [], "Compose must not introduce an unregistered operator variable");

  const overrides = worktreeEnvironmentOverrides({
    slug: "oc-a1b2c3d4e5",
    id: "a1b2c3d4e5",
    portOffset: 1234,
  });
  assert.ok(overrides instanceof Map);
  assert.equal(overrides.get("ONECOMPUTER_COMPOSE_PROJECT_NAME"), "oc-a1b2c3d4e5");
  assert.equal(overrides.get("ONECOMPUTER_WEB_PORT"), "5408");
  assert.equal(overrides.get("ONECOMPUTER_INSTALLATION_KIND"), "worktree");
  assert.deepEqual([...overrides.keys()].filter((key) => !keys.has(key)), [], "worktree initialization must not create unregistered configuration");
});

test("qualification Compose inputs are registered separately from deployment inputs", async () => {
  const [oauthCompose, providerCompose, qualificationExample] = await Promise.all([
    readFile(new URL("../compose.oauth-qualification.yaml", import.meta.url), "utf8"),
    readFile(new URL("../compose.provider-qualification.yaml", import.meta.url), "utf8"),
    readFile(new URL("../.env.qualification.example", import.meta.url), "utf8"),
  ]);
  const references = [...onecomputerReferences(oauthCompose), ...onecomputerReferences(providerCompose)];
  assert.deepEqual(references.filter((key) => !allEnvironmentVariableNameSet.has(key)), []);
  assert.equal(qualificationExample, renderQualificationEnvironmentTemplate());
});

test("a complete hosted configuration passes the shared profile validation", () => {
  assert.doesNotThrow(() => validateDeploymentEnvironment(validHostedEnvironment(), {
    profile: "hosted",
    strict: true,
  }));
});

test("env:update normalizes a historical blank LiteLLM admin URL to the catalog default", () => {
  const template = renderEnvironmentTemplate();
  const initialized = initializeEnvironment(template, "Etc/UTC");
  const merged = mergeEnvironment(template, "ONECOMPUTER_LITELLM_ADMIN_URL=\n", initialized);
  const values = Object.fromEntries(parseEnvironment(merged.contents).values);
  const services = projectServiceEnvironment(values);

  assert.equal(values.ONECOMPUTER_LITELLM_ADMIN_URL, "http://litellm-admin-listener:8443");
  assert.equal(services["control-api"].LITELLM_ADMIN_URL, "http://litellm-admin-listener:8443");
});

test("hosted validation fails closed for missing or non-HTTPS LiteLLM mutual TLS", () => {
  const missingMaterial = validHostedEnvironment();
  missingMaterial.ONECOMPUTER_LITELLM_ADMIN_TLS_CA_B64 = "";
  assert.throws(
    () => validateDeploymentEnvironment(missingMaterial, { profile: "hosted", strict: true }),
    /ONECOMPUTER_LITELLM_ADMIN_TLS_CA_B64/i,
  );

  const insecureTransport = validHostedEnvironment();
  insecureTransport.ONECOMPUTER_LITELLM_ADMIN_URL = "http://litellm-admin-listener:8443";
  assert.throws(
    () => validateDeploymentEnvironment(insecureTransport, { profile: "hosted", strict: true }),
    /HTTPS|ONECOMPUTER_LITELLM_ADMIN_URL/i,
  );
});

test("hosted validation rejects secret reuse and raw Telegram token compatibility mode", () => {
  const reusedSessionSecret = validHostedEnvironment();
  reusedSessionSecret.ONECOMPUTER_LITELLM_CREDENTIAL_SECRET = reusedSessionSecret.ONECOMPUTER_SESSION_SECRET;
  assert.throws(
    () => validateDeploymentEnvironment(reusedSessionSecret, { profile: "hosted", strict: true }),
    /LITELLM_CREDENTIAL_SECRET.*SESSION_SECRET|must not equal/i,
  );

  const reusedIngressSecret = validHostedEnvironment();
  reusedIngressSecret.ONECOMPUTER_LITELLM_CREDENTIAL_SECRET = reusedIngressSecret.ONECOMPUTER_WORKSPACE_INGRESS_SECRET;
  assert.throws(
    () => validateDeploymentEnvironment(reusedIngressSecret, { profile: "hosted", strict: true }),
    /LITELLM_CREDENTIAL_SECRET.*WORKSPACE_INGRESS_SECRET|must not equal/i,
  );

  const legacyTelegram = validHostedEnvironment();
  legacyTelegram.ONECOMPUTER_TELEGRAM_RAW_TOKEN_INPUT_MODE = "legacy";
  assert.throws(
    () => validateDeploymentEnvironment(legacyTelegram, { profile: "hosted", strict: true }),
    /TELEGRAM_RAW_TOKEN_INPUT_MODE.*reject|broker-only/i,
  );
});

test("strict validation rejects unregistered ONECOMPUTER variables", () => {
  assert.throws(
    () => validateDeploymentEnvironment({
      ...validHostedEnvironment(),
      ONECOMPUTER_UNREGISTERED_FLAG: "unexpected",
    }, { profile: "hosted", strict: true }),
    /ONECOMPUTER_UNREGISTERED_FLAG.*unknown|unknown.*ONECOMPUTER_UNREGISTERED_FLAG/i,
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
  assert.ok(!("ONECOMPUTER_WEB_PROXY_TOKEN" in services["channel-broker"]));
  assert.match(serializeEnvironment(services["channel-broker"]), /^CHANNEL_CREDENTIAL_SECRET=/m);
});

test("the hosted Compose overlay does not select a deployment policy", async () => {
  const hostedOverlay = await readFile(new URL("../compose.hosted.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(hostedOverlay, /^\s+ONECOMPUTER_INSTALLATION_KIND:\s*hosted\s*$/m);
  assert.doesNotMatch(hostedOverlay, /^\s+LITELLM_ADMIN_URL:\s*https:\/\//m);
});

test("reference service env files use raw Compose parsing and renderer repairs restrictive permissions", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  const serviceNames = Object.keys(projectServiceEnvironment());
  const rawServiceNames = [...compose.matchAll(/env_file:\s*\n\s*- path: \.runtime-env\/([^\s]+)\.env\s*\n\s*format: raw/g)].map(([, name]) => name);
  assert.deepEqual(new Set(rawServiceNames), new Set(serviceNames));

  const root = await mkdtemp(join(tmpdir(), "onecomputer-service-env-"));
  const source = join(root, "deployment.env");
  const destination = join(root, "service-env");
  try {
    await writeFile(source, initializeEnvironment(renderEnvironmentTemplate(), "Etc/UTC"), { mode: 0o600 });
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

  const root = await mkdtemp(join(tmpdir(), "onecomputer-raw-env-"));
  const project = `onecomputer-raw-env-${root.split("-").at(-1)?.toLowerCase()}`;
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
