import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const envFileIndex = process.argv.indexOf("--write-env");
const envFile = envFileIndex === -1 ? undefined : process.argv[envFileIndex + 1];
const entry = `LEMMACOMPUTER_EGRESS_GRANT_SECRET=${randomBytes(32).toString("base64url")}`;

if (!envFile) {
  process.stdout.write(`${entry}\n`);
} else {
  if (envFile.startsWith("-")) throw new Error("--write-env requires a specific environment file");
  const existing = await readFile(envFile, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const retained = existing
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("LEMMACOMPUTER_EGRESS_GRANT_SECRET="))
    .join("\n")
    .replace(/\n+$/, "");
  await writeFile(envFile, `${retained ? `${retained}\n` : ""}${entry}\n`, { mode: 0o600 });
  process.stdout.write(`Updated ${envFile} with a new egress grant secret.\n`);
}
