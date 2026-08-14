import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { SandboxAdapter } from "@lemmacomputer/kasm-adapter";
import { LemmaComputerError } from "@lemmacomputer/contracts";
import { createMutualTlsFetch } from "@lemmacomputer/litellm-adapter";
import { HttpControllerClient } from "../apps/control-api/src/service.js";
import { createLiteLlmAdminProxy } from "../apps/litellm-admin-proxy/server.mjs";
import { createControllerServer, MutualTlsNodeRequestAuthenticator } from "../apps/workspace-controller/src/server.js";
import { generateMutualTlsAuthority, type CertificatePair } from "./mtls-fixture.js";
import { policyFixture } from "./policy-fixture.js";

const workspaceId = "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
const providerId = "remote-provider-1";
const controllerToken = "controller-internal-test-token-000001";
const controlCommonName = "lemmacomputer-control";

const runtimePolicy = {
  schemaVersion: 1 as const,
  policyVersionId: "policy-version-internal-mtls",
  policyVersion: 1,
  policyHash: "a".repeat(64),
  workspaceProfile: "kasm-persistent-standard" as const,
  agentId: "agent-alex",
  agentProfile: "lemmacomputer-default-agent" as const,
  networkProfile: "controlled-egress-v1" as const,
  modelAlias: "lemmacomputer-assistant",
  mcpServer: "lemmacomputer_ms365",
  allowedTools: ["list-mail-folders"],
  toolPolicies: { "list-mail-folders": "allow" as const },
};

const adapter: SandboxAdapter = {
  async create() {
    return { providerId, workspaceId, state: "ready", failureCode: null };
  },
  async updateEgressPolicy() {},
  async status(requestedWorkspaceId, requestedProviderId) {
    return { providerId: requestedProviderId, workspaceId: requestedWorkspaceId, state: "ready", failureCode: null };
  },
  async open() {
    return { launchUrl: "https://workspace-node:16920/", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  },
  async destroy() {},
  async purgeWorkspace(requestedWorkspaceId, accessGeneration) {
    return {
      nodeId: "workspace-node-test",
      workspaceId: requestedWorkspaceId,
      maximumPurgedGeneration: accessGeneration,
      completedAt: new Date().toISOString(),
      verified: true,
    };
  },
};

const listen = (server: ReturnType<typeof createHttpServer>) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server: { close(callback: (error?: Error) => void): unknown }) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

const requestWithoutClientIdentity = (input: {
  port: number;
  path: string;
  ca: string;
  serverName: string;
}) => new Promise<void>((resolve, reject) => {
  const request = httpsRequest({
    host: "127.0.0.1",
    port: input.port,
    path: input.path,
    method: "GET",
    ca: input.ca,
    servername: input.serverName,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  }, (response) => {
    response.resume();
    response.once("end", resolve);
  });
  request.once("error", reject);
  request.end();
});

const transportFor = (input: {
  ca: string;
  client: CertificatePair;
  serverName: string;
}) => createMutualTlsFetch({
  ca: input.ca,
  clientCertificate: input.client.certificate,
  clientKey: input.client.key,
  serverName: input.serverName,
});

const rejectedAsHiddenNodeRoute = (error: unknown) => (
  error instanceof LemmaComputerError
  && error.code === "NOT_FOUND"
  && error.statusCode === 404
);

