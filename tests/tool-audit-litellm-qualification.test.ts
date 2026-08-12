import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("the MCP audit qualification is pinned and measures exceptional post-hook gaps", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [packageJson, qualifier] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, "scripts/qualify-litellm-mcp-audit-hooks.py"), "utf8"),
  ]);
  assert.match(packageJson, /"qualify:mcp-audit-hooks"/);
  assert.match(packageJson, /ghcr\.io\/berriai\/litellm:v1\.93\.0@sha256:a1745e629abfb17d434426ff48b115f54f4f4c4a0f5af241de569e93c63c411e/);
  assert.match(qualifier, /_fire_mcp_tool_call_logging/);
  assert.match(qualifier, /"success": "success_hook"/);
  assert.match(qualifier, /"mcp_error_result": "failure_hook"/);
  assert.match(qualifier, /"raised_failure": "no_post_hook"/);
  assert.match(qualifier, /"timed_out": "no_post_hook"/);
  assert.match(qualifier, /"cancelled": "no_post_hook"/);
  assert.match(qualifier, /post_hooks_insufficient_for_mandatory_terminal_audit/);
});
