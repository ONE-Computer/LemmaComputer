import assert from "node:assert/strict";
import test from "node:test";
import { retryRetryableRequest } from "../apps/web/src/workspace-api.js";

test("retryRetryableRequest retries bounded transient failures", async () => {
  let attempts = 0;
  const result = await retryRetryableRequest(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("temporary"), { retryable: true });
    return "ready";
  }, { attempts: 3, baseDelayMs: 0 });
  assert.equal(result, "ready");
  assert.equal(attempts, 3);
});

test("retryRetryableRequest does not retry terminal failures", async () => {
  let attempts = 0;
  await assert.rejects(
    retryRetryableRequest(async () => {
      attempts += 1;
      throw Object.assign(new Error("configuration rejected"), { retryable: false });
    }, { attempts: 3, baseDelayMs: 0 }),
    /configuration rejected/,
  );
  assert.equal(attempts, 1);
});
