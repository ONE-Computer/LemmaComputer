import {
  assertWorkspaceDriverTopologyAllowed,
  resolveDeploymentProfile,
} from "../packages/deployment-profile/src/index.mjs";

/**
 * The deployment environment contract is the single source of truth for
 * operator-provided configuration.  Compose is deliberately not a source of
 * defaults or policy: it consumes the per-service projections rendered here.
 */

const generated = "generated-by-env-init";

const section = (name, description, variables) => ({ name, description, variables });
const variable = (key, defaultValue, description, options = {}) => {
  const { generated: generator, ...metadata } = options;
  return {
    key,
    default: defaultValue,
    description,
    ...metadata,
    ...(generator ? { generated: true, generator } : {}),
  };
};

const sections = [
  section("Deployment profile and local topology", "Set the profile explicitly for every deployment. Worktree values are replaced by npm run worktree:init.", [
    variable("LEMMACOMPUTER_INSTALLATION_KIND", "customer-managed", "Deployment profile: customer-managed, hosted, or worktree.", { kind: "enum", values: ["customer-managed", "hosted", "worktree"] }),
    variable("LEMMACOMPUTER_COMPOSE_PROJECT_NAME", "lemmacomputer", "Compose project name. Keep this unique for each local worktree."),
    variable("LEMMACOMPUTER_IMAGE_TAG", "dev", "LemmaComputer control-runtime and workspace image tag."),
    variable("LEMMACOMPUTER_APP_VERSION", "dev", "Version recorded with schema and operational events."),
    variable("LEMMACOMPUTER_MS365_IMAGE_TAG", "0.131.2", "Microsoft 365 MCP image tag used by the reference deployment."),
    variable("LEMMACOMPUTER_CONTROL_NETWORK", "lemmacomputer-control", "Private Docker network name used by local Kasm workspaces."),
    variable("LEMMACOMPUTER_CONTROL_CONTAINER", "lemmacomputer-control-api", "Control API container name used by the local Kasm adapter."),
    variable("LEMMACOMPUTER_LITELLM_CONTAINER", "lemmacomputer-litellm", "LiteLLM container name used by the local Kasm adapter."),
    variable("LEMMACOMPUTER_HTTP_BIND_ADDRESS", "127.0.0.1", "Address used for reference-stack published ports."),
  ]),
  section("Public endpoints", "Use externally reachable HTTPS URLs in production. The reference stack binds loopback ports by default.", [
    variable("LEMMACOMPUTER_WEB_PORT", "4174", "Published LemmaComputer Web and workspace-ingress port.", { kind: "integer" }),
    variable("LEMMACOMPUTER_PUBLIC_WEB_URL", "http://localhost:4174", "Public Web and workspace ingress base URL.", { kind: "url" }),
  ]),
  section("LiteLLM administration mutual TLS", "Hosted deployments must set an HTTPS admin URL and inject every certificate value from the deployment secret manager.", [
    variable("LEMMACOMPUTER_LITELLM_ADMIN_URL", "http://litellm-admin-listener:8443", "Control-to-LiteLLM administration listener URL.", { kind: "url" }),
    variable("LEMMACOMPUTER_LITELLM_ADMIN_TLS_CA_B64", "", "Base64 PEM certificate authority for the private admin listener.", { secret: true }),
    variable("LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_CERT_B64", "", "Base64 PEM server certificate for the private admin listener.", { secret: true }),
    variable("LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_KEY_B64", "", "Base64 PEM server private key for the private admin listener.", { secret: true }),
    variable("LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_CERT_B64", "", "Base64 PEM Control client certificate for the private admin listener.", { secret: true }),
    variable("LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_KEY_B64", "", "Base64 PEM Control client private key for the private admin listener.", { secret: true }),
    variable("LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_NAME", "litellm-admin-listener", "Expected TLS server name for Control's private admin client."),
    variable("LEMMACOMPUTER_LITELLM_ADMIN_CLIENT_COMMON_NAME", "lemmacomputer-control", "Required Control client certificate common name at the private admin listener."),
  ]),
  section("Custom MCP egress", "Hosted custom MCP destinations are approved by the deployment and network owner, not by a tenant-local administrator.", [
    variable("LEMMACOMPUTER_HOSTED_MCP_EGRESS_ORIGINS", "", "Comma-separated exact HTTPS origins for hosted custom MCP and OAuth flows, including endpoint, metadata, authorization, token, and dynamic-client-registration origins. Customer-managed installations can leave this empty."),
  ]),
  section("Runtime limits and security switches", "These are deployment controls, not Compose defaults. Keep the secure hosted Telegram setting explicit.", [
    variable("LEMMACOMPUTER_WORKSPACE_INGRESS_LAUNCH_TTL_SECONDS", "300", "Signed workspace-launch token lifetime in seconds.", { kind: "integer" }),
    variable("LEMMACOMPUTER_WORKSPACE_INGRESS_SESSION_TTL_SECONDS", "28800", "Workspace ingress session lifetime in seconds.", { kind: "integer" }),
    variable("LEMMACOMPUTER_WORKSPACE_INGRESS_VERIFY_UPSTREAM_TLS", "false", "Whether workspace ingress verifies TLS for its configured internal upstreams.", { kind: "boolean" }),
    variable("LEMMACOMPUTER_AGENT_BRIDGE_GRANT_TTL_SECONDS", "900", "Agent bridge grant lifetime in seconds.", { kind: "integer" }),
    variable("LEMMACOMPUTER_GATEWAY_GRANT_RENEWAL_INTERVAL_SECONDS", "900", "Gateway grant renewal interval in seconds.", { kind: "integer" }),
    variable("LEMMACOMPUTER_CHANNEL_POLL_INTERVAL_MS", "1000", "Channel broker polling interval in milliseconds.", { kind: "integer" }),
    variable("LEMMACOMPUTER_TELEGRAM_COMPOSITION_WINDOW_MS", "1500", "Telegram composition batching window in milliseconds.", { kind: "integer" }),
    variable("LEMMACOMPUTER_TELEGRAM_RAW_TOKEN_INPUT_MODE", "", "Set reject for hosted deployments. Empty keeps the safe runtime default for the selected profile.", { kind: "enum", values: ["", "legacy", "reject"] }),
    variable("LEMMACOMPUTER_TELEGRAM_INTAKE_GRANT_TTL_SECONDS", "300", "Telegram broker token-intake grant lifetime in seconds.", { kind: "integer" }),
    variable("LEMMACOMPUTER_CHAT_ATTACHMENT_RETENTION_DAYS", "90", "Attachment retention period in days.", { kind: "integer" }),
    variable("LEMMACOMPUTER_SCHEDULER_POLL_INTERVAL_MS", "5000", "Scheduler worker polling interval in milliseconds.", { kind: "integer" }),
    variable("LEMMACOMPUTER_SCHEDULER_CLAIM_LIMIT", "10", "Maximum schedules claimed by one polling pass.", { kind: "integer" }),
    variable("LEMMACOMPUTER_SCHEDULER_CLAIM_LEASE_MS", "120000", "Schedule claim lease duration in milliseconds.", { kind: "integer" }),
    variable("LEMMACOMPUTER_POLICY_BUNDLE_TTL_SECONDS", "86400", "Signed policy bundle lifetime in seconds.", { kind: "integer" }),
  ]),
  section("Generated service, encryption, and internal-authentication secrets", "npm run env:init replaces every generated-by-env-init value with a distinct local secret. Production secrets belong in a secret manager.", [
    variable("LEMMACOMPUTER_WEB_PROXY_TOKEN", generated, "Web-to-Control proxy bearer token.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_CONTROLLER_TOKEN", generated, "Control-to-workspace-controller bearer token.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_POSTGRES_PASSWORD", generated, "LemmaComputer PostgreSQL password.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_LITELLM_MASTER_KEY", generated, "LiteLLM master key.", { secret: true, generated: "master-key" }),
    variable("LEMMACOMPUTER_LITELLM_SALT_KEY", generated, "LiteLLM credential-encryption salt.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET", generated, "LiteLLM credential encryption secret. It must remain distinct from session and ingress secrets.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_LITELLM_POSTGRES_PASSWORD", generated, "LiteLLM PostgreSQL password.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_FIXTURE_APPROVAL_SECRET", generated, "Fixture-only approval secret for local qualification flows.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_SESSION_SECRET", generated, "Web session signing secret.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_WORKSPACE_INGRESS_SECRET", generated, "Workspace ingress signing secret.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_EGRESS_GRANT_SECRET", generated, "Egress grant derivation secret.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_GATEWAY_EGRESS_PROXY_TOKEN", generated, "LiteLLM credential for the static model-provider egress proxy.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_REMOTE_MCP_EGRESS_PROXY_TOKEN", generated, "LiteLLM credential for the strict remote-MCP egress proxy.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_MCP_EGRESS_PROXY_TOKEN", generated, "Remote MCP proxy credential for its narrow Control authorization callback.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_AGENT_BRIDGE_SECRET", generated, "Dedicated agent bridge signing secret.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_HERMES_API_SECRET", generated, "Agent chat internal authentication secret.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_CHANNEL_CREDENTIAL_SECRET", generated, "Channel broker credential-vault encryption secret.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_CHANNEL_BROKER_TOKEN", generated, "Control-to-channel-broker bearer token.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_SCHEDULE_PROMPT_SECRET", generated, "Scheduler prompt signing secret.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_SCHEDULER_TOKEN", generated, "Scheduler-to-Control bearer token.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_AI_USAGE_TOKEN", generated, "LiteLLM-to-Control usage bearer token.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_AI_USAGE_TASK_BINDING_SECRET", generated, "AI usage task-binding secret.", { secret: true, generated: "random" }),
  ]),
  section("OpenVTC, Web Push, policy, and Telegram key material", "Generated key pairs are coupled. Do not replace only one member of a group.", [
    variable("LEMMACOMPUTER_OPENVTC_EXECUTOR_SEED_B64", generated, "Base64 OpenVTC executor seed.", { secret: true, generated: "seed" }),
    variable("LEMMACOMPUTER_OPENVTC_CONSENT_TOKEN", generated, "OpenVTC consent service bearer token.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_WEB_PUSH_VAPID_SUBJECT", "mailto:security@example.com", "Web Push VAPID subject."),
    variable("LEMMACOMPUTER_WEB_PUSH_VAPID_PUBLIC_KEY", generated, "Web Push VAPID public key.", { generated: "vapid-public" }),
    variable("LEMMACOMPUTER_WEB_PUSH_VAPID_PRIVATE_KEY", generated, "Web Push VAPID private key.", { secret: true, generated: "vapid-private" }),
    variable("LEMMACOMPUTER_WEB_PUSH_SUBSCRIPTION_SECRET", generated, "Web Push subscription encryption secret.", { secret: true, generated: "random" }),
    variable("LEMMACOMPUTER_POLICY_SIGNING_KEY_ID", generated, "Active signed-policy key identifier.", { generated: "policy-key-id" }),
    variable("LEMMACOMPUTER_POLICY_SIGNING_PRIVATE_KEY_B64", generated, "Base64 DER signed-policy private key.", { secret: true, generated: "policy-private" }),
    variable("LEMMACOMPUTER_POLICY_VERIFICATION_KEYS_B64", generated, "Base64 signed-policy verification key set.", { generated: "policy-public-set" }),
    variable("LEMMACOMPUTER_TELEGRAM_INTAKE_GRANT_PRIVATE_KEY_B64", generated, "Base64 DER broker-only Telegram intake grant private key.", { secret: true, generated: "telegram-grant-private" }),
    variable("LEMMACOMPUTER_TELEGRAM_INTAKE_GRANT_PUBLIC_KEY_B64", generated, "Base64 DER Telegram intake grant public key.", { generated: "telegram-grant-public" }),
    variable("LEMMACOMPUTER_TELEGRAM_INTAKE_ENCRYPTION_PRIVATE_KEY_B64", generated, "Base64 DER broker-only Telegram token-envelope private key.", { secret: true, generated: "telegram-envelope-private" }),
    variable("LEMMACOMPUTER_TELEGRAM_INTAKE_ENCRYPTION_PUBLIC_KEY_B64", generated, "Base64 DER Telegram token-envelope public key.", { generated: "telegram-envelope-public" }),
  ]),
  section("Identity, Microsoft 365, and bootstrap", "Replace the Entra placeholders before enabling sign-in. Leave the dedicated Microsoft 365 app values empty to reuse the Web sign-in app.", [
    variable("LEMMACOMPUTER_ENTRA_TENANT_ID", "replace-with-entra-directory-tenant-id", "Microsoft Entra directory tenant ID."),
    variable("LEMMACOMPUTER_ENTRA_CLIENT_ID", "replace-with-entra-application-client-id", "Microsoft Entra Web application client ID."),
    variable("LEMMACOMPUTER_ENTRA_CLIENT_SECRET", "replace-with-entra-application-client-secret", "Microsoft Entra Web application client secret.", { secret: true }),
    variable("LEMMACOMPUTER_EXTERNAL_ID_TENANT_ID", "", "Hosted Microsoft Entra External ID directory tenant ID.", { optional: true }),
    variable("LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN", "", "Hosted External ID ciamlogin.com tenant subdomain.", { optional: true }),
    variable("LEMMACOMPUTER_EXTERNAL_ID_CLIENT_ID", "", "Hosted External ID Web application client ID.", { optional: true }),
    variable("LEMMACOMPUTER_EXTERNAL_ID_CLIENT_SECRET", "", "Hosted External ID Web application client secret.", { optional: true, secret: true }),
    variable("LEMMACOMPUTER_BOOTSTRAP_OWNER_OBJECT_IDS", "replace-with-entra-object-id", "Comma-separated immutable Entra object IDs allowed to perform the one-time owner bootstrap."),
    variable("LEMMACOMPUTER_ADMINISTRATOR_EMAILS", "", "Deprecated compatibility input. Email addresses never grant organization roles."),
    variable("LEMMACOMPUTER_MS365_TENANT_ID", "", "Dedicated Microsoft 365 MCP Entra tenant ID, or blank to reuse the Web sign-in app."),
    variable("LEMMACOMPUTER_MS365_CLIENT_ID", "", "Dedicated Microsoft 365 MCP Entra client ID, or blank to reuse the Web sign-in app."),
    variable("LEMMACOMPUTER_MS365_CLIENT_SECRET", "", "Dedicated Microsoft 365 MCP Entra client secret, or blank to reuse the Web sign-in app.", { secret: true }),
    variable("LEMMACOMPUTER_GITHUB_MCP_CLIENT_ID", "", "GitHub MCP OAuth app client ID."),
    variable("LEMMACOMPUTER_GITHUB_MCP_CLIENT_SECRET", "", "GitHub MCP OAuth app client secret.", { secret: true }),
    variable("LEMMACOMPUTER_BOOTSTRAP_TENANT_ID", "example", "Initial owned tenant identifier."),
    variable("LEMMACOMPUTER_BOOTSTRAP_USER_ID", "bootstrap-admin", "Initial owned administrator identifier."),
    variable("LEMMACOMPUTER_TENANT_DISPLAY_NAME", "Example Organization", "Initial tenant display name."),
  ]),
  section("Microsoft 365 MCP safety limits", "These vendor settings are explicit deployment inputs so every target receives the same safety policy.", [
    variable("LEMMACOMPUTER_MS365_MAX_TOP", "25", "Maximum items per Microsoft Graph request.", { kind: "integer" }),
    variable("LEMMACOMPUTER_MS365_MAX_PAGES", "4", "Maximum Microsoft Graph pages per request.", { kind: "integer" }),
    variable("LEMMACOMPUTER_MS365_MAX_ITEMS", "100", "Maximum aggregate Microsoft Graph items per request.", { kind: "integer" }),
    variable("LEMMACOMPUTER_MS365_REDACT_PII", "true", "Whether Microsoft 365 MCP redacts personally identifiable information.", { kind: "boolean" }),
    variable("LEMMACOMPUTER_MS365_REQUIRE_CONFIRM", "true", "Whether Microsoft 365 MCP requires confirmation for mutations.", { kind: "boolean" }),
    variable("LEMMACOMPUTER_MS365_TRUST_PROXY_HOPS", "0", "Trusted proxy hops for Microsoft 365 MCP.", { kind: "integer" }),
    variable("LEMMACOMPUTER_MS365_LOG_LEVEL", "info", "Microsoft 365 MCP log level."),
  ]),
  section("Workspace driver", "The canonical LEMMACOMPUTER_* names replace legacy SANDBOX_DRIVER and KASM_* inputs. env:update migrates existing values without rotation.", [
    variable("LEMMACOMPUTER_SANDBOX_DRIVER", "kasm-local", "Workspace driver: kasm-local or kasm.", { kind: "enum", values: ["kasm-local", "kasm"] }),
    variable("LEMMACOMPUTER_WORKSPACE_IMAGE", "lemmacomputer/workspace:dev", "Workspace container image."),
    variable("LEMMACOMPUTER_TIME_ZONE", "Etc/UTC", "Trusted IANA timezone for workspace and relative calendar times.", { initialize: "time-zone" }),
    variable("LEMMACOMPUTER_KASM_LOCAL_NETWORK_PREFIX", "lemmacomputer-workspace", "Local Kasm workspace network-name prefix."),
    variable("LEMMACOMPUTER_KASM_LOCAL_EGRESS_NETWORK", "lemmacomputer-egress", "Local Kasm egress network name."),
    variable("LEMMACOMPUTER_KASM_LOCAL_KVM_ENABLED", "false", "Expose KVM devices only to supported local desktop workspaces.", { kind: "boolean" }),
    variable("LEMMACOMPUTER_KASM_LOCAL_STARTUP_TIMEOUT_MS", "60000", "Local workspace startup timeout in milliseconds.", { kind: "integer" }),
    variable("LEMMACOMPUTER_KASM_PUBLIC_HOST", "127.0.0.1", "Host address advertised by the local Kasm adapter."),
    variable("LEMMACOMPUTER_KASM_BASE_URL", "", "Kasm Developer API base URL when LEMMACOMPUTER_SANDBOX_DRIVER=kasm.", { optional: true }),
    variable("LEMMACOMPUTER_KASM_API_KEY", "", "Kasm Developer API key.", { secret: true }),
    variable("LEMMACOMPUTER_KASM_API_SECRET", "", "Kasm Developer API secret.", { secret: true }),
    variable("LEMMACOMPUTER_KASM_USER_ID", "", "Kasm user ID."),
    variable("LEMMACOMPUTER_KASM_IMAGE_ID", "", "Kasm image ID."),
  ]),
];

