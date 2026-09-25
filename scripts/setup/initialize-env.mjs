import { access } from "node:fs/promises";
import { parseEnvironment, writeEnvironmentFiles } from "./environment-files.mjs";
import { applyInstallationProfile, initializeEnvironment } from "./environment-template.mjs";
import { environmentContract, renderEnvironmentTemplate } from "./deployment-config.mjs";

const installationKindKey = "LEMMACOMPUTER_INSTALLATION_KIND";
const installationKind = environmentContract.find((item) => item.key === installationKindKey);
if (!installationKind?.values) throw new Error(`${installationKindKey} is missing from the deployment environment contract`);
const installationKinds = installationKind.values;

const destination = process.argv.find((argument) => argument.startsWith("--file="))?.slice("--file=".length) ?? ".env";
const force = process.argv.includes("--force");
const profile = process.argv.find((argument) => argument.startsWith("--profile="))?.slice("--profile=".length);

if (profile !== undefined && !installationKinds.includes(profile)) {
  throw new Error(`--profile must be one of: ${installationKinds.join(", ")}`);
}

if (!force && (await access(destination).then(() => true).catch(() => false) || await access(`${destination}.state`).then(() => true).catch(() => false))) {
  throw new Error(`${destination} or ${destination}.state already exists; use --force only if replacing its local secrets is intentional`);
}

const template = renderEnvironmentTemplate();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
const initialized = initializeEnvironment(template, timeZone);
const contents = profile === undefined ? initialized : applyInstallationProfile(initialized, profile);

await writeEnvironmentFiles(destination, parseEnvironment(contents).values);
process.stdout.write([
  `Created ${destination} and ${destination}.state with fresh local service, signing, and encryption secrets.`,
  "Run npm run env:check before starting the stack. Configure optional Microsoft integrations only when needed.",
  "Model-provider credentials are configured in the product UI after startup, not in this file.",
  "",
].join("\n"));
