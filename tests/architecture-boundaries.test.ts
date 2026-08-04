import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const source = async (relativePath: string) => readFile(path.join(root, relativePath), "utf8");

const sourceTree = async (relativePath: string) => {
  const directory = path.join(root, relativePath);
  const files = await readdir(directory, { recursive: true });
  return (await Promise.all(files.filter((file) => /\.[cm]?[jt]sx?$/.test(file)).map((file) => readFile(path.join(directory, file), "utf8")))).join("\n");
};

test("owned contracts do not import vendor, UI, database, or container authority", async () => {
  const contracts = await source("packages/contracts/src/index.ts");
  assert.doesNotMatch(contracts, /@lemmacomputer\/(kasm-adapter|litellm-adapter|workspace-store)|from ["'](?:pg|fastify|react)|docker/i);
});

test("owned persistence does not depend on Kasm, LiteLLM, or the browser", async () => {
  const persistence = await source("packages/workspace-store/src/index.ts");
  assert.doesNotMatch(persistence, /@lemmacomputer\/(kasm-adapter|litellm-adapter)|apps\/web|react|docker/i);
});

test("browser source contains no server authority or credential names", async () => {
  const web = await sourceTree("apps/web/src");
  assert.doesNotMatch(web, /LEMMACOMPUTER_OPENAI_API_KEY|LITELLM_MASTER_KEY|CONTROLLER_INTERNAL_TOKEN|FIXTURE_APPROVAL_SECRET|DOCKER_SOCKET|POSTGRES_PASSWORD/);
});