export const environmentContract = Object.freeze(sections.flatMap(({ name, description, variables }) => variables.map((item) => Object.freeze({ ...item, section: name, sectionDescription: description }))));
export const environmentSections = Object.freeze(sections.map(({ name, description, variables }) => Object.freeze({ name, description, variables: Object.freeze([...variables]) })));
export const environmentVariableNames = Object.freeze(environmentContract.map(({ key }) => key));
export const environmentVariableNameSet = new Set(environmentVariableNames);
export const generatedSecretNames = Object.freeze(environmentContract.filter(({ generator }) => generator === "random").map(({ key }) => key));
export const worktreeIsolationEnvironmentVariableNames = Object.freeze([
  "LEMMACOMPUTER_COMPOSE_PROJECT_NAME",
  "LEMMACOMPUTER_CONTROL_NETWORK",
  "LEMMACOMPUTER_CONTROL_CONTAINER",
  "LEMMACOMPUTER_LITELLM_CONTAINER",
]);

// Qualification runs create these inputs independently for each isolated test
// stack. They are deliberately not accepted in a production .env, but remain
// registered here so test-only Compose files cannot grow a hidden contract.
const qualificationSections = [
  section("OAuth renewal qualification (test-only)", "Generated by npm run qualify:oauth for an isolated short-lived Docker project.", [
    variable("LEMMACOMPUTER_OAUTH_QUALIFICATION_PROJECT", "generated-per-qualification", "Isolated OAuth qualification Compose project name."),
    variable("LEMMACOMPUTER_OAUTH_QUALIFICATION_POSTGRES_PASSWORD", "generated-per-qualification", "Isolated OAuth qualification PostgreSQL password.", { secret: true }),
    variable("LEMMACOMPUTER_OAUTH_QUALIFICATION_MASTER_KEY", "generated-per-qualification", "Isolated OAuth qualification LiteLLM master key.", { secret: true }),
    variable("LEMMACOMPUTER_OAUTH_QUALIFICATION_SALT_KEY", "generated-per-qualification", "Isolated OAuth qualification LiteLLM salt key.", { secret: true }),
    variable("LEMMACOMPUTER_OAUTH_QUALIFICATION_LITELLM_PORT", "generated-per-qualification", "Isolated OAuth qualification LiteLLM host port."),
    variable("LEMMACOMPUTER_OAUTH_QUALIFICATION_FIXTURE_PORT", "generated-per-qualification", "Isolated OAuth qualification fixture host port."),
  ]),
  section("Provider settings qualification (test-only)", "Generated by npm run qualify:providers for an isolated short-lived Docker project.", [
    variable("LEMMACOMPUTER_PROVIDER_QUALIFICATION_PROJECT", "generated-per-qualification", "Isolated provider qualification Compose project name."),
    variable("LEMMACOMPUTER_PROVIDER_QUALIFICATION_MASTER_KEY", "generated-per-qualification", "Isolated provider qualification LiteLLM master key.", { secret: true }),
    variable("LEMMACOMPUTER_PROVIDER_QUALIFICATION_SALT_KEY", "generated-per-qualification", "Isolated provider qualification LiteLLM salt key.", { secret: true }),
    variable("LEMMACOMPUTER_PROVIDER_QUALIFICATION_LITELLM_POSTGRES_PASSWORD", "generated-per-qualification", "Isolated provider qualification LiteLLM PostgreSQL password.", { secret: true }),
    variable("LEMMACOMPUTER_PROVIDER_QUALIFICATION_CONTROL_POSTGRES_PASSWORD", "generated-per-qualification", "Isolated provider qualification Control PostgreSQL password.", { secret: true }),
    variable("LEMMACOMPUTER_PROVIDER_QUALIFICATION_CONTROL_POSTGRES_PORT", "generated-per-qualification", "Isolated provider qualification Control PostgreSQL host port."),
    variable("LEMMACOMPUTER_PROVIDER_QUALIFICATION_LITELLM_PORT", "generated-per-qualification", "Isolated provider qualification LiteLLM host port."),
    variable("LEMMACOMPUTER_PROVIDER_QUALIFICATION_FIXTURE_PORT", "generated-per-qualification", "Isolated provider qualification fixture host port."),
    variable("LEMMACOMPUTER_LITELLM_QUALIFICATION_IMAGE", "ghcr.io/berriai/litellm:v1.93.0@sha256:a1745e629abfb17d434426ff48b115f54f4f4c4a0f5af241de569e93c63c411e", "Pinned LiteLLM image for provider qualification only."),
  ]),
];
export const qualificationEnvironmentContract = Object.freeze(qualificationSections.flatMap(({ name, description, variables }) => variables.map((item) => Object.freeze({ ...item, section: name, sectionDescription: description, scope: "qualification" }))));
export const allEnvironmentContract = Object.freeze([...environmentContract, ...qualificationEnvironmentContract]);
export const allEnvironmentVariableNameSet = new Set(allEnvironmentContract.map(({ key }) => key));

