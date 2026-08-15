import assert from "node:assert/strict";
import test from "node:test";
import { worktreeEnvironmentOverrides } from "../scripts/deployment-config.mjs";
import {
  applyWorktreeEnvironmentOverrides,
  isWorktreeResourceName,
  legacyWorktreeSlug,
  worktreeId,
  worktreeSlug,
} from "../scripts/worktree-names.mjs";

test("worktree Docker resources use the LemmaComputer namespace", () => {
  const id = worktreeId({ root: "/workspace/task", branch: "123-example" });
  assert.match(id, /^[a-f0-9]{10}$/);
  assert.equal(worktreeSlug("a1b2c3d4e5"), "lemmacomputer-a1b2c3d4e5");
  assert.equal(legacyWorktreeSlug("a1b2c3d4e5"), "oc-a1b2c3d4e5");
  assert.equal(isWorktreeResourceName("lemmacomputer-a1b2c3d4e5"), true);
  assert.equal(isWorktreeResourceName("oc-a1b2c3d4e5"), false);
});

test("legacy namespace migration changes only canonical oc resource values", () => {
  const id = "a1b2c3d4e5";
  const previousOverrides = worktreeEnvironmentOverrides({
    slug: legacyWorktreeSlug(id),
    id,
    portOffset: 1234,
  });
  const overrides = worktreeEnvironmentOverrides({
    slug: worktreeSlug(id),
    id,
    portOffset: 1234,
  });
  const current = [...previousOverrides]
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
    .replace("LEMMACOMPUTER_WEB_PORT=5408", "LEMMACOMPUTER_WEB_PORT=4174")
    .replace("LEMMACOMPUTER_PUBLIC_WEB_URL=http://localhost:5408", "LEMMACOMPUTER_PUBLIC_WEB_URL=http://localhost:4174")
    .replace("LEMMACOMPUTER_KASM_LOCAL_NETWORK_PREFIX=oc-a1b2c3d4e5-workspace", "LEMMACOMPUTER_KASM_LOCAL_NETWORK_PREFIX=lemmacomputer-workspace");

  const migrated = applyWorktreeEnvironmentOverrides(current, overrides, { previousOverrides });
  assert.match(migrated, /^LEMMACOMPUTER_COMPOSE_PROJECT_NAME=lemmacomputer-a1b2c3d4e5$/m);
  assert.match(migrated, /^LEMMACOMPUTER_CONTROL_CONTAINER=lemmacomputer-a1b2c3d4e5-control-api$/m);
  assert.match(migrated, /^LEMMACOMPUTER_WEB_PORT=4174$/m);
  assert.match(migrated, /^LEMMACOMPUTER_PUBLIC_WEB_URL=http:\/\/localhost:4174$/m);
  assert.match(migrated, /^LEMMACOMPUTER_KASM_LOCAL_NETWORK_PREFIX=lemmacomputer-workspace$/m);
});
