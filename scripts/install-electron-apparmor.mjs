import { copyFile, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const profileName = "lemmacomputer-workspace-electron";
const source = resolve("infra/apparmor", profileName);
const target = `/etc/apparmor.d/${profileName}`;

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
};

const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

if (process.argv[2] === "check") {
  run("apparmor_parser", ["-Q", "-T", source]);
  process.stdout.write(`${profileName} syntax is valid (${await digest(source)}).\n`);
  process.exit(0);
}

if (process.argv[2] !== "install") {
  throw new Error("usage: node scripts/install-electron-apparmor.mjs <check|install>");
}
if (process.getuid?.() !== 0) {
  throw new Error("installation requires root; rerun this command with sudo");
}

await mkdir("/etc/apparmor.d", { recursive: true });
const temporary = `${target}.tmp-${process.pid}`;
try {
  await copyFile(source, temporary);
  await rename(temporary, target);
} finally {
  await unlink(temporary).catch(() => undefined);
}
run("chmod", ["0644", target]);
run("apparmor_parser", ["-r", "-W", target]);

const profiles = await readFile("/sys/kernel/security/apparmor/profiles", "utf8");
if (!profiles.split("\n").some((line) => line.startsWith(`${profileName} `))) {
  throw new Error(`${profileName} was not loaded by AppArmor`);
}
process.stdout.write(`${profileName} installed and loaded (${await digest(target)}).\n`);
