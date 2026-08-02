import { generateKeyPairSync, randomBytes } from "node:crypto";
import webPush from "web-push";
import {
  coupledEnvironmentGroups,
  environmentAliases,
  environmentContract,
  generatedSecretNames,
} from "./deployment-config.mjs";

export { coupledEnvironmentGroups, environmentAliases };

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

  const nameFor = (generator) => {
    const name = environmentContract.find((item) => item.generator === generator)?.key;
    if (!name) throw new Error(`No deployment environment variable is registered for ${generator}`);
    return name;
  };
  for (const name of generatedSecretNames) replace(name, randomSecret());

  replace(nameFor("master-key"), `sk-${randomSecret()}`);
  replace(nameFor("seed"), randomBytes(32).toString("base64"));
  replace(environmentContract.find((item) => item.initialize === "time-zone")?.key ?? "ONECOMPUTER_TIME_ZONE", timeZone);

  const vapid = webPush.generateVAPIDKeys();
  replace(nameFor("vapid-public"), vapid.publicKey);
  replace(nameFor("vapid-private"), vapid.privateKey);

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
  replace(nameFor("policy-key-id"), keyId);
  replace(
    nameFor("policy-private"),
    privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  );
  replace(
    nameFor("policy-public-set"),
    Buffer.from(JSON.stringify(keySet), "utf8").toString("base64"),
  );

  const telegramGrant = generateKeyPairSync("ed25519");
  replace(
    nameFor("telegram-grant-private"),
    telegramGrant.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  );
  replace(
    nameFor("telegram-grant-public"),
    telegramGrant.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  );
  const telegramEnvelope = generateKeyPairSync("rsa", { modulusLength: 3072 });
  replace(
    nameFor("telegram-envelope-private"),
    telegramEnvelope.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  );
  replace(
    nameFor("telegram-envelope-public"),
    telegramEnvelope.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
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
    const currentValue = currentEnvironment.values.get(key);
    const templateValue = templateEnvironment.values.get(key);
    if (currentEnvironment.values.has(key) && !(currentValue === "" && templateValue !== "")) {
      preserved += 1;
      return `${key}=${currentValue}`;
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
