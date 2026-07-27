import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import {
  environmentParity,
  initializeEnvironment,
  mergeEnvironment,
} from "./environment-template.mjs";

const destination = process.argv.find((argument) => argument.startsWith("--file="))?.slice("--file=".length) ?? ".env";
const check = process.argv.includes("--check");
const write = process.argv.includes("--write");
if (check === write) throw new Error("Choose exactly one of --check or --write");

const template = await readFile(".env.example", "utf8");
const current = await readFile(destination, "utf8");
const parity = environmentParity(template, current);

if (check) {
  if (parity.missing.length) process.stdout.write(`Missing variables: ${parity.missing.join(", ")}\n`);
  if (parity.extra.length) process.stdout.write(`Variables not in .env.example (preserved by env:update): ${parity.extra.join(", ")}\n`);
  if (parity.duplicates.length) process.stdout.write(`Duplicate variables: ${parity.duplicates.join(", ")}\n`);
  if (!parity.missing.length && !parity.duplicates.length) {
    process.stdout.write(`Environment schema is current (${parity.extra.length} preserved extra variable${parity.extra.length === 1 ? "" : "s"}).\n`);
  } else {
    process.exitCode = 1;
  }
} else {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
  const initialized = initializeEnvironment(template, timeZone);
  const merged = mergeEnvironment(template, current, initialized);
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
}
