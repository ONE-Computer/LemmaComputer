import { spawnSync } from "node:child_process";

for (const [command, args] of [
  [process.execPath, ["scripts/dev-doctor.mjs"]],
  ["npm", ["run", "env:check"]],
  ["npm", ["run", "compose:config"]],
  ["npm", ["run", "build"]],
  ["npm", ["test"]],
]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
process.stdout.write("Quick local gate passed.\n");
