import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readEnvironmentFile } from "./environment-files.mjs";
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
const values = Object.fromEntries(
  Object.entries(readEnvironmentFile(source)).filter(([key]) => !key.startsWith("LEMMACOMPUTER_") || environmentVariableNameSet.has(key)),
);
const validated = validateDeploymentEnvironment(values, { profile, strict: true });
const services = projectServiceEnvironment(validated);
const compose = await readFile(new URL("../../compose.yaml", import.meta.url), "utf8");
const composeKeys = new Set([...compose.matchAll(/\$\{(LEMMACOMPUTER_[A-Z0-9_]+)/g)].map(([, key]) => key));
const composeValues = Object.fromEntries([...composeKeys].map((key) => [key, validated[key]]));

if (check) {
  await readFile(resolve(destination, "compose.env"), "utf8");
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
  await writeFile(resolve(destination, "compose.env"), serializeEnvironment(composeValues), { mode: 0o600 });
  await chmod(resolve(destination, "compose.env"), 0o600);
  process.stdout.write(`Rendered least-privilege service environment files in ${destination}.\n`);
}
