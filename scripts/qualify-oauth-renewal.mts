import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { IdentityContext, RuntimePolicy } from "@lemmacomputer/contracts";
import { LiteLLMGatewayAdapter, type OAuthConnectionGateway } from "@lemmacomputer/litellm-adapter";
import { MemoryConnectorRegistryStore, type SaveConnectorRegistryRecord } from "@lemmacomputer/workspace-store";
import { McpConnectionService } from "../apps/control-api/src/connections.js";

type FixtureCounters = {
  oauthToolsList: number;
  oauthToolCall: number;
  oauthTokenRefresh: number;
  oauthCredentialFingerprints: string[];
};

const serverName = "lemmacomputer_oauth_fixture";
const refreshLifetimeMs = 66_000;

const waitForRefreshExpiry = async () => {
  // Keep every individual wait at or below one minute while allowing the
  // 65-second fixture credential to expire deterministically.
  await delay(60_000);
  await delay(refreshLifetimeMs - 60_000);
};
const availablePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("Could not reserve an OAuth qualification port"));
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const waitFor = async (url: string, label: string) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // The isolated Compose stack is still starting.
    }
    await delay(500);
  }
  throw new Error(`${label} did not become ready`);
};

const readCounters = async (fixtureUrl: string): Promise<FixtureCounters> => {
  const response = await fetch(`${fixtureUrl}/counters`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("OAuth fixture counters are unavailable");
  const value = await response.json() as Partial<FixtureCounters>;
  if (
    typeof value.oauthToolsList !== "number"
    || typeof value.oauthToolCall !== "number"
    || typeof value.oauthTokenRefresh !== "number"
    || !Array.isArray(value.oauthCredentialFingerprints)
  ) throw new Error("OAuth fixture returned invalid counters");
  return value as FixtureCounters;
};

const credentialSuffix = (code: string) => createHash("sha256").update(code).digest("hex").slice(0, 24);
const parseConnectionTimestamp = (value: string | null) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const tokenMarkers = (code: string) => {
  const suffix = credentialSuffix(code);
  const refresh = `${code.startsWith("revoked-") ? "ocq-revoked" : "ocq-refresh"}-${suffix}`;
  return [
    `ocq-expired-${suffix}`,
    refresh,
    `ocq-refreshed-${createHash("sha256").update(refresh).digest("hex").slice(0, 24)}`,
  ];
};

class QualificationRegistry extends MemoryConnectorRegistryStore {
  override async seedConnectors(_tenantId: string, _connectors: SaveConnectorRegistryRecord[]) {}
}

const policyFor = (agentId: string): RuntimePolicy => ({
  schemaVersion: 1,
  policyVersionId: "oauth-qualification",
  policyVersion: 1,
  policyHash: createHash("sha256").update(`oauth-qualification:${agentId}`).digest("hex"),
  workspaceProfile: "claude-desktop-standard-v1",
  executionMode: "managed",
  egressMode: "restricted",
  agentId,
  agentProfile: "claude-desktop-managed-v1",
  networkProfile: "controlled-egress-v1",
  modelAlias: "lemmacomputer-assistant",
  mcpServer: "lemmacomputer_ms365",
  allowedTools: ["list-mail-messages"],
  toolPolicies: { "list-mail-messages": "allow" },
});

const main = async () => {
  const runId = randomBytes(8).toString("hex");
  const [litellmPort, fixturePort] = await Promise.all([availablePort(), availablePort()]);
  const project = `lemmacomputer-oauth-${process.pid}-${runId}`;
  const masterKey = `sk-oauth-${randomBytes(24).toString("base64url")}`;
  const credentialSecret = randomBytes(32).toString("base64url");
  const environment = {
    ...process.env,
    LEMMACOMPUTER_OAUTH_QUALIFICATION_PROJECT: project,
    LEMMACOMPUTER_OAUTH_QUALIFICATION_POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
    LEMMACOMPUTER_OAUTH_QUALIFICATION_MASTER_KEY: masterKey,
    LEMMACOMPUTER_OAUTH_QUALIFICATION_SALT_KEY: randomBytes(32).toString("hex"),
    LEMMACOMPUTER_OAUTH_QUALIFICATION_LITELLM_PORT: String(litellmPort),
    LEMMACOMPUTER_OAUTH_QUALIFICATION_FIXTURE_PORT: String(fixturePort),
  };
  const compose = (args: string[]) => {
    const result = spawnSync("docker", [
      "compose",
      "--project-name", project,
      "--file", "compose.oauth-qualification.yaml",
      ...args,
    ], { cwd: process.cwd(), encoding: "utf8", env: environment });
    if (result.status !== 0) throw new Error(`OAuth qualification Docker command failed: ${args[0] ?? "compose"}`);
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  };
  const litellmUrl = `http://127.0.0.1:${litellmPort}`;
  const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
  const adapter = new LiteLLMGatewayAdapter({
    adminUrl: litellmUrl,
    workspaceUrl: litellmUrl,
    masterKey,
    credentialSecret,
  });
  const connectionGatewayCalls = { statuses: 0, safeDiscoveries: 0 };
  const connectionGateway: OAuthConnectionGateway = {
    beginUserOAuthConnection: (input) => adapter.beginUserOAuthConnection(input),
    completeUserOAuthConnection: (input) => adapter.completeUserOAuthConnection(input),
    userOAuthConnectionStatus: (identity, configuredServerName) => {
      connectionGatewayCalls.statuses += 1;
      return adapter.userOAuthConnectionStatus(identity, configuredServerName);
    },
    disconnectUserOAuthConnection: (identity, configuredServerName) => adapter.disconnectUserOAuthConnection(identity, configuredServerName),
    userOAuthConnectionTools: (identity, configuredServerName) => {
      connectionGatewayCalls.safeDiscoveries += 1;
      return adapter.userOAuthConnectionTools(identity, configuredServerName);
    },
  };

  const registry = new QualificationRegistry();
  const connectionService = new McpConnectionService(connectionGateway, {
    publicWebUrl: "http://127.0.0.1:4174",
    authorizationOrigin: fixtureUrl,
    registry,
  });
  const alpha: IdentityContext = { tenantId: `tenant-${runId}`, subjectId: "alpha", audience: "lemmacomputer-control" };
  const beta: IdentityContext = { tenantId: `tenant-${runId}`, subjectId: "beta", audience: "lemmacomputer-control" };
  const failure: IdentityContext = { tenantId: `tenant-${runId}`, subjectId: "failure", audience: "lemmacomputer-control" };
  const revoked: IdentityContext = { tenantId: `tenant-${runId}`, subjectId: "revoked", audience: "lemmacomputer-control" };
  await registry.saveConnector({
    tenantId: alpha.tenantId,
    id: "oauth-qualification",
    serverId: serverName,
    serverName,
    name: "OAuth qualification",
    shortDescription: "Verify safe credential renewal.",
    description: "Isolated connector used only by the pinned LiteLLM OAuth qualification.",
    category: "Other",
    services: ["Qualification"],
    endpointUrl: `${fixtureUrl}/oauth-mcp`,
    authorizationOrigins: [fixtureUrl],
    scopes: ["fixture.read"],
    brand: "fixture",
    policySupport: "automatic",
    source: "custom",
    createdBy: "oauth-qualification",
  });
  const alphaCode = `alpha-${randomBytes(18).toString("hex")}`;
  const betaCode = `beta-${randomBytes(18).toString("hex")}`;
  const failureCode = `controlled-revocation-${randomBytes(18).toString("hex")}`;
  const revokedCode = `revoked-${randomBytes(18).toString("hex")}`;
  let attempted = false;

  const connectExpired = async (identity: IdentityContext, code: string) => {
    const status = await adapter.completeUserOAuthConnection({
      identity,
      serverName,
      code,
      codeVerifier: randomBytes(48).toString("base64url"),
    });
    assert.equal(status.state, "expired", "the qualification provider must issue an expired access token");
    await registry.saveConnectionState({
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      connectorId: "oauth-qualification",
      state: status.state,
      connectedAt: parseConnectionTimestamp(status.connectedAt),
      expiresAt: parseConnectionTimestamp(status.expiresAt),
    });
  };
  const serviceStatus = (identity: IdentityContext) => connectionService.status(identity, "oauth-qualification");
  const safeCall = async (identity: IdentityContext) => {
    const result = await adapter.executeGovernedTool({
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      workspaceId: randomUUID(),
      accessGeneration: 1,
      operationId: randomUUID(),
      operationDigest: "0".repeat(64),
      leaseId: randomUUID(),
      serverName,
      toolName: "credential_identity",
      arguments: {},
    });
    const value = JSON.parse(result.resultSummary) as { credentialFingerprint?: unknown };
    assert.equal(typeof value.credentialFingerprint, "string");
    assert.match(value.credentialFingerprint, /^[a-f0-9]{16}$/);
    return value.credentialFingerprint;
  };

  try {
    attempted = true;
    compose(["up", "-d", "--build", "--wait", "--wait-timeout", "300"]);
    await waitFor(`${litellmUrl}/health/liveliness`, "LiteLLM");
    await waitFor(`${fixtureUrl}/healthz`, "OAuth fixture");

    await connectExpired(alpha, alphaCode);
    const alphaBeforeRenewal = await readCounters(fixtureUrl);
    const alphaStatusReadsBeforeRenewal = connectionGatewayCalls.statuses;
    const alphaDiscoveriesBeforeRenewal = connectionGatewayCalls.safeDiscoveries;
    const [alphaFirstStatus, alphaSecondStatus] = await Promise.all([serviceStatus(alpha), serviceStatus(alpha)]);
    assert.equal(alphaFirstStatus.state, "connected", "an expired connector must become connected after safe renewal");
    assert.equal(alphaSecondStatus.state, "connected", "concurrent status readers must share the refreshed state");
    assert.equal(connectionGatewayCalls.statuses - alphaStatusReadsBeforeRenewal, 2, "concurrent readers must share the initial and refreshed status reads");
    assert.equal(connectionGatewayCalls.safeDiscoveries - alphaDiscoveriesBeforeRenewal, 1, "concurrent readers must make one safe discovery through Control");
    let counters = await readCounters(fixtureUrl);
    assert.equal(counters.oauthTokenRefresh - alphaBeforeRenewal.oauthTokenRefresh, 1, "one expired stored credential must make exactly one refresh request");
    assert.ok(counters.oauthToolsList - alphaBeforeRenewal.oauthToolsList >= 1, "safe discovery must reach the isolated connector");
    assert.equal(counters.oauthToolCall, alphaBeforeRenewal.oauthToolCall, "silent renewal must not execute an MCP tool");
    const alphaFingerprint = await safeCall(alpha);
    counters = await readCounters(fixtureUrl);
    assert.equal(counters.oauthTokenRefresh - alphaBeforeRenewal.oauthTokenRefresh, 1, "the post-renewal safe tool call must not trigger another refresh request");

    // Discovery is not authorization. The production connector boundary
    // deliberately withholds newly discovered or changed tools until an
    // administrator reviews their current definitions. Qualify that boundary
    // explicitly before later assertions expect this fixture to be projected.
    const fixtureReview = await connectionService.connectorToolPolicy(alpha, "oauth-qualification");
    assert.deepEqual(fixtureReview.changes.added, ["credential_identity", "credential_secondary"]);
    assert.ok(fixtureReview.tools.every((tool) => tool.reviewRequired && tool.decision === "deny"));
    await connectionService.saveConnectorToolPolicy(
      alpha,
      "oauth-qualification",
      Object.fromEntries(fixtureReview.tools.map((tool) => [tool.name, "allow" as const])),
      fixtureReview.documentHash,
    );

    await connectExpired(beta, betaCode);
    const betaBeforeRenewal = await readCounters(fixtureUrl);
    const betaStatus = await serviceStatus(beta);
    assert.equal(betaStatus.state, "connected", "a second identity must renew its own credential");
    counters = await readCounters(fixtureUrl);
    assert.equal(counters.oauthTokenRefresh - betaBeforeRenewal.oauthTokenRefresh, 1, "each identity must make exactly one refresh request for its own credential");
    const betaFingerprint = await safeCall(beta);
    counters = await readCounters(fixtureUrl);
    assert.equal(counters.oauthTokenRefresh - betaBeforeRenewal.oauthTokenRefresh, 1, "the second identity's post-renewal safe tool call must not trigger another refresh request");
    assert.notEqual(alphaFingerprint, betaFingerprint, "one user must not receive another user's OAuth credential");

    const refreshesBeforeRestart = (await readCounters(fixtureUrl)).oauthTokenRefresh;
    compose(["restart", "litellm"]);
    await waitFor(`${litellmUrl}/health/liveliness`, "restarted LiteLLM");
    await waitForRefreshExpiry();
    const restartedStatus = await serviceStatus(alpha);
    assert.equal(restartedStatus.state, "connected", "the persisted connection must silently renew after a LiteLLM restart");
    counters = await readCounters(fixtureUrl);
    assert.equal(counters.oauthTokenRefresh - refreshesBeforeRestart, 1, "the persisted connection must make exactly one refresh request after LiteLLM restarts");
    await safeCall(alpha);
    counters = await readCounters(fixtureUrl);
    assert.equal(counters.oauthTokenRefresh - refreshesBeforeRestart, 1, "the persisted connection's post-restart safe tool call must not trigger another refresh request");

    await connectExpired(failure, failureCode);
    const failureBeforeRenewal = await readCounters(fixtureUrl);
    const failureStatus = await serviceStatus(failure);
    assert.equal(failureStatus.state, "connected", "the controlled fixture credential must initially renew");
    counters = await readCounters(fixtureUrl);
    assert.equal(counters.oauthTokenRefresh - failureBeforeRenewal.oauthTokenRefresh, 1, "the controlled fixture credential must make exactly one refresh request before revocation");
    const failurePolicy = policyFor("agent-failure");
    const initialFailureProjection = await connectionService.projectConnectedConnectors(failure, failurePolicy);
    assert.deepEqual(initialFailureProjection.mcpServers, ["lemmacomputer_ms365", serverName]);
    assert.deepEqual(initialFailureProjection.mcpToolPermissions?.[serverName], ["credential_identity", "credential_secondary"]);
    const revokeResponse = await fetch(`${fixtureUrl}/oauth/qualification/revoke/${credentialSuffix(failureCode)}`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(revokeResponse.ok, true, "the fixture must accept hash-only credential revocation");
    await revokeResponse.body?.cancel().catch(() => undefined);
    const failureBeforeRevocation = await readCounters(fixtureUrl);
    await waitForRefreshExpiry();
    const toolCallsBeforeFailure = failureBeforeRevocation.oauthToolCall;
    const failedProjection = await connectionService.projectConnectedConnectors(failure, failurePolicy);
    assert.deepEqual(failedProjection.mcpServers, ["lemmacomputer_ms365"], "a failed silent renewal must remove the cached connector server");
    assert.equal(failedProjection.mcpToolPermissions?.[serverName], undefined, "a failed silent renewal must remove cached connector tools");
    counters = await readCounters(fixtureUrl);
    assert.ok(counters.oauthTokenRefresh - failureBeforeRevocation.oauthTokenRefresh >= 1, "the provider-revoked credential must attempt a failed refresh; LiteLLM may retry a denied resolution");
    assert.equal(counters.oauthToolCall, toolCallsBeforeFailure, "a denied refresh must not reach an upstream MCP tool");

    await connectExpired(revoked, revokedCode);
    const revokedBeforeRenewal = await readCounters(fixtureUrl);
    const revokedStatus = await serviceStatus(revoked);
    assert.equal(revokedStatus.state, "expired", "a denied refresh must expose a reconnect-required state");
    counters = await readCounters(fixtureUrl);
    assert.ok(counters.oauthTokenRefresh - revokedBeforeRenewal.oauthTokenRefresh >= 1, "the initially revoked credential must attempt a failed refresh; LiteLLM may retry a denied resolution");
    assert.equal(counters.oauthToolCall, toolCallsBeforeFailure, "a denied refresh must not reach an upstream MCP tool");

    const markers = [alphaCode, betaCode, failureCode, revokedCode, ...tokenMarkers(alphaCode), ...tokenMarkers(betaCode), ...tokenMarkers(failureCode), ...tokenMarkers(revokedCode)];
    const logs = compose(["logs", "--no-color"]);
    const database = compose(["exec", "-T", "litellm-postgres", "pg_dump", "-U", "litellm", "--data-only", "--inserts", "litellm"]);
    for (const marker of markers) {
      assert.equal(logs.includes(marker), false, "OAuth token material appeared in container logs");
      assert.equal(database.includes(marker), false, "OAuth token material appeared unencrypted in PostgreSQL");
      assert.equal(JSON.stringify(counters).includes(marker), false, "OAuth token material appeared in fixture counters");
    }
    process.stdout.write("Pinned LiteLLM OAuth renewal qualification passed.\n");
  } finally {
    if (attempted) {
      try {
        compose(["down", "--volumes", "--remove-orphans"]);
      } catch {
        process.stderr.write("OAuth qualification teardown failed for its isolated Compose project.\n");
      }
    }
  }
};

await main();
