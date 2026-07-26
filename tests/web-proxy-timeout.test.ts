import assert from "node:assert/strict";
import test from "node:test";
import {
  agentChatControlRequestTimeoutMs,
  controlRequestTimeout,
  ordinaryControlRequestTimeoutMs,
} from "../apps/web/proxy-timeout.mjs";

const chatPath = "/v1/workspaces/workspace-id/chat/agents/hermes-claw/sessions/session-id/messages";

test("web proxy reserves the long timeout for agent chat turn posts", () => {
  assert.equal(
    controlRequestTimeout("POST", chatPath),
    agentChatControlRequestTimeoutMs,
  );
  assert.equal(
    controlRequestTimeout("GET", chatPath),
    ordinaryControlRequestTimeoutMs,
  );
  assert.equal(
    controlRequestTimeout("POST", "/v1/workspaces/workspace-id/open"),
    ordinaryControlRequestTimeoutMs,
  );
  assert.equal(
    controlRequestTimeout("POST", `${chatPath}/unexpected`),
    ordinaryControlRequestTimeoutMs,
  );
});