/** Canonical name -> legacy name accepted only by env:update during migration. */
export const environmentAliases = new Map([
  ["LEMMACOMPUTER_ENTRA_TENANT_ID", "LEMMACOMPUTER_MS365_TENANT_ID"],
  ["LEMMACOMPUTER_ENTRA_CLIENT_ID", "LEMMACOMPUTER_MS365_CLIENT_ID"],
  ["LEMMACOMPUTER_ENTRA_CLIENT_SECRET", "LEMMACOMPUTER_MS365_CLIENT_SECRET"],
  ["KASM_LOCAL_NETWORK_PREFIX", "KASM_LOCAL_NETWORK"],
  ["LEMMACOMPUTER_SANDBOX_DRIVER", "SANDBOX_DRIVER"],
  ["LEMMACOMPUTER_KASM_LOCAL_NETWORK_PREFIX", "KASM_LOCAL_NETWORK_PREFIX"],
  ["LEMMACOMPUTER_KASM_LOCAL_EGRESS_NETWORK", "KASM_LOCAL_EGRESS_NETWORK"],
  ["LEMMACOMPUTER_KASM_LOCAL_KVM_ENABLED", "KASM_LOCAL_KVM_ENABLED"],
  ["LEMMACOMPUTER_KASM_LOCAL_STARTUP_TIMEOUT_MS", "KASM_LOCAL_STARTUP_TIMEOUT_MS"],
  ["LEMMACOMPUTER_KASM_PUBLIC_HOST", "KASM_PUBLIC_HOST"],
  ["LEMMACOMPUTER_KASM_BASE_URL", "KASM_BASE_URL"],
  ["LEMMACOMPUTER_KASM_API_KEY", "KASM_API_KEY"],
  ["LEMMACOMPUTER_KASM_API_SECRET", "KASM_API_SECRET"],
  ["LEMMACOMPUTER_KASM_USER_ID", "KASM_USER_ID"],
  ["LEMMACOMPUTER_KASM_IMAGE_ID", "KASM_IMAGE_ID"],
]);

