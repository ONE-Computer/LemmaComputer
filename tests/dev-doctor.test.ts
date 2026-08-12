import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  containerMountedFilePaths,
  inspectReadablePaths,
  litellmMountedFilePaths,
  postgresMountedFilePaths,
} from "../scripts/dev-doctor-lib.mjs";

test("dev doctor covers every repository file mounted into LiteLLM", () => {
  assert.deepEqual(litellmMountedFilePaths, [
    "config/litellm/config.yaml",
    "config/litellm/logging.yaml",
    "integrations/litellm/lemmacomputer_policy_callback.py",
  ]);
});

test("worktree initialization repairs every repository file mounted into a container", () => {
  assert.deepEqual(postgresMountedFilePaths, [
    "infra/postgres/init-auth-database.sh",
  ]);
  assert.deepEqual(containerMountedFilePaths, [
    ...litellmMountedFilePaths,
    ...postgresMountedFilePaths,
  ]);
});

test("readable LiteLLM bind mounts pass without diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lemmacomputer-doctor-"));
  const fixture = join(directory, "readable.yaml");
  try {
    await writeFile(fixture, "safe fixture\n", { mode: 0o644 });
    assert.deepEqual(await inspectReadablePaths([fixture]), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing and unreadable LiteLLM bind mounts fail with safe path-only diagnostics", async () => {
  const accessPath = async (path: string) => {
    const error = Object.assign(new Error(path.endsWith("missing.yaml") ? "missing secret contents" : "denied secret contents"), {
      code: path.endsWith("missing.yaml") ? "ENOENT" : "EACCES",
    });
    throw error;
  };

  const diagnostics = await inspectReadablePaths([
    "config/litellm/missing.yaml",
    "integrations/litellm/unreadable.py",
  ], { accessPath });

  assert.deepEqual(diagnostics, [
    { path: "config/litellm/missing.yaml", reason: "missing" },
    { path: "integrations/litellm/unreadable.py", reason: "unreadable" },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("secret contents"), false);
});
