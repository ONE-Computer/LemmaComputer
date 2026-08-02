import assert from "node:assert/strict";
import test from "node:test";
import { MemoryConnectorRegistryStore, type SaveConnectorRegistryRecord } from "@onecomputer/workspace-store";

const connector = (
  tenantId: string,
  id: string,
  overrides: Partial<SaveConnectorRegistryRecord> = {},
): SaveConnectorRegistryRecord => ({
  tenantId,
  id,
  serverId: `server-${tenantId}-${id}`,
  serverName: `onecomputer_${tenantId}_${id}`,
  name: id,
  shortDescription: `${id} connector`,
  description: `${id} connector for tests`,
  category: "Developer tools",
  services: [],
  endpointUrl: `https://mcp.${id}.example/mcp`,
  authorizationOrigins: [`https://auth.${id}.example`],
  scopes: [],
  brand: "generic",
  policySupport: "automatic",
  source: "custom",
  createdBy: "administrator",
  ...overrides,
});

test("connector review hashes are atomic and temporary egress permits are tenant-scoped", async () => {
  const store = new MemoryConnectorRegistryStore();
  await store.saveConnector(connector("tenant-a", "alpha", {
    toolPolicies: { legacy_tool: "allow" },
  }));
  await store.saveConnector(connector("tenant-b", "beta"));
  await store.saveConnector(connector("tenant-b", "disabled", { enabled: false }));

  const legacy = await store.getConnector("tenant-a", "alpha");
  assert.deepEqual(legacy?.toolPolicies, { legacy_tool: "allow" });
  assert.deepEqual(legacy?.toolDefinitionHashes, {}, "a pre-hash decision stays visibly unreviewed");

  await assert.rejects(
    () => store.updateToolPolicies("tenant-a", "alpha", {
      toolPolicies: { read_issue: "allow" },
      toolDefinitionHashes: {},
    }),
    /matching tool definition hash/,
  );
  assert.deepEqual((await store.getConnector("tenant-a", "alpha"))?.toolPolicies, { legacy_tool: "allow" });

  const hash = "a".repeat(64);
  const reviewed = await store.updateToolPolicies("tenant-a", "alpha", {
    toolPolicies: { read_issue: "approval_required" },
    toolDefinitionHashes: { read_issue: hash },
  });
  assert.deepEqual(reviewed?.toolPolicies, { read_issue: "approval_required" });
  assert.deepEqual(reviewed?.toolDefinitionHashes, { read_issue: hash });
  reviewed!.toolDefinitionHashes.read_issue = "b".repeat(64);
  assert.deepEqual((await store.getConnector("tenant-a", "alpha"))?.toolDefinitionHashes, { read_issue: hash });

  const expiresAt = new Date(Date.now() + 60_000);
  const permit = await store.createDiscoveryEgressPermit({
    tenantId: "tenant-a",
    createdBy: "administrator-a",
    origins: ["https://discovery.alpha.example/", "https://discovery.alpha.example"],
    expiresAt,
  });
  assert.equal(permit.createdBy, "administrator-a");
  assert.equal(await store.deleteDiscoveryEgressPermit("tenant-b", permit.id), false, "one tenant cannot delete another tenant's permit");
  assert.deepEqual(await store.listEnabledEgressOrigins(), [
    "https://auth.alpha.example",
    "https://auth.beta.example",
    "https://discovery.alpha.example",
    "https://mcp.alpha.example",
    "https://mcp.beta.example",
  ]);
  assert.deepEqual(await store.listEnabledEgressOrigins(new Date(expiresAt.getTime() + 1)), [
    "https://auth.alpha.example",
    "https://auth.beta.example",
    "https://mcp.alpha.example",
    "https://mcp.beta.example",
  ], "expired permits are not returned");
  assert.equal(await store.deleteDiscoveryEgressPermit("tenant-a", permit.id), true);
  await assert.rejects(
    () => store.createDiscoveryEgressPermit({
      tenantId: "tenant-a",
      createdBy: "administrator-a",
      origins: ["https://expired.alpha.example"],
      expiresAt: new Date(Date.now() - 1),
    }),
    /expiry must be within ten minutes/,
  );
  await assert.rejects(
    () => store.createDiscoveryEgressPermit({
      tenantId: "tenant-a",
      createdBy: "administrator-a",
      origins: ["https://too-long.alpha.example"],
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000 + 1_000),
    }),
    /expiry must be within ten minutes/,
  );
});