export const coupledEnvironmentGroups = Object.freeze([
  ["LEMMACOMPUTER_EXTERNAL_ID_TENANT_ID", "LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN", "LEMMACOMPUTER_EXTERNAL_ID_CLIENT_ID", "LEMMACOMPUTER_EXTERNAL_ID_CLIENT_SECRET"],
  ["LEMMACOMPUTER_WEB_PUSH_VAPID_PUBLIC_KEY", "LEMMACOMPUTER_WEB_PUSH_VAPID_PRIVATE_KEY", "LEMMACOMPUTER_WEB_PUSH_SUBSCRIPTION_SECRET"],
  ["LEMMACOMPUTER_POLICY_SIGNING_KEY_ID", "LEMMACOMPUTER_POLICY_SIGNING_PRIVATE_KEY_B64", "LEMMACOMPUTER_POLICY_VERIFICATION_KEYS_B64"],
  ["LEMMACOMPUTER_TELEGRAM_INTAKE_GRANT_PRIVATE_KEY_B64", "LEMMACOMPUTER_TELEGRAM_INTAKE_GRANT_PUBLIC_KEY_B64"],
  ["LEMMACOMPUTER_TELEGRAM_INTAKE_ENCRYPTION_PRIVATE_KEY_B64", "LEMMACOMPUTER_TELEGRAM_INTAKE_ENCRYPTION_PUBLIC_KEY_B64"],
  [
    "LEMMACOMPUTER_LITELLM_ADMIN_TLS_CA_B64",
    "LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_CERT_B64",
    "LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_KEY_B64",
    "LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_CERT_B64",
    "LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_KEY_B64",
  ],
]);

const comments = (text) => text.split("\n").flatMap((line) => `# ${line}`);