test("all hosted internal mTLS boundaries accept only their intended Control identity", async () => {
  const adminAuthority = await generateMutualTlsAuthority({
    name: "litellm-admin",
    serverName: "litellm-admin-listener",
    clientCommonName: controlCommonName,
  });
  const nodeAuthority = await generateMutualTlsAuthority({
    name: "workspace-node",
    serverName: "workspace-node",
    clientCommonName: controlCommonName,
  });
  assert.notEqual(adminAuthority.ca, nodeAuthority.ca, "the two trust boundaries use different test authorities");
  assert.notEqual(adminAuthority.client.key, nodeAuthority.client.key, "Control uses a distinct leaf key for each trust boundary");

  const adminRequests: string[] = [];
  const adminUpstream = createHttpServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before responding.
    }
    adminRequests.push(request.url ?? "");
    response.statusCode = request.url === "/key/delete" ? 204 : 200;
    response.setHeader("content-type", "application/json");
    response.end(response.statusCode === 204 ? undefined : JSON.stringify({ ok: true }));
  });

  let adminProxy: ReturnType<typeof createLiteLlmAdminProxy> | undefined;
  const signedPolicy = policyFixture(runtimePolicy, workspaceId);
  const workspaceNode = createControllerServer(
    adapter,
    new MutualTlsNodeRequestAuthenticator(controllerToken, controlCommonName),
    signedPolicy.keys,
    {
      nodeId: "workspace-node-test",
      https: {
        ca: nodeAuthority.ca,
        cert: nodeAuthority.server.certificate,
        key: nodeAuthority.server.key,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      },
    },
  );

  try {
    await listen(adminUpstream);
    const upstreamPort = (adminUpstream.address() as AddressInfo).port;
    adminProxy = createLiteLlmAdminProxy({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      certificate: adminAuthority.server.certificate,
      privateKey: adminAuthority.server.key,
      clientCa: adminAuthority.ca,
      expectedClientCommonName: controlCommonName,
    });
    await listen(adminProxy);
    const adminPort = (adminProxy.address() as AddressInfo).port;

    await workspaceNode.listen({ port: 0, host: "127.0.0.1" });
    const nodePort = (workspaceNode.server.address() as AddressInfo).port;

    const adminFetch = transportFor({
      ca: adminAuthority.ca,
      client: adminAuthority.client,
      serverName: "litellm-admin-listener",
    });
    const adminResponse = await adminFetch(`https://127.0.0.1:${adminPort}/key/delete`, {
      method: "POST",
      headers: { authorization: "Bearer control-master-key-never-logged", "content-type": "application/json" },
      body: JSON.stringify({ key_aliases: ["mtls-boundary-probe"] }),
    });
    assert.equal(adminResponse.status, 204);
    assert.deepEqual(adminRequests, ["/key/delete"]);

    const nodeFetch = transportFor({
      ca: nodeAuthority.ca,
      client: nodeAuthority.client,
      serverName: "workspace-node",
    });
    const nodeClient = new HttpControllerClient(`https://127.0.0.1:${nodePort}`, controllerToken, nodeFetch);
    const status = await nodeClient.status(workspaceId, providerId);
    assert.equal(status.providerId, providerId);
    assert.equal(status.state, "ready");

    await assert.rejects(requestWithoutClientIdentity({
      port: adminPort,
      path: "/key/delete",
      ca: adminAuthority.ca,
      serverName: "litellm-admin-listener",
    }));
    await assert.rejects(requestWithoutClientIdentity({
      port: nodePort,
      path: "/healthz",
      ca: nodeAuthority.ca,
      serverName: "workspace-node",
    }));

    const wrongAdminIdentity = transportFor({
      ca: adminAuthority.ca,
      client: adminAuthority.wrongClient,
      serverName: "litellm-admin-listener",
    });
    assert.equal((await wrongAdminIdentity(`https://127.0.0.1:${adminPort}/key/delete`, { method: "POST" })).status, 403);

    const wrongNodeIdentity = new HttpControllerClient(
      `https://127.0.0.1:${nodePort}`,
      controllerToken,
      transportFor({ ca: nodeAuthority.ca, client: nodeAuthority.wrongClient, serverName: "workspace-node" }),
    );
    await assert.rejects(wrongNodeIdentity.status(workspaceId, providerId), rejectedAsHiddenNodeRoute);

    const wrongNodeToken = new HttpControllerClient(`https://127.0.0.1:${nodePort}`, "wrong-controller-token", nodeFetch);
    await assert.rejects(wrongNodeToken.status(workspaceId, providerId), rejectedAsHiddenNodeRoute);

    await assert.rejects(transportFor({
      ca: adminAuthority.ca,
      client: nodeAuthority.client,
      serverName: "litellm-admin-listener",
    })(`https://127.0.0.1:${adminPort}/key/delete`, { method: "POST" }));
    await assert.rejects(transportFor({
      ca: nodeAuthority.ca,
      client: adminAuthority.client,
      serverName: "workspace-node",
    })(`https://127.0.0.1:${nodePort}/healthz`));

    await assert.rejects(transportFor({
      ca: adminAuthority.ca,
      client: adminAuthority.client,
      serverName: "wrong-admin-name",
    })(`https://127.0.0.1:${adminPort}/key/delete`, { method: "POST" }));
    await assert.rejects(transportFor({
      ca: nodeAuthority.ca,
      client: nodeAuthority.client,
      serverName: "wrong-node-name",
    })(`https://127.0.0.1:${nodePort}/healthz`));
  } finally {
    await workspaceNode.close();
    if (adminProxy) await close(adminProxy);
    await close(adminUpstream);
    await Promise.all([adminAuthority.cleanup(), nodeAuthority.cleanup()]);
  }
});
