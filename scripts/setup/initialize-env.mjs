import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { parseEnvironment, writeEnvironmentFile } from "./environment-files.mjs";
import { applyInstallationProfile, initializeEnvironment } from "./environment-template.mjs";
import { environmentContract, renderEnvironmentTemplate, worktreeEnvironmentOverrides } from "./deployment-config.mjs";

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

const values = Object.fromEntries(parseEnvironment(contents).values);
if (values.LEMMACOMPUTER_INSTALLATION_KIND === "worktree") {
  const id = randomBytes(5).toString("hex");
  Object.assign(values, Object.fromEntries(worktreeEnvironmentOverrides({
    id,
    slug: `lemmacomputer-${id}`,
    portOffset: 1000 + (Number.parseInt(id.slice(0, 6), 16) % 20000),
  })));
}
await writeEnvironmentFile(destination, values);
process.stdout.write([
  `Created ${destination} with fresh local service, signing, and encryption secrets.`,
  "Run npm run env:check before starting the stack. Configure optional Microsoft integrations only when needed.",
  "Model-provider credentials are configured in the product UI after startup, not in this file.",
  "",
].join("\n"));