export function renderEnvironmentTemplate() {
  const lines = [
    "# LemmaComputer deployment environment",
    "#",
    "# Generated from scripts/deployment-config.mjs. Do not edit this file by hand.",
    "# Run `npm run env:init` to create .env with fresh local secrets, then",
    "# replace deployment-specific placeholders. Never commit .env.",
  ];
  for (const { name, description, variables } of environmentSections) {
    lines.push("", `# ${name}`, ...comments(description));
    for (const item of variables) lines.push(...comments(item.description), `${item.key}=${item.default}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderQualificationEnvironmentTemplate() {
  const lines = [
    "# LemmaComputer qualification-only environment reference",
    "#",
    "# Generated from scripts/deployment-config.mjs. The qualification commands",
    "# generate these values at run time; do not copy them into a deployment .env.",
  ];
  for (const { name, description, variables } of qualificationSections) {
    lines.push("", `# ${name}`, ...comments(description));
    for (const item of variables) lines.push(...comments(item.description), `${item.key}=${item.default}`);
  }
  return `${lines.join("\n")}\n`;
}

const toObject = (input) => input instanceof Map ? Object.fromEntries(input) : { ...input };

export function resolveDeploymentEnvironment(input = {}) {
  const raw = toObject(input);
  const resolved = {};
  for (const item of environmentContract) {
    const alias = environmentAliases.get(item.key);
    const supplied = raw[item.key] ?? (alias ? raw[alias] : undefined);
    // Older templates intentionally left some values blank for Compose to
    // default. The catalog now owns that default, so a blank legacy value must
    // not override a non-blank catalog default and reach a service as invalid.
    resolved[item.key] = supplied === "" && item.default !== "" ? item.default : supplied ?? item.default;
  }
  return resolved;
}

const hasValue = (value) => typeof value === "string" && value.trim().length > 0;
const isPlaceholder = (value) => !hasValue(value) || value.startsWith("replace-with-");
const isInteger = (value) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
const isUrl = (value) => {
  try { return Boolean(new URL(value)); } catch { return false; }
};

/**
 * Fails before a deployment starts. Runtime checks remain defense in depth;
 * this catches an incorrect manifest even when the application cannot infer
 * whether infrastructure is a hosted installation.
 */
export function validateDeploymentEnvironment(input = {}, { profile, strict = false } = {}) {
  const raw = toObject(input);
  const values = resolveDeploymentEnvironment(raw);
  const errors = [];
  const selectedProfile = profile ?? values.LEMMACOMPUTER_INSTALLATION_KIND;
  let profileCapabilities;

  try {
    profileCapabilities = resolveDeploymentProfile(selectedProfile);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (strict && !hasValue(raw.LEMMACOMPUTER_INSTALLATION_KIND)) {
    errors.push("LEMMACOMPUTER_INSTALLATION_KIND must be explicitly set; implicit production profiles are forbidden");
  }
  if (profile && values.LEMMACOMPUTER_INSTALLATION_KIND !== profile) {
    errors.push(`LEMMACOMPUTER_INSTALLATION_KIND must be ${profile} for this preflight`);
  }
  if (strict) {
    for (const key of Object.keys(raw)) {
      if (key.startsWith("LEMMACOMPUTER_") && !environmentVariableNameSet.has(key)) {
        errors.push(`Unknown deployment environment variable: ${key}`);
      }
    }
  }

  for (const item of environmentContract) {
    const value = values[item.key];
    if (item.generated && (!hasValue(value) || value === generated)) {
      errors.push(`${item.key} must be initialized by npm run env:init or supplied by the secret manager`);
      continue;
    }
    if (!hasValue(value) && item.optional) continue;
    if (item.kind === "integer" && !isInteger(value)) errors.push(`${item.key} must be a non-negative integer`);
    if (item.kind === "boolean" && !["true", "false"].includes(value)) errors.push(`${item.key} must be true or false`);
    if (item.kind === "url" && hasValue(value) && !isUrl(value)) errors.push(`${item.key} must be an absolute URL`);
    if (item.kind === "enum" && !item.values.includes(value)) errors.push(`${item.key} must be one of ${item.values.map((candidate) => candidate || "(empty)").join(", ")}`);
  }

  for (const group of coupledEnvironmentGroups) {
    const present = group.filter((key) => hasValue(values[key]));
    if (present.length > 0 && present.length < group.length) errors.push(`${group.join(", ")} must be configured together`);
  }

  const ms365DedicatedApp = [
    "LEMMACOMPUTER_MS365_TENANT_ID",
    "LEMMACOMPUTER_MS365_CLIENT_ID",
    "LEMMACOMPUTER_MS365_CLIENT_SECRET",
  ];
  const dedicatedPresent = ms365DedicatedApp.filter((key) => hasValue(values[key]));
  if (dedicatedPresent.length > 0 && dedicatedPresent.length < ms365DedicatedApp.length) {
    errors.push(`${ms365DedicatedApp.join(", ")} must be configured together or all left empty`);
  }

  if (values.LEMMACOMPUTER_SANDBOX_DRIVER === "kasm") {
    const remoteKasm = ["LEMMACOMPUTER_KASM_BASE_URL", "LEMMACOMPUTER_KASM_API_KEY", "LEMMACOMPUTER_KASM_API_SECRET", "LEMMACOMPUTER_KASM_USER_ID", "LEMMACOMPUTER_KASM_IMAGE_ID"];
    for (const key of remoteKasm) if (!hasValue(values[key])) errors.push(`${key} is required when LEMMACOMPUTER_SANDBOX_DRIVER=kasm`);
    if (hasValue(values.LEMMACOMPUTER_KASM_BASE_URL) && !isUrl(values.LEMMACOMPUTER_KASM_BASE_URL)) errors.push("LEMMACOMPUTER_KASM_BASE_URL must be an absolute URL when LEMMACOMPUTER_SANDBOX_DRIVER=kasm");
  }

  if (profileCapabilities) {
    try {
      assertWorkspaceDriverTopologyAllowed(profileCapabilities.id, values.LEMMACOMPUTER_SANDBOX_DRIVER);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (selectedProfile === "hosted") {
    for (const key of [
      "LEMMACOMPUTER_EXTERNAL_ID_TENANT_ID",
      "LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN",
      "LEMMACOMPUTER_EXTERNAL_ID_CLIENT_ID",
      "LEMMACOMPUTER_EXTERNAL_ID_CLIENT_SECRET",
    ]) if (!hasValue(values[key])) errors.push(`${key} is required for hosted External ID sign-in`);
    if (hasValue(values.LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN)
      && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(values.LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN)) {
      errors.push("LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN must be a ciamlogin.com tenant label");
    }
    if (!values.LEMMACOMPUTER_PUBLIC_WEB_URL.startsWith("https:")) {
      errors.push("LEMMACOMPUTER_PUBLIC_WEB_URL must use https in hosted deployments");
    }
    if (values.LEMMACOMPUTER_LITELLM_ADMIN_URL.startsWith("http:") || !values.LEMMACOMPUTER_LITELLM_ADMIN_URL.startsWith("https:")) {
      errors.push("LEMMACOMPUTER_LITELLM_ADMIN_URL must use https in hosted deployments");
    }
    const hostedMtls = [
      "LEMMACOMPUTER_LITELLM_ADMIN_TLS_CA_B64",
      "LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_CERT_B64",
      "LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_KEY_B64",
      "LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_CERT_B64",
      "LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_KEY_B64",
    ];
    for (const key of hostedMtls) if (!hasValue(values[key])) errors.push(`${key} is required for hosted LiteLLM mutual TLS`);
    const credentialSecrets = [
      "LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET",
      "LEMMACOMPUTER_SESSION_SECRET",
      "LEMMACOMPUTER_WORKSPACE_INGRESS_SECRET",
    ];
    if (new Set(credentialSecrets.map((key) => values[key])).size !== credentialSecrets.length) {
      errors.push("LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET, LEMMACOMPUTER_SESSION_SECRET, and LEMMACOMPUTER_WORKSPACE_INGRESS_SECRET must be distinct in hosted deployments");
    }
    if (values.LEMMACOMPUTER_TELEGRAM_RAW_TOKEN_INPUT_MODE !== "reject") {
      errors.push("LEMMACOMPUTER_TELEGRAM_RAW_TOKEN_INPUT_MODE must be reject in hosted deployments");
    }
  }

  if (selectedProfile === "customer-managed") {
    if (isPlaceholder(values.LEMMACOMPUTER_ENTRA_TENANT_ID)) {
      errors.push("LEMMACOMPUTER_ENTRA_TENANT_ID must identify the customer directory in customer-managed deployments");
    }
    if (hasValue(values.LEMMACOMPUTER_HOSTED_MCP_EGRESS_ORIGINS)) {
      errors.push("LEMMACOMPUTER_HOSTED_MCP_EGRESS_ORIGINS is hosted-only and must be empty in customer-managed deployments");
    }
    for (const key of [
      "LEMMACOMPUTER_EXTERNAL_ID_TENANT_ID",
      "LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN",
      "LEMMACOMPUTER_EXTERNAL_ID_CLIENT_ID",
      "LEMMACOMPUTER_EXTERNAL_ID_CLIENT_SECRET",
    ]) if (hasValue(values[key])) errors.push(`${key} is hosted-only and must be empty in customer-managed deployments`);
  }

  if (errors.length) throw new Error(`Deployment environment validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  return values;
}

/** Worktree-only overrides are declared here so init never appends hidden variables. */
export function worktreeEnvironmentOverrides({ slug, id, portOffset }) {
  return new Map([
    ["LEMMACOMPUTER_COMPOSE_PROJECT_NAME", slug],
    ["LEMMACOMPUTER_CONTROL_NETWORK", `${slug}-control`],
    ["LEMMACOMPUTER_CONTROL_CONTAINER", `${slug}-control-api`],
    ["LEMMACOMPUTER_LITELLM_CONTAINER", `${slug}-litellm`],
    ["LEMMACOMPUTER_IMAGE_TAG", `dev-${id}`],
    ["LEMMACOMPUTER_APP_VERSION", `dev-${id}`],
    ["LEMMACOMPUTER_MS365_IMAGE_TAG", `dev-${id}`],
    ["LEMMACOMPUTER_WORKSPACE_IMAGE", `lemmacomputer/workspace:dev-${id}`],
    ["LEMMACOMPUTER_KASM_LOCAL_NETWORK_PREFIX", `${slug}-workspace`],
    ["LEMMACOMPUTER_KASM_LOCAL_EGRESS_NETWORK", `${slug}-egress`],
    ["LEMMACOMPUTER_WEB_PORT", String(4174 + portOffset)],
    ["LEMMACOMPUTER_PUBLIC_WEB_URL", `http://localhost:${4174 + portOffset}`],
    ["LEMMACOMPUTER_INSTALLATION_KIND", "worktree"],
  ]);
}

const runtimeDefaults = Object.freeze({
  controlHost: "0.0.0.0",
  controlPort: "4100",
  controllerHost: "0.0.0.0",
  controllerPort: "4101",
  channelBrokerHost: "0.0.0.0",
  channelBrokerPort: "4102",
  schedulerHost: "0.0.0.0",
  schedulerPort: "4103",
  webHost: "0.0.0.0",
  webPort: "4173",
  ingressHost: "0.0.0.0",
  ingressPort: "4174",
  postgresHost: "postgres",
  litellmPostgresHost: "litellm-postgres",
  litellmHost: "litellm",
  ms365Host: "ms365-mcp",
  consentHost: "openvtc-consent",
  adminListenerHost: "litellm-admin-listener",
});

const controlDatabaseUrl = (v) => `postgres://lemmacomputer:${v("LEMMACOMPUTER_POSTGRES_PASSWORD")}@${runtimeDefaults.postgresHost}:5432/lemmacomputer`;
const litellmDatabaseUrl = (v) => `postgres://litellm:${v("LEMMACOMPUTER_LITELLM_POSTGRES_PASSWORD")}@${runtimeDefaults.litellmPostgresHost}:5432/litellm`;
const gatewayProviderEgressPolicy = '{"schemaVersion":2,"mode":"restricted","id":"egv_gateway_provider_egress_v1","securityGroupId":"esg_gateway_provider_egress","version":1,"name":"Gateway provider egress","description":"Exact outbound model provider destinations.","defaultAction":"deny","rules":[{"id":"openai-api","action":"allow","protocol":"https","host":"api.openai.com","includeSubdomains":false,"port":443,"purpose":"OpenAI model API"},{"id":"anthropic-api","action":"allow","protocol":"https","host":"api.anthropic.com","includeSubdomains":false,"port":443,"purpose":"Anthropic model API"},{"id":"zai-api","action":"allow","protocol":"https","host":"api.z.ai","includeSubdomains":false,"port":443,"purpose":"Z.ai model API"},{"id":"bedrock-use1","action":"allow","protocol":"https","host":"bedrock-runtime.us-east-1.amazonaws.com","includeSubdomains":false,"port":443,"purpose":"Bedrock us-east-1"},{"id":"bedrock-usw2","action":"allow","protocol":"https","host":"bedrock-runtime.us-west-2.amazonaws.com","includeSubdomains":false,"port":443,"purpose":"Bedrock us-west-2"},{"id":"bedrock-euw1","action":"allow","protocol":"https","host":"bedrock-runtime.eu-west-1.amazonaws.com","includeSubdomains":false,"port":443,"purpose":"Bedrock eu-west-1"},{"id":"bedrock-apse1","action":"allow","protocol":"https","host":"bedrock-runtime.ap-southeast-1.amazonaws.com","includeSubdomains":false,"port":443,"purpose":"Bedrock ap-southeast-1"}],"documentHash":"0f7d144fd2ecfe6704dbf8c02c9cdb1a949674bba3930560cad36c367465a52f"}';
const remoteMcpEgressPolicy = '{"schemaVersion":2,"mode":"restricted","id":"egv_remote_mcp_egress_v1","securityGroupId":"esg_remote_mcp_egress","version":1,"name":"Remote MCP egress","description":"Control-approved public MCP and OAuth destinations.","defaultAction":"deny","rules":[],"documentHash":"1d9c9a090b1bd52ad16c6a4d47c6c2958a0bb7634f6efdfc7ffb1f8fe7e7a45f"}';

/**
 * Render the reference service-local names once. Compose and another platform
 * adapter can consume this projection while keeping secret custody explicit;
 * it intentionally does not disclose every deployment secret to every service.
 */
export function projectServiceEnvironment(input = {}) {
  const values = resolveDeploymentEnvironment(input);
  const v = (key) => values[key];
  const ms365Client = v("LEMMACOMPUTER_MS365_CLIENT_ID") || v("LEMMACOMPUTER_ENTRA_CLIENT_ID");
  const ms365Tenant = v("LEMMACOMPUTER_MS365_TENANT_ID") || v("LEMMACOMPUTER_ENTRA_TENANT_ID");
  const ms365Secret = v("LEMMACOMPUTER_MS365_CLIENT_SECRET") || v("LEMMACOMPUTER_ENTRA_CLIENT_SECRET");
  const controlUrl = `http://control-api:${runtimeDefaults.controlPort}`;
  const controllerUrl = `http://workspace-controller:${runtimeDefaults.controllerPort}`;
  const litellmUrl = `http://${runtimeDefaults.litellmHost}:4000`;
  const ms365Url = `http://${runtimeDefaults.ms365Host}:3000`;
  const consentUrl = `http://${runtimeDefaults.consentHost}:8788`;
  const publicWebOrigin = new URL(v("LEMMACOMPUTER_PUBLIC_WEB_URL")).origin;
  const litellmPublicUrl = `${publicWebOrigin}/oauth/mcp`;
  const m365AuthorizationOrigin = `${publicWebOrigin}/m365`;
  const gatewayEgressProxyUrl = `http://litellm-gateway:${encodeURIComponent(v("LEMMACOMPUTER_GATEWAY_EGRESS_PROXY_TOKEN"))}@gateway-egress-proxy:3128`;
  const remoteMcpEgressProxyUrl = `http://litellm-gateway:${encodeURIComponent(v("LEMMACOMPUTER_REMOTE_MCP_EGRESS_PROXY_TOKEN"))}@remote-mcp-egress-proxy:3128`;

  return {
    postgres: {
      POSTGRES_DB: "lemmacomputer",
      POSTGRES_USER: "lemmacomputer",
      POSTGRES_PASSWORD: v("LEMMACOMPUTER_POSTGRES_PASSWORD"),
    },
    "litellm-postgres": {
      POSTGRES_DB: "litellm",
      POSTGRES_USER: "litellm",
      POSTGRES_PASSWORD: v("LEMMACOMPUTER_LITELLM_POSTGRES_PASSWORD"),
    },
    "ms365-mcp": {
      MS365_MCP_CLIENT_ID: ms365Client,
      MS365_MCP_TENANT_ID: ms365Tenant,
      MS365_MCP_CLIENT_SECRET: ms365Secret,
      MS365_MCP_PUBLIC_URL: m365AuthorizationOrigin,
      MS365_MCP_ALLOWED_REDIRECT_URIS: `${litellmPublicUrl}/callback`,
      MS365_MCP_MAX_TOP: v("LEMMACOMPUTER_MS365_MAX_TOP"),
      MS365_MCP_MAX_PAGES: v("LEMMACOMPUTER_MS365_MAX_PAGES"),
      MS365_MCP_MAX_ITEMS: v("LEMMACOMPUTER_MS365_MAX_ITEMS"),
      MS365_MCP_REDACT_PII: v("LEMMACOMPUTER_MS365_REDACT_PII"),
      MS365_MCP_REQUIRE_CONFIRM: v("LEMMACOMPUTER_MS365_REQUIRE_CONFIRM"),
      MS365_MCP_TRUST_PROXY_HOPS: v("LEMMACOMPUTER_MS365_TRUST_PROXY_HOPS"),
      LOG_LEVEL: v("LEMMACOMPUTER_MS365_LOG_LEVEL"),
    },
    litellm: {
      LITELLM_MASTER_KEY: v("LEMMACOMPUTER_LITELLM_MASTER_KEY"),
      LITELLM_SALT_KEY: v("LEMMACOMPUTER_LITELLM_SALT_KEY"),
      DATABASE_URL: litellmDatabaseUrl(v),
      DISABLE_ADMIN_UI: "true",
      PROXY_BASE_URL: litellmPublicUrl,
      MCP_TRUSTED_REDIRECT_ORIGINS: v("LEMMACOMPUTER_PUBLIC_WEB_URL"),
      LEMMACOMPUTER_M365_AUTHORIZATION_URL: `${m365AuthorizationOrigin}/authorize`,
      GITHUB_MCP_CLIENT_ID: v("LEMMACOMPUTER_GITHUB_MCP_CLIENT_ID"),
      GITHUB_MCP_CLIENT_SECRET: v("LEMMACOMPUTER_GITHUB_MCP_CLIENT_SECRET"),
      LEMMACOMPUTER_MCP_POLICY_URL: `${controlUrl}/internal/v1/mcp/authorize`,
      LEMMACOMPUTER_MCP_POLICY_TOKEN: v("LEMMACOMPUTER_CONTROLLER_TOKEN"),
      LEMMACOMPUTER_AI_USAGE_URL: `${controlUrl}/internal/v1/ai-usage`,
      LEMMACOMPUTER_AI_USAGE_TOKEN: v("LEMMACOMPUTER_AI_USAGE_TOKEN"),
      // Model traffic uses the static allowlist proxy. The pinned strict
      // remote-MCP extension selects its own explicit proxy and ignores these
      // environment-controlled bypass settings.
      HTTP_PROXY: gatewayEgressProxyUrl,
      HTTPS_PROXY: gatewayEgressProxyUrl,
      http_proxy: gatewayEgressProxyUrl,
      https_proxy: gatewayEgressProxyUrl,
      AIOHTTP_TRUST_ENV: "true",
      NO_PROXY: "localhost,127.0.0.1,::1,litellm,litellm-postgres,ms365-mcp,control-api,workspace-ingress,litellm-admin-proxy",
      no_proxy: "localhost,127.0.0.1,::1,litellm,litellm-postgres,ms365-mcp,control-api,workspace-ingress,litellm-admin-proxy",
      ALL_PROXY: "",
      all_proxy: "",
      LEMMACOMPUTER_REMOTE_MCP_EGRESS_PROXY_URL: remoteMcpEgressProxyUrl,
    },
    "gateway-egress-proxy": {
      EGRESS_PROXY_PORT: "3128",
      EGRESS_PROXY_SERVICE_PASSWORD: v("LEMMACOMPUTER_GATEWAY_EGRESS_PROXY_TOKEN"),
      EGRESS_POLICY_JSON: gatewayProviderEgressPolicy,
    },
    "remote-mcp-egress-proxy": {
      EGRESS_PROXY_PORT: "3128",
      EGRESS_PROXY_SERVICE_PASSWORD: v("LEMMACOMPUTER_REMOTE_MCP_EGRESS_PROXY_TOKEN"),
      EGRESS_DYNAMIC_AUTHORIZATION_URL: `${controlUrl}/internal/v1/mcp-egress/authorize`,
      EGRESS_DYNAMIC_AUTHORIZATION_TOKEN: v("LEMMACOMPUTER_MCP_EGRESS_PROXY_TOKEN"),
      EGRESS_POLICY_JSON: remoteMcpEgressPolicy,
    },
    "litellm-admin-proxy": {
      LEMMACOMPUTER_INSTALLATION_KIND: v("LEMMACOMPUTER_INSTALLATION_KIND"),
      LITELLM_ADMIN_PROXY_HOST: runtimeDefaults.adminListenerHost,
      LITELLM_ADMIN_PROXY_PORT: "8443",
      LITELLM_ADMIN_PROXY_UPSTREAM_URL: litellmUrl,
      LITELLM_ADMIN_PROXY_TLS_CA_B64: v("LEMMACOMPUTER_LITELLM_ADMIN_TLS_CA_B64"),
      LITELLM_ADMIN_PROXY_TLS_SERVER_CERT_B64: v("LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_CERT_B64"),
      LITELLM_ADMIN_PROXY_TLS_SERVER_KEY_B64: v("LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_KEY_B64"),
      LITELLM_ADMIN_PROXY_CLIENT_COMMON_NAME: v("LEMMACOMPUTER_LITELLM_ADMIN_CLIENT_COMMON_NAME"),
    },
    "openvtc-consent": {
      OPENVTC_CONSENT_LISTEN: "0.0.0.0:8788",
      OPENVTC_CONSENT_TOKEN: v("LEMMACOMPUTER_OPENVTC_CONSENT_TOKEN"),
      OPENVTC_EXECUTOR_SEED_B64: v("LEMMACOMPUTER_OPENVTC_EXECUTOR_SEED_B64"),
      RUST_LOG: "lemmacomputer_openvtc_consent=info",
    },
    "workspace-controller": {
      CONTROLLER_HOST: runtimeDefaults.controllerHost,
      CONTROLLER_PORT: runtimeDefaults.controllerPort,
      CONTROLLER_INTERNAL_TOKEN: v("LEMMACOMPUTER_CONTROLLER_TOKEN"),
      SANDBOX_DRIVER: v("LEMMACOMPUTER_SANDBOX_DRIVER"),
      LEMMACOMPUTER_INSTALLATION_KIND: v("LEMMACOMPUTER_INSTALLATION_KIND"),
      DOCKER_SOCKET_PATH: "/var/run/docker.sock",
      KASM_LOCAL_NETWORK_PREFIX: v("LEMMACOMPUTER_KASM_LOCAL_NETWORK_PREFIX"),
      KASM_LOCAL_CONTROL_NETWORK: v("LEMMACOMPUTER_CONTROL_NETWORK"),
      KASM_LOCAL_GATEWAY_CONTAINER: v("LEMMACOMPUTER_LITELLM_CONTAINER"),
      KASM_LOCAL_CONTROL_CONTAINER: v("LEMMACOMPUTER_CONTROL_CONTAINER"),
      KASM_LOCAL_IMAGE: v("LEMMACOMPUTER_WORKSPACE_IMAGE"),
      KASM_LOCAL_RELAY_IMAGE: "node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2",
      KASM_LOCAL_EGRESS_PROXY_IMAGE: `lemmacomputer/control-runtime:${v("LEMMACOMPUTER_IMAGE_TAG")}`,
      KASM_LOCAL_EGRESS_NETWORK: v("LEMMACOMPUTER_KASM_LOCAL_EGRESS_NETWORK"),
      KASM_PUBLIC_HOST: v("LEMMACOMPUTER_KASM_PUBLIC_HOST"),
      KASM_LOCAL_KVM_ENABLED: v("LEMMACOMPUTER_KASM_LOCAL_KVM_ENABLED"),
      KASM_LOCAL_STARTUP_TIMEOUT_MS: v("LEMMACOMPUTER_KASM_LOCAL_STARTUP_TIMEOUT_MS"),
      KASM_LOCAL_TIME_ZONE: v("LEMMACOMPUTER_TIME_ZONE"),
      CHAT_ATTACHMENT_RETENTION_DAYS: v("LEMMACOMPUTER_CHAT_ATTACHMENT_RETENTION_DAYS"),
      KASM_BASE_URL: v("LEMMACOMPUTER_KASM_BASE_URL"),
      KASM_API_KEY: v("LEMMACOMPUTER_KASM_API_KEY"),
      KASM_API_SECRET: v("LEMMACOMPUTER_KASM_API_SECRET"),
      KASM_USER_ID: v("LEMMACOMPUTER_KASM_USER_ID"),
      KASM_IMAGE_ID: v("LEMMACOMPUTER_KASM_IMAGE_ID"),
      POLICY_VERIFICATION_KEYS_B64: v("LEMMACOMPUTER_POLICY_VERIFICATION_KEYS_B64"),
    },
    "db-migrate": {
      DATABASE_URL: controlDatabaseUrl(v),
      LEMMACOMPUTER_APP_VERSION: v("LEMMACOMPUTER_APP_VERSION"),
      LEMMACOMPUTER_INSTALLATION_KIND: v("LEMMACOMPUTER_INSTALLATION_KIND"),
    },
    "control-api": {
      CONTROL_HOST: runtimeDefaults.controlHost,
      CONTROL_PORT: runtimeDefaults.controlPort,
      WEB_PROXY_TOKEN: v("LEMMACOMPUTER_WEB_PROXY_TOKEN"),
      CONTROLLER_URL: controllerUrl,
      CONTROLLER_INTERNAL_TOKEN: v("LEMMACOMPUTER_CONTROLLER_TOKEN"),
      MCP_EGRESS_PROXY_TOKEN: v("LEMMACOMPUTER_MCP_EGRESS_PROXY_TOKEN"),
      HOSTED_MCP_EGRESS_ORIGINS: v("LEMMACOMPUTER_HOSTED_MCP_EGRESS_ORIGINS"),
      DATABASE_URL: controlDatabaseUrl(v),
      LITELLM_ADMIN_URL: v("LEMMACOMPUTER_LITELLM_ADMIN_URL"),
      LITELLM_ADMIN_TLS_CA_B64: v("LEMMACOMPUTER_LITELLM_ADMIN_TLS_CA_B64"),
      LITELLM_ADMIN_TLS_CLIENT_CERT_B64: v("LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_CERT_B64"),
      LITELLM_ADMIN_TLS_CLIENT_KEY_B64: v("LEMMACOMPUTER_LITELLM_ADMIN_TLS_CLIENT_KEY_B64"),
      LITELLM_ADMIN_TLS_SERVER_NAME: v("LEMMACOMPUTER_LITELLM_ADMIN_TLS_SERVER_NAME"),
      LITELLM_WORKSPACE_URL: litellmUrl,
      LITELLM_PUBLIC_URL: litellmPublicUrl,
      LITELLM_MASTER_KEY: v("LEMMACOMPUTER_LITELLM_MASTER_KEY"),
      LITELLM_CREDENTIAL_SECRET: v("LEMMACOMPUTER_LITELLM_CREDENTIAL_SECRET"),
      PUBLIC_WEB_URL: v("LEMMACOMPUTER_PUBLIC_WEB_URL"),
      M365_AUTHORIZATION_ORIGIN: m365AuthorizationOrigin,
      AGENT_BRIDGE_URL: controlUrl,
      AGENT_BRIDGE_SECRET: v("LEMMACOMPUTER_AGENT_BRIDGE_SECRET"),
      AGENT_BRIDGE_GRANT_TTL_SECONDS: v("LEMMACOMPUTER_AGENT_BRIDGE_GRANT_TTL_SECONDS"),
      FIXTURE_APPROVAL_SECRET: v("LEMMACOMPUTER_FIXTURE_APPROVAL_SECRET"),
      OPENVTC_CONSENT_URL: consentUrl,
      OPENVTC_CONSENT_TOKEN: v("LEMMACOMPUTER_OPENVTC_CONSENT_TOKEN"),
      WEB_PUSH_VAPID_SUBJECT: v("LEMMACOMPUTER_WEB_PUSH_VAPID_SUBJECT"),
      WEB_PUSH_VAPID_PUBLIC_KEY: v("LEMMACOMPUTER_WEB_PUSH_VAPID_PUBLIC_KEY"),
      WEB_PUSH_VAPID_PRIVATE_KEY: v("LEMMACOMPUTER_WEB_PUSH_VAPID_PRIVATE_KEY"),
      WEB_PUSH_SUBSCRIPTION_SECRET: v("LEMMACOMPUTER_WEB_PUSH_SUBSCRIPTION_SECRET"),
      ENTRA_TENANT_ID: v("LEMMACOMPUTER_ENTRA_TENANT_ID"),
      ENTRA_CLIENT_ID: v("LEMMACOMPUTER_ENTRA_CLIENT_ID"),
      ENTRA_CLIENT_SECRET: v("LEMMACOMPUTER_ENTRA_CLIENT_SECRET"),
      EXTERNAL_ID_TENANT_ID: v("LEMMACOMPUTER_EXTERNAL_ID_TENANT_ID"),
      EXTERNAL_ID_TENANT_SUBDOMAIN: v("LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN"),
      EXTERNAL_ID_CLIENT_ID: v("LEMMACOMPUTER_EXTERNAL_ID_CLIENT_ID"),
      EXTERNAL_ID_CLIENT_SECRET: v("LEMMACOMPUTER_EXTERNAL_ID_CLIENT_SECRET"),
      SESSION_SECRET: v("LEMMACOMPUTER_SESSION_SECRET"),
      WORKSPACE_INGRESS_PUBLIC_URL: v("LEMMACOMPUTER_PUBLIC_WEB_URL"),
      WORKSPACE_INGRESS_SECRET: v("LEMMACOMPUTER_WORKSPACE_INGRESS_SECRET"),
      WORKSPACE_INGRESS_LAUNCH_TTL_SECONDS: v("LEMMACOMPUTER_WORKSPACE_INGRESS_LAUNCH_TTL_SECONDS"),
      WORKSPACE_INGRESS_SESSION_TTL_SECONDS: v("LEMMACOMPUTER_WORKSPACE_INGRESS_SESSION_TTL_SECONDS"),
      EGRESS_GRANT_SECRET: v("LEMMACOMPUTER_EGRESS_GRANT_SECRET"),
      AGENT_CHAT_SECRET: v("LEMMACOMPUTER_HERMES_API_SECRET"),
      AI_USAGE_INTERNAL_TOKEN: v("LEMMACOMPUTER_AI_USAGE_TOKEN"),
      AI_USAGE_TASK_BINDING_SECRET: v("LEMMACOMPUTER_AI_USAGE_TASK_BINDING_SECRET"),
      CHANNEL_BROKER_URL: `http://channel-broker:${runtimeDefaults.channelBrokerPort}`,
      CHANNEL_BROKER_INTERNAL_TOKEN: v("LEMMACOMPUTER_CHANNEL_BROKER_TOKEN"),
      LEMMACOMPUTER_INSTALLATION_KIND: v("LEMMACOMPUTER_INSTALLATION_KIND"),
      TELEGRAM_RAW_TOKEN_INPUT_MODE: v("LEMMACOMPUTER_TELEGRAM_RAW_TOKEN_INPUT_MODE"),
      TELEGRAM_INTAKE_GRANT_PRIVATE_KEY_B64: v("LEMMACOMPUTER_TELEGRAM_INTAKE_GRANT_PRIVATE_KEY_B64"),
      TELEGRAM_INTAKE_ENCRYPTION_PUBLIC_KEY_B64: v("LEMMACOMPUTER_TELEGRAM_INTAKE_ENCRYPTION_PUBLIC_KEY_B64"),
      TELEGRAM_INTAKE_URL: "/api/channel-intake/v1/telegram",
      TELEGRAM_INTAKE_GRANT_TTL_SECONDS: v("LEMMACOMPUTER_TELEGRAM_INTAKE_GRANT_TTL_SECONDS"),
      SCHEDULER_INTERNAL_TOKEN: v("LEMMACOMPUTER_SCHEDULER_TOKEN"),
      SCHEDULE_PROMPT_SECRET: v("LEMMACOMPUTER_SCHEDULE_PROMPT_SECRET"),
      POLICY_SIGNING_KEY_ID: v("LEMMACOMPUTER_POLICY_SIGNING_KEY_ID"),
      POLICY_SIGNING_PRIVATE_KEY_B64: v("LEMMACOMPUTER_POLICY_SIGNING_PRIVATE_KEY_B64"),
      POLICY_VERIFICATION_KEYS_B64: v("LEMMACOMPUTER_POLICY_VERIFICATION_KEYS_B64"),
      POLICY_BUNDLE_TTL_SECONDS: v("LEMMACOMPUTER_POLICY_BUNDLE_TTL_SECONDS"),
      GATEWAY_GRANT_RENEWAL_INTERVAL_SECONDS: v("LEMMACOMPUTER_GATEWAY_GRANT_RENEWAL_INTERVAL_SECONDS"),
      BOOTSTRAP_TENANT_ID: v("LEMMACOMPUTER_BOOTSTRAP_TENANT_ID"),
      BOOTSTRAP_USER_ID: v("LEMMACOMPUTER_BOOTSTRAP_USER_ID"),
      TENANT_DISPLAY_NAME: v("LEMMACOMPUTER_TENANT_DISPLAY_NAME"),
      BOOTSTRAP_OWNER_OBJECT_IDS: v("LEMMACOMPUTER_BOOTSTRAP_OWNER_OBJECT_IDS"),
    },
    "channel-broker": {
      CHANNEL_BROKER_HOST: runtimeDefaults.channelBrokerHost,
      CHANNEL_BROKER_PORT: runtimeDefaults.channelBrokerPort,
      CHANNEL_BROKER_INTERNAL_TOKEN: v("LEMMACOMPUTER_CHANNEL_BROKER_TOKEN"),
      CHANNEL_CREDENTIAL_SECRET: v("LEMMACOMPUTER_CHANNEL_CREDENTIAL_SECRET"),
      CONTROL_URL: controlUrl,
      DATABASE_URL: controlDatabaseUrl(v),
      LEMMACOMPUTER_INSTALLATION_KIND: v("LEMMACOMPUTER_INSTALLATION_KIND"),
      TELEGRAM_RAW_TOKEN_INPUT_MODE: v("LEMMACOMPUTER_TELEGRAM_RAW_TOKEN_INPUT_MODE"),
      TELEGRAM_INTAKE_GRANT_PUBLIC_KEY_B64: v("LEMMACOMPUTER_TELEGRAM_INTAKE_GRANT_PUBLIC_KEY_B64"),
      TELEGRAM_INTAKE_ENCRYPTION_PRIVATE_KEY_B64: v("LEMMACOMPUTER_TELEGRAM_INTAKE_ENCRYPTION_PRIVATE_KEY_B64"),
      POLL_INTERVAL_MS: v("LEMMACOMPUTER_CHANNEL_POLL_INTERVAL_MS"),
      COMPOSITION_WINDOW_MS: v("LEMMACOMPUTER_TELEGRAM_COMPOSITION_WINDOW_MS"),
    },
    "scheduler-worker": {
      SCHEDULER_HOST: runtimeDefaults.schedulerHost,
      SCHEDULER_PORT: runtimeDefaults.schedulerPort,
      SCHEDULER_INTERNAL_TOKEN: v("LEMMACOMPUTER_SCHEDULER_TOKEN"),
      CONTROL_URL: controlUrl,
      DATABASE_URL: controlDatabaseUrl(v),
      POLL_INTERVAL_MS: v("LEMMACOMPUTER_SCHEDULER_POLL_INTERVAL_MS"),
      CLAIM_LIMIT: v("LEMMACOMPUTER_SCHEDULER_CLAIM_LIMIT"),
      CLAIM_LEASE_MS: v("LEMMACOMPUTER_SCHEDULER_CLAIM_LEASE_MS"),
    },
    web: {
      WEB_HOST: runtimeDefaults.webHost,
      WEB_PORT: runtimeDefaults.webPort,
      LEMMACOMPUTER_CONTROL_URL: controlUrl,
      LEMMACOMPUTER_CHANNEL_BROKER_INTAKE_URL: `http://channel-broker:${runtimeDefaults.channelBrokerPort}`,
      LEMMACOMPUTER_WEB_PROXY_TOKEN: v("LEMMACOMPUTER_WEB_PROXY_TOKEN"),
    },
    "workspace-ingress": {
      WORKSPACE_INGRESS_HOST: runtimeDefaults.ingressHost,
      WORKSPACE_INGRESS_PORT: runtimeDefaults.ingressPort,
      WORKSPACE_INGRESS_PUBLIC_URL: v("LEMMACOMPUTER_PUBLIC_WEB_URL"),
      WORKSPACE_INGRESS_LITELLM_PUBLIC_URL: litellmPublicUrl,
      WORKSPACE_INGRESS_WEB_UPSTREAM: `http://web:${runtimeDefaults.webPort}`,
      WORKSPACE_INGRESS_MICROSOFT365_AUTHORIZATION_UPSTREAM: ms365Url,
      WORKSPACE_INGRESS_LITELLM_OAUTH_UPSTREAM: litellmUrl,
      WORKSPACE_INGRESS_SECRET: v("LEMMACOMPUTER_WORKSPACE_INGRESS_SECRET"),
      WORKSPACE_INGRESS_LAUNCH_TTL_SECONDS: v("LEMMACOMPUTER_WORKSPACE_INGRESS_LAUNCH_TTL_SECONDS"),
      WORKSPACE_INGRESS_SESSION_TTL_SECONDS: v("LEMMACOMPUTER_WORKSPACE_INGRESS_SESSION_TTL_SECONDS"),
      WORKSPACE_INGRESS_VERIFY_UPSTREAM_TLS: v("LEMMACOMPUTER_WORKSPACE_INGRESS_VERIFY_UPSTREAM_TLS"),
    },
  };
}

export function serializeEnvironment(environment) {
  return `${Object.entries(environment).map(([key, value]) => {
    if (value === undefined || value === null) throw new Error(`${key} has no rendered value`);
    const text = String(value);
    if (/\r|\n/.test(text)) throw new Error(`${key} cannot contain a newline in an env_file`);
    // compose.yaml declares every generated file with `format: raw`, so the
    // literal value (including $, quotes, whitespace, and #) reaches the
    // service without Compose interpolation or dotenv re-parsing.
    return `${key}=${text}`;
  }).join("\n")}\n`;
}
