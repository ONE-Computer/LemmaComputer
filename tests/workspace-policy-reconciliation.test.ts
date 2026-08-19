import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxSettingsRecord } from "@lemmacomputer/workspace-store";
import { compatibleSandboxSelection } from "../apps/control-api/src/server.js";

const document = {
  workspaceProfile: "claude-desktop-standard-v1",
  workspaceProfiles: ["claude-desktop-standard-v1"],
  applications: ["firefox", "google-chrome"],
  defaultApplications: ["firefox"],
  agents: ["claude-desktop", "hermes-desktop", "hermes-claw"],
  defaultAgents: ["claude-desktop"],
  modelAliases: ["lemmacomputer-claude"],
  serviceClasses: ["lite", "balanced", "pro"],
  defaultServiceClass: "balanced",
};

const saved = (agentIds: SandboxSettingsRecord["agentIds"]): SandboxSettingsRecord => ({
  tenantId: "acme",
  subjectId: "member",
  grantId: "personal",
  profileId: "claude-desktop-standard-v1",
  applicationIds: ["firefox", "google-chrome"],
  modelAlias: "lemmacomputer-claude",
  requestedServiceClass: "balanced",
  agentIds,
  updatedAt: new Date("2026-08-15T00:00:00.000Z"),
});

test("a removed agent is reconciled to the still-allowed saved selection", () => {
  const selection = compatibleSandboxSelection(document, saved(["claude-desktop", "claude-cli"]), null);

  assert.deepEqual(selection, {
    profileId: "claude-desktop-standard-v1",
    applicationIds: ["firefox", "google-chrome"],
    modelAlias: "lemmacomputer-claude",
    requestedServiceClass: "balanced",
    agentIds: ["claude-desktop"],
    changed: true,
  });
});

test("a workspace whose only selected agent was removed reconciles to the safer base workspace", () => {
  assert.deepEqual(compatibleSandboxSelection(document, saved(["claude-cli"]), null), {
    profileId: "claude-desktop-standard-v1",
    applicationIds: ["firefox", "google-chrome"],
    modelAlias: null,
    requestedServiceClass: "balanced",
    agentIds: [],
    changed: true,
  });
});

test("a legacy workspace without saved sandbox settings adopts the constrained policy defaults", () => {
  assert.deepEqual(compatibleSandboxSelection(document, null, null), {
    profileId: "claude-desktop-standard-v1",
    applicationIds: ["firefox"],
    modelAlias: "lemmacomputer-claude",
    requestedServiceClass: "balanced",
    agentIds: ["claude-desktop"],
    changed: false,
  });
});

test("legacy saved settings without a service class adopt the constrained policy default", () => {
  const legacy = saved(["claude-desktop"]);
  delete (legacy as Partial<SandboxSettingsRecord>).requestedServiceClass;

  assert.equal(compatibleSandboxSelection(document, legacy, null)?.requestedServiceClass, "balanced");
});

test("published organization routes constrain new and saved workspace selections", () => {
  assert.deepEqual(compatibleSandboxSelection(document, null, ["lite", "pro"]), {
    profileId: "claude-desktop-standard-v1",
    applicationIds: ["firefox"],
    modelAlias: "lemmacomputer-auto",
    requestedServiceClass: "lite",
    agentIds: ["claude-desktop"],
    changed: false,
  });
  assert.equal(compatibleSandboxSelection(document, saved(["claude-desktop"]), ["lite", "pro"]), null);
});
