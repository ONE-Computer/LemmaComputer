import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileWorkspaceInventory,
  replaceWorkspaceInInventory,
} from "../apps/web/src/workspace-inventory.js";

test("workspace refreshes preserve established card positions when provider responses reorder records", () => {
  const personal = { id: "workspace-personal", state: "ready" };
  const research = { id: "workspace-research", state: "ready" };

  const refreshed = reconcileWorkspaceInventory(
    [personal, research],
    [{ ...research, state: "open" }, { ...personal, state: "open" }],
  );

  assert.deepEqual(refreshed, [{ ...personal, state: "open" }, { ...research, state: "open" }]);
});

test("workspace actions replace a card in place and prepend only newly created workspaces", () => {
  const personal = { id: "workspace-personal", state: "ready" };
  const research = { id: "workspace-research", state: "ready" };

  assert.deepEqual(
    replaceWorkspaceInInventory([personal, research], { ...research, state: "restarting" }),
    [personal, { ...research, state: "restarting" }],
  );
  assert.deepEqual(
    replaceWorkspaceInInventory([personal, research], { id: "workspace-new", state: "provisioning" }),
    [{ id: "workspace-new", state: "provisioning" }, personal, research],
  );
});
