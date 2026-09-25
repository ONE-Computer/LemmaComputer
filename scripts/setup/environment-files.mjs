import { readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import {
  environmentContract,
  resolveDeploymentEnvironment,
} from "./deployment-config.mjs";

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

const visibleNames = new Set([
  "LEMMACOMPUTER_INSTALLATION_KIND",
  "LEMMACOMPUTER_RUNTIME_ENVIRONMENT",
  "LEMMACOMPUTER_PUBLIC_WEB_URL",
  "LEMMACOMPUTER_WEB_PORT",
  "LEMMACOMPUTER_TIME_ZONE",
  // Keep optional integrations discoverable even before credentials are supplied.
  "LEMMACOMPUTER_AUTH_EMAIL_TRANSPORT",
  "LEMMACOMPUTER_INVITATION_DELIVERY_MODE",
  "LEMMACOMPUTER_POSTMARK_SERVER_TOKEN",
  "LEMMACOMPUTER_POSTMARK_FROM",
  "LEMMACOMPUTER_GOOGLE_AUTH_CLIENT_ID",
  "LEMMACOMPUTER_GOOGLE_AUTH_CLIENT_SECRET",
  "LEMMACOMPUTER_MICROSOFT_AUTH_CLIENT_ID",
  "LEMMACOMPUTER_MICROSOFT_AUTH_CLIENT_SECRET",
  "LEMMACOMPUTER_CUSTOMER_SSO_TRUSTED_IDP_ORIGINS",
  "LEMMACOMPUTER_MS365_TENANT_ID",
  "LEMMACOMPUTER_MS365_CLIENT_ID",
  "LEMMACOMPUTER_MS365_CLIENT_SECRET",
  "LEMMACOMPUTER_MS365_SITE_ADMIN_CLIENT_ID",
  "LEMMACOMPUTER_MS365_SITE_ADMIN_CLIENT_SECRET",
]);

/** Read one installation file; defaults are resolved without rewriting it. */
export function readEnvironmentFile(source = ".env", { resolved = false } = {}) {
  const parsed = parseEnvironment(readFileSync(source, "utf8"));
  if (parsed.duplicates.length) throw new Error(`Duplicate variables in ${source}: ${parsed.duplicates.join(", ")}`);
  const values = Object.fromEntries(parsed.values);
  return resolved ? { ...values, ...resolveDeploymentEnvironment(values) } : values;
}

export function renderCompactEnvironment(input) {
  const values = input instanceof Map ? Object.fromEntries(input) : input;
  const defaults = resolveDeploymentEnvironment({
    LEMMACOMPUTER_INSTALLATION_KIND: values.LEMMACOMPUTER_INSTALLATION_KIND,
    LEMMACOMPUTER_INSTALLATION_ID: values.LEMMACOMPUTER_INSTALLATION_ID,
  });
  const lines = [
    "# LemmaComputer installation settings and generated secrets. Never commit this file.",
    "# Omitted settings use built-in defaults; .env.example is the full reference.",
    "# Docker names and local image tags are derived from the generated installation ID.",
    "# Optional integration credentials stay empty until you configure them.",
  ];
  let lastSection;
  for (const item of environmentContract) {
    if (!Object.hasOwn(values, item.key)) continue;
    const value = values[item.key];
    const keep = item.generated || visibleNames.has(item.key)
      || (item.key === "LEMMACOMPUTER_INSTALLATION_ID" && value)
      || value !== defaults[item.key];
    if (!keep) continue;
    if (item.section !== lastSection) {
      lines.push("", `# ${item.section}`);
      lastSection = item.section;
    }
    if (!item.generated) lines.push(`# ${item.description}`);
    lines.push(`${item.key}=${value}`);
  }
  const known = new Set(environmentContract.map((item) => item.key));
  const extras = Object.entries(values).filter(([key]) => !known.has(key));
  if (extras.length) lines.push("", "# Preserved unrecognized or retired values; review before removing.", ...extras.map(([key, value]) => `${key}=${value}`));
  return `${lines.join("\n")}\n`;
}

async function atomicWrite(path, contents) {
  const temporary = `${path}.update-${process.pid}`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function writeEnvironmentFile(source, values) {
  await atomicWrite(source, renderCompactEnvironment(values));
}
