import assert from "node:assert/strict";
import test from "node:test";
import {
  agentInstanceCleanupStatuses,
  agentInstanceEndReasons,
  agentInstanceIdentityState,
  agentInstanceStatuses,
} from "@lemmacomputer/workspace-store";

test("agent-instance lifecycle values and historical identity state are bounded", () => {
  assert.deepEqual(agentInstanceStatuses, ["starting", "running", "ended"]);
  assert.deepEqual(agentInstanceEndReasons, [
    "process_exited",
    "workspace_restarted",
    "workspace_stopped",
    "workspace_terminated",
    "launch_failed",
    "provider_failed",
    "reconciled_abandoned",
  ]);
  assert.deepEqual(agentInstanceCleanupStatuses, ["not_required", "pending", "confirmed", "incomplete"]);

  const id = crypto.randomUUID();
  assert.deepEqual(agentInstanceIdentityState(id), {
    state: "verified",
    agentInstanceId: id,
  });
  assert.deepEqual(agentInstanceIdentityState(null), {
    state: "legacy_no_instance",
    agentInstanceId: null,
  });
  assert.deepEqual(agentInstanceIdentityState(undefined), {
    state: "legacy_no_instance",
    agentInstanceId: null,
  });
});
