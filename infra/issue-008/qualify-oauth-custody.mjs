import { createHash, createHmac } from "node:crypto";

const baseUrl = (process.env.LITELLM_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const masterKey = process.env.ONECOMPUTER_LITELLM_MASTER_KEY;
const qualificationSecret = process.env.ONECOMPUTER_LITELLM_CREDENTIAL_SECRET;
const phase = process.argv[2] ?? "setup";

if (!masterKey || !qualificationSecret) {
  throw new Error("Set ONECOMPUTER_LITELLM_MASTER_KEY and ONECOMPUTER_LITELLM_CREDENTIAL_SECRET");
}

const derive = (label) => createHmac("sha256", qualificationSecret).update(`issue-008:${label}`).digest("base64url");
const fingerprint = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);

const users = {
  alpha: `oc-qualification-user-${derive("user-alpha")}`,
  beta: `oc-qualification-user-${derive("user-beta")}`,
};
const agents = {
  alphaResearch: `oc-qualification-agent-${derive("agent-alpha-research")}`,
  alphaCalendar: `oc-qualification-agent-${derive("agent-alpha-calendar")}`,
  betaResearch: `oc-qualification-agent-${derive("agent-beta-research")}`,
};
const keys = {
  alphaResearch: `sk-ocq-${derive("key-alpha-research")}`,
  alphaCalendar: `sk-ocq-${derive("key-alpha-calendar")}`,
  betaResearch: `sk-ocq-${derive("key-beta-research")}`,
  alphaConnection: `sk-ocq-${derive("key-alpha-connection")}`,
  betaConnection: `sk-ocq-${derive("key-beta-connection")}`,
};
const credentials = {
  alpha: `ocq-oauth-${derive("oauth-alpha")}`,
  beta: `ocq-oauth-${derive("oauth-beta")}`,
};

const call = async (path, key, { method = "GET", body } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { text }; }
  return { ok: response.ok, status: response.status, payload };
};

const expectOk = (result, label) => {
  if (!result.ok) throw new Error(`${label} failed with ${result.status}: ${JSON.stringify(result.payload)}`);
  return result.payload;
};

const generateKey = async ({ key, userId, agentId, tool, alias }) => {
  const result = await call("/key/generate", masterKey, {
    method: "POST",
    body: {
      key,
      key_alias: alias,
      key_type: "llm_api",
      user_id: userId,
      agent_id: agentId,
      models: [],
      rpm_limit: 30,
      metadata: {
        onecomputer_tenant_id: "qualification-tenant",
        onecomputer_subject_id: userId,
        onecomputer_agent_id: agentId,
        onecomputer_workspace_id: "qualification-workspace",
        qualification_only: true,
      },
      object_permission: {
        mcp_servers: ["onecomputer_oauth_fixture"],
        mcp_tool_permissions: { onecomputer_oauth_fixture: [tool] },
      },
    },
  });
  expectOk(result, `generate ${alias}`);
};

const generateConnectionKey = async ({ key, userId, alias, serverId }) => {
  const credentialRoute = `/v1/mcp/server/${serverId}/oauth-user-credential`;
  const result = await call("/key/generate", masterKey, {
    method: "POST",
    body: {
      key,
      key_alias: alias,
      key_type: "default",
      user_id: userId,
      models: [],
      rpm_limit: 10,
      allowed_routes: [credentialRoute],
      metadata: {
        onecomputer_tenant_id: "qualification-tenant",
        onecomputer_subject_id: userId,
        onecomputer_connection_credential: true,
        qualification_only: true,
      },
      object_permission: { mcp_servers: ["onecomputer_oauth_fixture"] },
    },
  });
  expectOk(result, `generate ${alias}`);
};

const listTools = async (key) => expectOk(await call("/mcp-rest/tools/list", key), "list tools").tools ?? [];

const serverIdFrom = (tools) => {
  const serverId = tools.map((tool) => tool?.mcp_info?.server_id).find((value) => typeof value === "string" && value.length > 0);
  if (!serverId) throw new Error("OAuth fixture server id was absent from scoped discovery");
  return serverId;
};

const getFixtureServerId = async () => {
  const servers = expectOk(await call("/v1/mcp/server", masterKey), "list MCP servers");
  const serverId = Array.isArray(servers)
    ? servers.find((server) => server?.server_name === "onecomputer_oauth_fixture")?.server_id
    : undefined;
  if (typeof serverId !== "string" || !serverId) throw new Error("OAuth fixture server is not registered");
  return serverId;
};

