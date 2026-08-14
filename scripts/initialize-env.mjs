import { access, writeFile } from "node:fs/promises";
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

if (!force && await access(destination).then(() => true).catch(() => false)) {
  throw new Error(`${destination} already exists; use --force only if replacing its local secrets is intentional`);
}

const template = renderEnvironmentTemplate();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
const initialized = initializeEnvironment(template, timeZone);
const contents = profile === undefined ? initialized : applyInstallationProfile(initialized, profile);

// The worktree profile permits unresolved Entra placeholders so that an
// evaluation or development stack starts without a Microsoft tenant. Every
// other profile validates them strictly before Compose renders.
const entraRequired = (profile ?? installationKind.default) !== "worktree";

await writeFile(destination, contents, { mode: 0o600 });
process.stdout.write([
  `Created ${destination} with fresh local service, signing, and encryption secrets.`,
  entraRequired
    ? "Configure the provider and Microsoft Entra values that remain marked as placeholders before starting the stack."
    : "Model-provider credentials are configured in the product UI after startup, not in this file.",
  "",
].join("\n"));
