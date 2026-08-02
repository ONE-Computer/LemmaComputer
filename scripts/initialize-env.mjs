import { access, writeFile } from "node:fs/promises";
import { initializeEnvironment } from "./environment-template.mjs";
import { renderEnvironmentTemplate } from "./deployment-config.mjs";

const destination = process.argv.find((argument) => argument.startsWith("--file="))?.slice("--file=".length) ?? ".env";
const force = process.argv.includes("--force");

if (!force && await access(destination).then(() => true).catch(() => false)) {
  throw new Error(`${destination} already exists; use --force only if replacing its local secrets is intentional`);
}

const template = renderEnvironmentTemplate();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
const contents = initializeEnvironment(template, timeZone);

await writeFile(destination, contents, { mode: 0o600 });
process.stdout.write([
  `Created ${destination} with fresh local service, signing, and encryption secrets.`,
  "Configure the provider and Microsoft Entra values that remain marked as placeholders before starting the stack.",
  "",
].join("\n"));
