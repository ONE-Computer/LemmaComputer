import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
};

const environment = await readFile(".env", "utf8");
const project = environment.match(/^LEMMACOMPUTER_COMPOSE_PROJECT_NAME=(.+)$/m)?.[1]?.trim();
if (!project || project === "lemmacomputer") {
  throw new Error("Remote MCP egress qualification requires an isolated worktree environment");
}
const suffix = project.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 80);
const image = `lemmacomputer/litellm:mcp-egress-qualification-${suffix}`;
const qualification = resolve("tests/litellm-remote-mcp-egress.py");

run("docker", ["build", "--file", "docker/Dockerfile.litellm", "--tag", image, "."]);
run("docker", [
  "run", "--rm", "--network", "none", "--entrypoint", "python",
  "--env", "LEMMACOMPUTER_REMOTE_MCP_EGRESS_PROXY_URL=http://litellm-gateway:test@127.0.0.1:1",
  "--mount", `type=bind,src=${qualification},dst=/tmp/qualification.py,readonly`,
  image,
  "/tmp/qualification.py",
]);

process.stdout.write("Pinned LiteLLM remote MCP egress qualification passed.\n");
