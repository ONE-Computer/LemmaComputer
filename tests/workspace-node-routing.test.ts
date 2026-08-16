import assert from "node:assert/strict";
import test from "node:test";
import { LemmaComputerError, type Sandbox } from "@lemmacomputer/contracts";
import type { WorkspaceNode } from "@lemmacomputer/workspace-store";
import {
  RoutedControllerClient,
  type ControllerClient,
  type WorkspaceNodeDirectory,
} from "../apps/control-api/src/service.js";
import { usesPlacementRoutedController } from "../apps/control-api/src/server.js";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";

test("placement routing follows remote topology instead of the hosted profile name", () => {
  assert.equal(usesPlacementRoutedController({ installationKind: "hosted", workspaceNodeTopology: "remote" }), true);
  assert.equal(usesPlacementRoutedController({ installationKind: "worktree", workspaceNodeTopology: "remote" }), true);
  assert.equal(usesPlacementRoutedController({ installationKind: "worktree", workspaceNodeTopology: "colocated" }), false);
  assert.equal(usesPlacementRoutedController({ installationKind: "customer-managed", workspaceNodeTopology: "remote" }), false);
});

const node = (id: string): WorkspaceNode => ({
  id,
  endpointUrl: `https://${id}.nodes.internal:4101`,
  tlsServerName: `${id}.nodes.internal`,
  state: "active",
  reason: "Registered for the C-minus routing test",
  createdByOperatorId: "33333333-3333-4333-8333-333333333333",
  updatedByOperatorId: "33333333-3333-4333-8333-333333333333",
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
});

class RecordingController implements ControllerClient {
  readonly calls: string[] = [];
  constructor(private readonly nodeId: string, private readonly receiptNodeId = nodeId) {}
  async create(input: Parameters<ControllerClient["create"]>[0]) {
    this.calls.push(`create:${input.workspaceId}`);
    return { providerId: `${this.nodeId}-sandbox`, state: "ready" } as Sandbox;
  }
  async updateEgressPolicy(providerId: string, input: Parameters<ControllerClient["updateEgressPolicy"]>[1]) {
    this.calls.push(`egress:${input.workspaceId}:${providerId}`);
  }
  async status(workspaceId: string, providerId: string) {
    this.calls.push(`status:${workspaceId}:${providerId}`);
    return { providerId, state: "ready" } as Sandbox;
  }
  async open(workspaceId: string, providerId: string) {
    this.calls.push(`open:${workspaceId}:${providerId}`);
    return { launchUrl: "https://workspace.example.test", expiresAt: "2026-08-16T00:10:00.000Z" };
  }
  async destroyWorkspace(workspaceId: string, providerId: string) {
    this.calls.push(`destroy:${workspaceId}:${providerId}`);
  }
  async purgeWorkspace(workspaceId: string, accessGeneration: number) {
    this.calls.push(`purge:${workspaceId}:${accessGeneration}`);
    return {
      nodeId: this.receiptNodeId,
      workspaceId,
      maximumPurgedGeneration: accessGeneration,
      completedAt: "2026-08-16T00:00:00.000Z",
      verified: true as const,
    };
  }
}

class FixedDirectory implements WorkspaceNodeDirectory {
  readonly placements = new Map<string, WorkspaceNode>([
    [workspaceA, node("workspace-node-a")],
    [workspaceB, node("workspace-node-b")],
  ]);

  async resolveWorkspaceNode(workspaceId: string, expectedWorkspaceNodeId?: string) {
    const placement = this.placements.get(workspaceId);
    if (!placement) {
      throw new LemmaComputerError("WORKSPACE_NODE_PLACEMENT_MISSING", "Workspace node placement is not configured", 503, true);
    }
    if (placement.state === "disabled") {
      throw new LemmaComputerError("WORKSPACE_NODE_DISABLED", "The workspace node is disabled", 503, true);
    }
    if (expectedWorkspaceNodeId && expectedWorkspaceNodeId !== placement.id) {
      throw new LemmaComputerError("WORKSPACE_NODE_PLACEMENT_MISMATCH", "Cleanup placement does not match", 409);
    }
    return placement;
  }
}

test("two workspace nodes receive lifecycle calls only for their persisted workspaces", async () => {
  const directory = new FixedDirectory();
  const clients = new Map<string, RecordingController>();
  const routed = new RoutedControllerClient(directory, (placement) => {
    const client = new RecordingController(placement.id);
    clients.set(placement.id, client);
    return client;
  });

  await routed.create({ workspaceId: workspaceA } as Parameters<ControllerClient["create"]>[0]);
  await routed.status(workspaceA, "sandbox-a");
  await routed.open(workspaceB, "sandbox-b");
  await routed.destroyWorkspace(workspaceA, "sandbox-a", "workspace-node-a");
  await routed.purgeWorkspace(workspaceB, 3, "workspace-node-b");

  assert.deepEqual(clients.get("workspace-node-a")?.calls, [
    `create:${workspaceA}`,
    `status:${workspaceA}:sandbox-a`,
    `destroy:${workspaceA}:sandbox-a`,
  ]);
  assert.deepEqual(clients.get("workspace-node-b")?.calls, [
    `open:${workspaceB}:sandbox-b`,
    `purge:${workspaceB}:3`,
  ]);

  await routed.status(workspaceA, "sandbox-a-again");
  assert.equal(clients.get("workspace-node-a")?.calls.at(-1), `status:${workspaceA}:sandbox-a-again`);
});

test("missing, disabled, or mismatched placement fails closed without contacting a node", async () => {
  const directory = new FixedDirectory();
  let clientsCreated = 0;
  const routed = new RoutedControllerClient(directory, (placement) => {
    clientsCreated += 1;
    return new RecordingController(placement.id);
  });

  await assert.rejects(
    () => routed.status("44444444-4444-4444-8444-444444444444", "sandbox"),
    { code: "WORKSPACE_NODE_PLACEMENT_MISSING" },
  );
  directory.placements.set(workspaceA, { ...node("workspace-node-a"), state: "disabled" });
  await assert.rejects(
    () => routed.open(workspaceA, "sandbox"),
    { code: "WORKSPACE_NODE_DISABLED" },
  );
  directory.placements.set(workspaceA, node("workspace-node-a"));
  await assert.rejects(
    () => routed.destroyWorkspace(workspaceA, "sandbox", "workspace-node-b"),
    { code: "WORKSPACE_NODE_PLACEMENT_MISMATCH" },
  );
  assert.equal(clientsCreated, 0);
});

test("purge receipts from a different node are rejected", async () => {
  const directory = new FixedDirectory();
  const routed = new RoutedControllerClient(
    directory,
    (placement) => new RecordingController(placement.id, "workspace-node-b"),
  );
  await assert.rejects(
    () => routed.purgeWorkspace(workspaceA, 4),
    { code: "WORKSPACE_NODE_RECEIPT_MISMATCH" },
  );
});
