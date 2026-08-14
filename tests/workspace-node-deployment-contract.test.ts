import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("workspace node liveness does not require Control client credentials", async () => {
  const compose = await source("compose.yaml");
  const workspaceController = compose.slice(
    compose.indexOf("  workspace-controller:"),
    compose.indexOf("  db-migrate:"),
  );

  assert.match(workspaceController, /net\.connect\(4101,'127\.0\.0\.1'\)/);
  assert.doesNotMatch(workspaceController, /fetch\(['"]http:\/\/127\.0\.0\.1:4101\/healthz/);
  assert.doesNotMatch(workspaceController, /CLIENT_(?:CERT|KEY)|CONTROL_CLIENT/);
});

test("the local mTLS qualification has a stable one-shot command", async () => {
  const packageDocument = JSON.parse(await source("package.json")) as {
    scripts: Record<string, string>;
  };

  assert.equal(
    packageDocument.scripts["qualify:internal-mtls"],
    "tsx --test tests/internal-mtls-boundaries.test.ts tests/litellm-admin-proxy.test.ts",
  );
});
