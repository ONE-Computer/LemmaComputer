import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseEnvironment } from "./environment-template.mjs";
import {
  environmentVariableNameSet,
  projectServiceEnvironment,
  serializeEnvironment,
  validateDeploymentEnvironment,
} from "./deployment-config.mjs";

const source = process.argv.find((argument) => argument.startsWith("--file="))?.slice("--file=".length) ?? ".env";
const destination = process.argv.find((argument) => argument.startsWith("--directory="))?.slice("--directory=".length) ?? ".runtime-env";
const profile = process.argv.find((argument) => argument.startsWith("--profile="))?.slice("--profile=".length);
const check = process.argv.includes("--check");
const current = await readFile(source, "utf8");
const values = Object.fromEntries(
  [...parseEnvironment(current).values].filter(([key]) => !key.startsWith("LEMMACOMPUTER_") || environmentVariableNameSet.has(key)),
);
const validated = validateDeploymentEnvironment(values, { profile, strict: true });
const services = projectServiceEnvironment(validated);

if (check) {
  for (const service of Object.keys(services)) {
    await readFile(resolve(destination, `${service}.env`), "utf8");
  }
  process.stdout.write(`Service environment projections are present in ${destination}.\n`);
} else {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await chmod(destination, 0o700);
  for (const [service, environment] of Object.entries(services)) {
    const target = resolve(destination, `${service}.env`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, serializeEnvironment(environment), { mode: 0o600 });
    await chmod(target, 0o600);
  }
  process.stdout.write(`Rendered least-privilege service environment files in ${destination}.\n`);
}
