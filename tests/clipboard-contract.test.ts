import assert from "node:assert/strict";
import test from "node:test";
import { clipboardPolicySchema, launchSchema } from "@lemmacomputer/contracts";

test("clipboard policy is bounded to explicit text directions and size", () => {
  assert.deepEqual(clipboardPolicySchema.parse({
    enabled: true,
    localToWorkspace: true,
    workspaceToLocal: true,
    maxBytes: 65_536,
  }), {
    enabled: true,
    localToWorkspace: true,
    workspaceToLocal: true,
    maxBytes: 65_536,
  });
  assert.throws(() => clipboardPolicySchema.parse({
    enabled: true,
    localToWorkspace: true,
    workspaceToLocal: true,
    maxBytes: 1_048_577,
  }));
});

test("workspace launches expose the native clipboard capability without clipboard content", () => {
  const launch = launchSchema.parse({
    launchUrl: "https://127.0.0.1:16920/?clipboard_seamless=true",
    expiresAt: "2026-07-23T02:05:00.000Z",
    clipboard: {
      status: "available",
      reasonCode: "CLIPBOARD_READY",
      mode: "native",
      localToWorkspace: true,
      workspaceToLocal: true,
      mimeTypes: ["text/plain"],
      maxBytes: 65_536,
      requiresUserGesture: true,
      supportedBrowsers: ["chromium"],
      fallback: "kasm-control-panel",
    },
  });
  assert.equal(launch.clipboard.maxBytes, 65_536);
  assert.equal(JSON.stringify(launch).includes("clipboardContent"), false);
});
