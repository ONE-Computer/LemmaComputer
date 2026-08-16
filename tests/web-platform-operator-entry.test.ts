import assert from "node:assert/strict";
import test from "node:test";
import { platformOperatorEntryRedirect } from "../apps/web/platform-operator-entry.mjs";

test("the friendly platform entry preserves the narrowly scoped operator UI route", () => {
  assert.equal(platformOperatorEntryRedirect("GET", "/platform"), "/api/v1/platform/ui");
  assert.equal(
    platformOperatorEntryRedirect("HEAD", "/platform/?error=step-up-not-completed"),
    "/api/v1/platform/ui?error=step-up-not-completed",
  );
  assert.equal(platformOperatorEntryRedirect("POST", "/platform"), null);
  assert.equal(platformOperatorEntryRedirect("GET", "/platform/sign-in"), null);
});
