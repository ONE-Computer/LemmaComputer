import { readFile } from "node:fs/promises";
import { readEnvironmentFile, writeEnvironmentFile } from "./environment-files.mjs";
import {
  environmentParity,
  initializeEnvironment,
  mergeEnvironment,
  parseEnvironment,
} from "./environment-template.mjs";
import {
  environmentContract,
  environmentVariableNameSet,
  resolveDeploymentEnvironment,
  renderEnvironmentTemplate,
  serializeEnvironment,
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
  throw new Error(".env.example is not generated from scripts/setup/deployment-config.mjs; run npm run env:example -- --write");
}
const currentValues = readEnvironmentFile(destination);
if (write && currentValues.LEMMACOMPUTER_INSTALLATION_KIND === "worktree" && !currentValues.LEMMACOMPUTER_INSTALLATION_ID) {
  const existingId = currentValues.LEMMACOMPUTER_COMPOSE_PROJECT_NAME?.match(/^lemmacomputer-([a-f0-9]{10})$/)?.[1];
  if (existingId) currentValues.LEMMACOMPUTER_INSTALLATION_ID = existingId;
}
const current = serializeEnvironment(currentValues);
const parity = environmentParity(template, current);
const retiredSensitiveVariableNames = new Set(["LEMMACOMPUTER_OPENAI_API_KEY", "LEMMACOMPUTER_CLAUDE_API_KEY", "LEMMACOMPUTER_GLM_API_KEY", "LEMMACOMPUTER_LITELLM_UI_PASSWORD"]);
const retiredSensitive = parity.extra.filter((name) => retiredSensitiveVariableNames.has(name));
const registeredDeploymentValues = (values) => Object.fromEntries(
  [...values].filter(([key]) => !key.startsWith("LEMMACOMPUTER_") || environmentVariableNameSet.has(key)),
);

if (check) {
  if (parity.extra.length) process.stdout.write(`Legacy or unrecognized variables (preserved by env:update): ${parity.extra.join(", ")}\n`);
  if (retiredSensitive.length) process.stdout.write(`Retired sensitive variables are still present and no longer used: ${retiredSensitive.join(", ")}. Review these after provider-settings cutover.\n`);
  try {
    const values = registeredDeploymentValues(parseEnvironment(current).values);
    const validated = validateDeploymentEnvironment(values, { profile, strict: true });
    process.stdout.write(`Deployment environment contract is valid for ${validated.LEMMACOMPUTER_INSTALLATION_KIND} (${parity.extra.length} preserved extra variable${parity.extra.length === 1 ? "" : "s"}).\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
  const initialized = initializeEnvironment(template, timeZone);
  const resolved = resolveDeploymentEnvironment(currentValues);
  // Omitted ordinary settings use installation defaults. Missing keys that
  // require generated secret material must still be initialized by the merge.
  for (const item of environmentContract) {
    if (!item.generated && !Object.hasOwn(currentValues, item.key)) currentValues[item.key] = resolved[item.key];
  }
  const merged = mergeEnvironment(template, serializeEnvironment(currentValues), initialized);
  const values = registeredDeploymentValues(parseEnvironment(merged.contents).values);
  validateDeploymentEnvironment(values, { profile, strict: true });
  await writeEnvironmentFile(destination, parseEnvironment(merged.contents).values);
  process.stdout.write([
    `Updated ${destination} without rotating ${merged.preserved} existing values.`,
    `Mapped ${merged.mapped} renamed or previously implicit values and initialized ${merged.initialized} missing values.`,
    `${merged.extras.length} extra variable${merged.extras.length === 1 ? " was" : "s were"} preserved for manual review.`,
    "",
  ].join("\n"));
  if (retiredSensitive.length) process.stdout.write(`Retired sensitive variables remain in ${destination}; env:update intentionally did not delete them. Remove ${retiredSensitive.join(", ")} manually after provider-settings cutover.\n`);
}
