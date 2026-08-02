import { generateKeyPairSync, randomBytes } from "node:crypto";
import webPush from "web-push";

const generatedSecretNames = [
  "ONECOMPUTER_WEB_PROXY_TOKEN",
  "ONECOMPUTER_CONTROLLER_TOKEN",
  "ONECOMPUTER_POSTGRES_PASSWORD",
  "ONECOMPUTER_LITELLM_SALT_KEY",
  "ONECOMPUTER_LITELLM_CREDENTIAL_SECRET",
  "ONECOMPUTER_LITELLM_POSTGRES_PASSWORD",
  "ONECOMPUTER_FIXTURE_APPROVAL_SECRET",
  "ONECOMPUTER_OPENVTC_CONSENT_TOKEN",
  "ONECOMPUTER_WEB_PUSH_SUBSCRIPTION_SECRET",
  "ONECOMPUTER_SESSION_SECRET",
  "ONECOMPUTER_WORKSPACE_INGRESS_SECRET",
  "ONECOMPUTER_EGRESS_GRANT_SECRET",
  "ONECOMPUTER_AGENT_BRIDGE_SECRET",
  "ONECOMPUTER_HERMES_API_SECRET",
  "ONECOMPUTER_CHANNEL_CREDENTIAL_SECRET",
  "ONECOMPUTER_CHANNEL_BROKER_TOKEN",
  "ONECOMPUTER_SCHEDULE_PROMPT_SECRET",
  "ONECOMPUTER_SCHEDULER_TOKEN",
  "ONECOMPUTER_AI_USAGE_TOKEN",
  "ONECOMPUTER_AI_USAGE_TASK_BINDING_SECRET",
];

export const environmentAliases = new Map([
  ["ONECOMPUTER_ENTRA_TENANT_ID", "ONECOMPUTER_MS365_TENANT_ID"],
  ["ONECOMPUTER_ENTRA_CLIENT_ID", "ONECOMPUTER_MS365_CLIENT_ID"],
  ["ONECOMPUTER_ENTRA_CLIENT_SECRET", "ONECOMPUTER_MS365_CLIENT_SECRET"],
  ["KASM_LOCAL_NETWORK_PREFIX", "KASM_LOCAL_NETWORK"],
]);

export const coupledEnvironmentGroups = [
  [
    "ONECOMPUTER_WEB_PUSH_VAPID_PUBLIC_KEY",
    "ONECOMPUTER_WEB_PUSH_VAPID_PRIVATE_KEY",
  ],
  [
    "ONECOMPUTER_POLICY_SIGNING_KEY_ID",
    "ONECOMPUTER_POLICY_SIGNING_PRIVATE_KEY_B64",
    "ONECOMPUTER_POLICY_VERIFICATION_KEYS_B64",
  ],
];

export function parseEnvironment(contents) {
  const entries = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (match) entries.push({ key: match[1], value: match[2], line: index + 1 });
  }
  const values = new Map();
  const counts = new Map();
  for (const entry of entries) {
    values.set(entry.key, entry.value);
    counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
  }
  return {
    entries,
    values,
    duplicates: [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([key]) => key),
  };
}

export function initializeEnvironment(template, timeZone) {
  let contents = template;
  const randomSecret = () => randomBytes(32).toString("base64url");
  const replace = (name, value) => {
    const expression = new RegExp(`^${name}=.*$`, "m");
    if (!expression.test(contents)) throw new Error(`${name} is missing from .env.example`);
    contents = contents.replace(expression, `${name}=${value}`);
  };

  for (const name of generatedSecretNames) replace(name, randomSecret());

  replace("ONECOMPUTER_LITELLM_MASTER_KEY", `sk-${randomSecret()}`);
  replace("ONECOMPUTER_OPENVTC_EXECUTOR_SEED_B64", randomBytes(32).toString("base64"));
  replace("ONECOMPUTER_WORKSPACE_IMAGE", "onecomputer/workspace:dev");
  replace("ONECOMPUTER_TIME_ZONE", timeZone);

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
  return contents;
}

export function environmentParity(template, current) {
  const templateEnvironment = parseEnvironment(template);
  const currentEnvironment = parseEnvironment(current);
  const templateKeys = new Set(templateEnvironment.entries.map(({ key }) => key));
  const currentKeys = new Set(currentEnvironment.entries.map(({ key }) => key));
  return {
    missing: [...templateKeys].filter((key) => !currentKeys.has(key)),
    extra: [...currentKeys].filter((key) => !templateKeys.has(key)),
    duplicates: currentEnvironment.duplicates,
  };
}

export function mergeEnvironment(template, current, initialized) {
  const templateEnvironment = parseEnvironment(template);
  const currentEnvironment = parseEnvironment(current);
  const initializedEnvironment = parseEnvironment(initialized);
  if (templateEnvironment.duplicates.length) {
    throw new Error(`.env.example contains duplicate variables: ${templateEnvironment.duplicates.join(", ")}`);
  }
  if (currentEnvironment.duplicates.length) {
    throw new Error(`The environment contains duplicate variables: ${currentEnvironment.duplicates.join(", ")}`);
  }

  for (const group of coupledEnvironmentGroups) {
    const present = group.filter((key) => currentEnvironment.values.has(key));
    if (present.length > 0 && present.length < group.length) {
      throw new Error(`The coupled environment group must be complete before updating: ${group.join(", ")}`);
    }
  }

  const templateKeys = new Set(templateEnvironment.entries.map(({ key }) => key));
  const extras = currentEnvironment.entries.filter(({ key }) => !templateKeys.has(key));
  let preserved = 0;
  let mapped = 0;
  let initializedCount = 0;
  const merged = template.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return line;
    const key = match[1];
    if (currentEnvironment.values.has(key)) {
      preserved += 1;
      return `${key}=${currentEnvironment.values.get(key)}`;
    }
    const alias = environmentAliases.get(key);
    if (alias && currentEnvironment.values.has(alias)) {
      mapped += 1;
      return `${key}=${currentEnvironment.values.get(alias)}`;
    }
    if (!initializedEnvironment.values.has(key)) {
      throw new Error(`${key} is missing from the initialized environment`);
    }
    initializedCount += 1;
    return `${key}=${initializedEnvironment.values.get(key)}`;
  });

  if (extras.length) {
    merged.push(
      "",
      "# Preserved values not present in .env.example; review before removing.",
      ...extras.map(({ key, value }) => `${key}=${value}`),
    );
  }
  return {
    contents: merged.join("\n"),
    preserved,
    mapped,
    initialized: initializedCount,
    extras: extras.map(({ key }) => key),
  };
}
