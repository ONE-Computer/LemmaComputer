import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import {
  environmentParity,
  initializeEnvironment,
  mergeEnvironment,
  parseEnvironment,
} from "./environment-template.mjs";
import {
  environmentVariableNameSet,
  renderEnvironmentTemplate,
  validateDeploymentEnvironment,
} from "./deployment-config.mjs";

const destination = process.argv.find((argument) => argument.startsWith("--file="))?.slice("--file=".length) ?? ".env";
const check = process.argv.includes("--check");
const write = process.argv.includes("--write");
const profile = process.argv.find((argument) => argument.startsWith("--profile="))?.slice("--profile=".length);
if (check === write) throw new Error("Choose exactly one of --check or --write");

const template = renderEnvironmentTemplate();
const checkedInTemplate = await readFile(".env.example", "utf8");
if (checkedInTemplate !== template) {
  throw new Error(".env.example is not generated from scripts/deployment-config.mjs; run npm run env:example -- --write");
}
const current = await readFile(destination, "utf8");
const parity = environmentParity(template, current);
const retiredSensitiveVariableNames = new Set(["LEMMACOMPUTER_OPENAI_API_KEY", "LEMMACOMPUTER_CLAUDE_API_KEY", "LEMMACOMPUTER_GLM_API_KEY", "LEMMACOMPUTER_LITELLM_UI_PASSWORD"]);
const retiredSensitive = parity.extra.filter((name) => retiredSensitiveVariableNames.has(name));
const registeredDeploymentValues = (values) => Object.fromEntries(
  [...values].filter(([key]) => !key.startsWith("LEMMACOMPUTER_") || environmentVariableNameSet.has(key)),
);

if (check) {
  if (parity.missing.length) process.stdout.write(`Missing variables: ${parity.missing.join(", ")}\n`);
  if (parity.extra.length) process.stdout.write(`Variables not in .env.example (preserved by env:update): ${parity.extra.join(", ")}\n`);
  if (retiredSensitive.length) process.stdout.write(`Retired sensitive variables are still present and no longer used: ${retiredSensitive.join(", ")}. Remove them manually after provider-settings cutover.\n`);
  if (parity.duplicates.length) process.stdout.write(`Duplicate variables: ${parity.duplicates.join(", ")}\n`);
  if (!parity.missing.length && !parity.duplicates.length) {
    try {
      const values = registeredDeploymentValues(parseEnvironment(current).values);
      const validated = validateDeploymentEnvironment(values, { profile, strict: true });
      process.stdout.write(`Deployment environment contract is valid for ${validated.LEMMACOMPUTER_INSTALLATION_KIND} (${parity.extra.length} preserved extra variable${parity.extra.length === 1 ? "" : "s"}).\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  } else {
    process.exitCode = 1;
  }
} else {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
  const initialized = initializeEnvironment(template, timeZone);
  const merged = mergeEnvironment(template, current, initialized);
  const values = registeredDeploymentValues(parseEnvironment(merged.contents).values);
  validateDeploymentEnvironment(values, { profile, strict: true });
  const temporary = `${destination}.update-${process.pid}`;
  try {
    await writeFile(temporary, merged.contents, { mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  process.stdout.write([
    `Updated ${destination} without rotating ${merged.preserved} existing values.`,
    `Mapped ${merged.mapped} renamed or previously implicit values and initialized ${merged.initialized} missing values.`,
    `${merged.extras.length} extra variable${merged.extras.length === 1 ? " was" : "s were"} preserved for manual review.`,
    "",
  ].join("\n"));
  if (retiredSensitive.length) process.stdout.write(`Retired sensitive variables remain in ${destination}; env:update intentionally did not delete them. Remove ${retiredSensitive.join(", ")} manually after provider-settings cutover.\n`);
}