const storeCredential = async (key, serverId, accessToken, { expiresIn = 86_400, refreshToken } = {}) => {
  expectOk(await call(`/v1/mcp/server/${encodeURIComponent(serverId)}/oauth-user-credential`, key, {
    method: "POST",
    body: {
      access_token: accessToken,
      expires_in: expiresIn,
      scopes: ["fixture.read"],
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    },
  }), "store user OAuth credential");
};

const deleteCredential = async (key, serverId) => {
  const result = await call(`/v1/mcp/server/${encodeURIComponent(serverId)}/oauth-user-credential`, key, { method: "DELETE" });
  if (!result.ok && result.status !== 404) throw new Error(`delete credential failed with ${result.status}: ${JSON.stringify(result.payload)}`);
};

const callIdentity = async (key, serverId, tool) => {
  const result = await call("/mcp-rest/tools/call", key, {
    method: "POST",
    body: { server_id: serverId, name: tool, arguments: {} },
  });
  if (!result.ok) return { ok: false, status: result.status };
  const content = Array.isArray(result.payload?.content) ? result.payload.content : [];
  const text = content.find((item) => item?.type === "text")?.text;
  const parsed = typeof text === "string" ? JSON.parse(text) : {};
  return { ok: true, status: result.status, credentialFingerprint: parsed.credentialFingerprint };
};

const assertToolSet = (tools, expected) => {
  const names = tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expected].sort())) {
    throw new Error(`unexpected scoped tools: ${JSON.stringify(names)}`);
  }
};

const verifyCalls = async (serverId) => {
  const alphaResearch = await callIdentity(keys.alphaResearch, serverId, "credential_identity");
  const alphaCalendar = await callIdentity(keys.alphaCalendar, serverId, "credential_secondary");
  const betaResearch = await callIdentity(keys.betaResearch, serverId, "credential_identity");
  const alphaResearchForbidden = await callIdentity(keys.alphaResearch, serverId, "credential_secondary");
  const alphaCalendarForbidden = await callIdentity(keys.alphaCalendar, serverId, "credential_identity");
  if (!alphaResearch.ok || alphaResearch.credentialFingerprint !== fingerprint(credentials.alpha)) throw new Error("alpha research resolved the wrong credential");
  if (!alphaCalendar.ok || alphaCalendar.credentialFingerprint !== fingerprint(credentials.alpha)) throw new Error("alpha calendar did not share alpha's credential");
  if (!betaResearch.ok || betaResearch.credentialFingerprint !== fingerprint(credentials.beta)) throw new Error("beta research resolved the wrong credential");
  if (alphaResearchForbidden.ok || alphaCalendarForbidden.ok) throw new Error("one agent used another agent's tool assignment");
  return {
    alphaAgentsShareCredential: alphaResearch.credentialFingerprint === alphaCalendar.credentialFingerprint,
    usersRemainIsolated: alphaResearch.credentialFingerprint !== betaResearch.credentialFingerprint,
    agentToolPoliciesRemainIsolated: true,
    fingerprints: { alpha: alphaResearch.credentialFingerprint, beta: betaResearch.credentialFingerprint },
  };
};

