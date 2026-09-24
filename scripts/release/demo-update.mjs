import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const action = args.shift() ?? "status";
const options = {};
for (const arg of args) {
  const match = arg.match(/^--(host|identity|ref|browser-test)=(.+)$/);
  if (!match) throw new Error(`Unknown option: ${arg}`);
  (options[match[1]] ??= []).push(match[2]);
}
if (!["status", "plan", "apply", "rollback"].includes(action)) {
  throw new Error("Usage: npm run demo:update -- status|plan|apply|rollback --host=user@host [--identity=path] [--ref=commit] [--browser-test=tests/ui/example.spec.ts]");
}
const host = options.host?.[0];
if (!host || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) {
  throw new Error("An explicit --host=user@host is required");
}
const ssh = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15"];
if (options.identity) ssh.push("-o", "IdentitiesOnly=yes", "-i", options.identity[0]);
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const run = (command, argv, settings = {}) => {
  const result = spawnSync(command, argv, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...settings });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.code}). ${result.stderr ?? ""}`);
  return result.stdout?.trim();
};
const target = JSON.parse(readFileSync(fileURLToPath(new URL("./demo-target.json", import.meta.url)), "utf8"));
const script = readFileSync(fileURLToPath(new URL("./demo-update-host.py", import.meta.url)));
const remote = (operation, extra = []) => run("ssh", [...ssh, host,
  ["sudo", "-n", "python3", "-", operation, "--target-json", JSON.stringify(target), ...extra].map(quote).join(" "),
], { input: script });
if (["status", "rollback"].includes(action)) {
  process.stdout.write(`${remote(action)}\n`);
} else {
  const root = run("git", ["rev-parse", "--show-toplevel"]);
  process.chdir(root);
  const sha = run("git", ["rev-parse", "--verify", `${options.ref?.[0] ?? "HEAD"}^{commit}`]);
  const state = JSON.parse(remote("status"));
  const base = state.sha;
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Demo release has no usable source SHA");
  run("git", ["cat-file", "-e", `${base}^{commit}`]);
  // A candidate is always a committed archive. Nothing from the local .env is sent.
  for (const ref of [base, sha]) {
    const files = run("git", ["ls-tree", "-r", "--name-only", ref]).split("\n");
    if (files.some((file) => /(^|\/)(\.env|\.runtime-env)(\/|$)/.test(file))) {
      throw new Error("Refusing an archive containing tracked deployment secrets");
    }
  }
  const temp = mkdtempSync(join(tmpdir(), "lemma-demo-"));
  const upload = `/tmp/${temp.split("/").at(-1)}.tar`;
  try {
    run("git", ["archive", "--format=tar", `--output=${temp}/base.tar`, base]);
    run("git", ["archive", "--format=tar", `--output=${temp}/candidate.tar`, sha]);
    writeFileSync(join(temp, "metadata.json"), JSON.stringify({ sha, base, verified: false }));
    const transfer = () => {
      run("tar", ["-cf", join(temp, "bundle.tar"), "-C", temp, "base.tar", "candidate.tar", "metadata.json"]);
      run("scp", [...ssh, join(temp, "bundle.tar"), `${host}:${upload}`]);
    };
    transfer();
    const plan = JSON.parse(remote("plan", ["--bundle", upload]));
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    if (action === "apply") {
      if (plan.blocked.length) throw new Error("This candidate needs the full release path; see blocked paths above");
      if (sha !== run("git", ["rev-parse", "HEAD"]) || run("git", ["status", "--porcelain"])) {
        throw new Error("Apply requires the candidate checked out in a clean initialized task worktree");
      }
      run("npm", ["run", "verify:quick"], { stdio: "inherit" });
      if (plan.changed.some((file) => file.startsWith("apps/web/"))) {
        const specs = options["browser-test"] ?? [];
        if (specs.some((spec) => !/^tests\/ui\/[a-zA-Z0-9_./-]+\.spec\.ts$/.test(spec) || spec.includes(".."))) {
          throw new Error("Browser tests must name repository tests/ui/*.spec.ts files");
        }
        run("npm", ["run", "test:ui", "--", ...specs], { stdio: "inherit" });
      }
      if (sha !== run("git", ["rev-parse", "HEAD"]) || run("git", ["status", "--porcelain"])) {
        throw new Error("Candidate changed during verification");
      }
      writeFileSync(join(temp, "metadata.json"), JSON.stringify({ sha, base, verified: true }));
      transfer();
      process.stdout.write(`${remote("apply", ["--bundle", upload])}\n`);
    }
  } finally {
    try { run("ssh", [...ssh, host, `rm -f -- ${quote(upload)}`]); } finally { rmSync(temp, { recursive: true, force: true }); }
  }
}
