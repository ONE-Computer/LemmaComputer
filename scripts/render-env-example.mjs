import { readFile, writeFile } from "node:fs/promises";
import {
  renderEnvironmentTemplate,
  renderQualificationEnvironmentTemplate,
} from "./deployment-config.mjs";

const qualification = process.argv.includes("--qualification");
const destination = process.argv.find((argument) => argument.startsWith("--file="))?.slice("--file=".length)
  ?? (qualification ? ".env.qualification.example" : ".env.example");
const write = process.argv.includes("--write");
// The npm scripts intentionally default to --check. A caller may append
// `-- --write` to opt into regeneration without bypassing the repository
// command, so explicit write mode takes precedence over that default.
const check = process.argv.includes("--check") && !write;
if (check === write) throw new Error("Choose exactly one of --check or --write");

const rendered = qualification ? renderQualificationEnvironmentTemplate() : renderEnvironmentTemplate();
if (check) {
  const current = await readFile(destination, "utf8");
  if (current !== rendered) {
    throw new Error(`${destination} is not generated from scripts/deployment-config.mjs; run npm run env:example -- --write`);
  }
  process.stdout.write(`${destination} matches the deployment environment contract.\n`);
} else {
  await writeFile(destination, rendered, { mode: 0o644 });
  process.stdout.write(`Rendered ${destination} from the deployment environment contract.\n`);
}