if (phase === "setup") {
  const serverId = await getFixtureServerId();
  await call("/key/delete", masterKey, { method: "POST", body: { keys: Object.values(keys) } });
  await generateKey({ key: keys.alphaResearch, userId: users.alpha, agentId: agents.alphaResearch, tool: "credential_identity", alias: "issue-008-alpha-research" });
  await generateKey({ key: keys.alphaCalendar, userId: users.alpha, agentId: agents.alphaCalendar, tool: "credential_secondary", alias: "issue-008-alpha-calendar" });
  await generateKey({ key: keys.betaResearch, userId: users.beta, agentId: agents.betaResearch, tool: "credential_identity", alias: "issue-008-beta-research" });
  await generateConnectionKey({ key: keys.alphaConnection, userId: users.alpha, alias: "issue-008-alpha-connection", serverId });
  await generateConnectionKey({ key: keys.betaConnection, userId: users.beta, alias: "issue-008-beta-connection", serverId });

  await deleteCredential(keys.alphaConnection, serverId);
  await deleteCredential(keys.betaConnection, serverId);
  const betaBeforeCredential = await callIdentity(keys.betaResearch, serverId, "credential_identity");
  if (betaBeforeCredential.ok) throw new Error("user without a credential reached the OAuth fixture");

  const agentCredentialWrite = await call(`/v1/mcp/server/${encodeURIComponent(serverId)}/oauth-user-credential`, keys.alphaResearch, {
    method: "POST",
    body: { access_token: credentials.alpha, expires_in: 86_400, scopes: ["fixture.read"] },
  });
  if (agentCredentialWrite.ok || agentCredentialWrite.status !== 403) throw new Error("agent key was allowed to manage OAuth credentials");
  await storeCredential(keys.alphaConnection, serverId, credentials.alpha);
  await storeCredential(keys.betaConnection, serverId, credentials.beta);
  const alphaResearchTools = await listTools(keys.alphaResearch);
  const alphaCalendarTools = await listTools(keys.alphaCalendar);
  const betaResearchTools = await listTools(keys.betaResearch);
  assertToolSet(alphaResearchTools, ["credential_identity"]);
  assertToolSet(alphaCalendarTools, ["credential_secondary"]);
  assertToolSet(betaResearchTools, ["credential_identity"]);
  if (serverIdFrom(alphaResearchTools) !== serverId) throw new Error("scoped discovery returned the wrong server");
  const verified = await verifyCalls(serverId);
  process.stdout.write(`${JSON.stringify({ phase, scopedTools: true, missingCredentialDenied: true, agentCredentialManagementDenied: true, ...verified })}\n`);
} else if (phase === "verify-persisted") {
  const tools = await listTools(keys.alphaResearch);
  const serverId = serverIdFrom(tools);
  const verified = await verifyCalls(serverId);
  process.stdout.write(`${JSON.stringify({ phase, keysPersisted: true, credentialsPersisted: true, ...verified })}\n`);
} else if (phase === "expiry-refresh") {
  const tools = await listTools(keys.alphaResearch);
  const serverId = serverIdFrom(tools);
  await storeCredential(keys.alphaConnection, serverId, credentials.alpha, { expiresIn: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const expired = await callIdentity(keys.alphaResearch, serverId, "credential_identity");
  if (expired.ok) throw new Error("expired credential without refresh token remained usable");
  const betaAfterAlphaExpiry = await callIdentity(keys.betaResearch, serverId, "credential_identity");
  if (!betaAfterAlphaExpiry.ok || betaAfterAlphaExpiry.credentialFingerprint !== fingerprint(credentials.beta)) {
    throw new Error("alpha expiry affected beta's credential");
  }

  const refreshToken = `ocq-refresh-${derive("refresh-alpha")}`;
  await storeCredential(keys.alphaConnection, serverId, credentials.alpha, { expiresIn: 1, refreshToken });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const refreshed = await callIdentity(keys.alphaResearch, serverId, "credential_identity");
  const refreshedAccessToken = `ocq-refreshed-${createHash("sha256").update(refreshToken).digest("hex").slice(0, 24)}`;
  if (!refreshed.ok || refreshed.credentialFingerprint !== fingerprint(refreshedAccessToken)) {
    throw new Error("expired credential did not refresh through the configured token endpoint");
  }
  await storeCredential(keys.alphaConnection, serverId, credentials.alpha);
  process.stdout.write(`${JSON.stringify({ phase, expiredWithoutRefreshDenied: true, refreshSucceeded: true, otherUserUnaffected: true })}\n`);
} else if (phase === "revoke") {
  const tools = await listTools(keys.alphaResearch);
  const serverId = serverIdFrom(tools);
  await deleteCredential(keys.alphaConnection, serverId);
  const alphaResearch = await callIdentity(keys.alphaResearch, serverId, "credential_identity");
  const alphaCalendar = await callIdentity(keys.alphaCalendar, serverId, "credential_secondary");
  const betaResearch = await callIdentity(keys.betaResearch, serverId, "credential_identity");
  if (alphaResearch.ok || alphaCalendar.ok) throw new Error("revoked user credential remained usable");
  if (!betaResearch.ok || betaResearch.credentialFingerprint !== fingerprint(credentials.beta)) throw new Error("revoking alpha affected beta");
  await deleteCredential(keys.betaConnection, serverId);
  expectOk(await call("/key/delete", masterKey, { method: "POST", body: { keys: Object.values(keys) } }), "delete qualification keys");
  const deletedKey = await call("/mcp-rest/tools/list", keys.alphaResearch);
  if (deletedKey.ok) throw new Error("deleted agent key remained usable");
  process.stdout.write(`${JSON.stringify({ phase, userRevocationIsolated: true, allAgentKeysRevoked: true })}\n`);
} else {
  throw new Error(`Unknown phase ${phase}`);
}
