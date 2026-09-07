import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("routine demo deployment preserves state and rejects unsafe updates", () => {
  const result = spawnSync("python3", ["-B", "tests/demo-update-host-test.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
