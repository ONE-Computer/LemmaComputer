import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { OneComputerError } from "@onecomputer/contracts";
import { LiteLLMProviderAdministration } from "@onecomputer/litellm-adapter";

const alphaKey = "sk-provider-alpha-never-log-000000000001";
const betaKey = "sk-provider-beta-never-log-000000000002";
const rotatedKey = "sk-provider-alpha-rotated-never-log-000003";
const rejectedKey = "sk-provider-rejected-never-log-000000003";

type GatewayRequest = {
  method: string;
  url: string;
  authorization: string;
  body: Record<string, unknown>;
};

const close = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve, reject) => (
  server.close((error) => error ? reject(error) : resolve())
));

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
};

const gatewayFor = (port: number) => new LiteLLMProviderAdministration({
  adminUrl: "http://127.0.0.1:" + port,
  masterKey: "sk-provider-admin-key-never-exposed-00001",
  credentialSecret: "provider-fingerprint-secret-never-exposed-00001",
});

const modelDocument = (request: GatewayRequest) => request.body as {
  model_name: string;
  litellm_params: Record<string, unknown>;
  model_info: Record<string, unknown>;
};

test("managed provider configuration isolates tenants, validates candidates, and rejects stale static routes", async () => {
  const requests: GatewayRequest[] = [];
  let rejectCandidate = false;
  let staticOpenAi = false;
  const semanticCredentialPatchFailure = true;
  const server = createServer(async (request, response) => {
    const item: GatewayRequest = {
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: String(request.headers.authorization ?? ""),
      body: await readBody(request),
    };
    requests.push(item);
    response.setHeader("content-type", "application/json");

    if (item.method === "GET" && item.url === "/model/info") {
      response.end(JSON.stringify({
        data: staticOpenAi ? [{ model_name: "onecomputer-assistant", model_info: {} }] : [],
      }));
      return;
    }
    if (item.method === "PATCH" && item.url.startsWith("/credentials/")) {
      if (semanticCredentialPatchFailure) {
        response.end(JSON.stringify({
          message: "Credential record was not found",
          type: "internal_server_error",
          param: null,
          openai_code: 404,
          code: "404",
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({}));
      return;
    }
    if (item.method === "PATCH" && /^\/model\/[^/]+\/update$/.test(item.url)) {
      response.statusCode = 404;
      response.end(JSON.stringify({}));
      return;
    }
    if (item.method === "POST" && item.url === "/credentials") {
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (item.method === "DELETE" && item.url.startsWith("/credentials/")) {
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (item.method === "POST" && item.url === "/model/new") {
      response.end(JSON.stringify({ model_info: { id: (item.body.model_info as Record<string, unknown>).id } }));
      return;
    }
    if (item.method === "POST" && ["/model/delete", "/key/generate", "/key/delete"].includes(item.url)) {
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (item.method === "POST" && item.url === "/chat/completions") {
      if (rejectCandidate) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: { message: "provider rejected " + rejectedKey } }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: "Unexpected route" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const gateway = gatewayFor(address.port);

  try {
    const alpha = await gateway.configureManagedProvider({
      tenantId: "tenant-alpha",
      provider: "openai",
      apiKey: alphaKey,
      existingModelIds: [],
    });
    const beta = await gateway.configureManagedProvider({
      tenantId: "tenant-beta",
      provider: "openai",
      apiKey: betaKey,
      existingModelIds: [],
    });

    assert.equal(alpha.modelIds.length, 3);
    assert.equal(beta.modelIds.length, 3);
    assert.notDeepEqual(alpha.modelIds, beta.modelIds);
    assert.notEqual(alpha.credentialFingerprint, beta.credentialFingerprint);

    const stableModels = requests
      .filter((request) => request.url === "/model/new")
      .map(modelDocument)
      .filter((document) => Array.isArray(document.model_info.access_groups) && document.model_info.access_groups.length > 0);
    assert.equal(stableModels.length, 6);
    for (const document of stableModels) {
      assert.ok(["onecomputer-assistant", "onecomputer-openai", "claude-opus-4-6"].includes(document.model_name));
      assert.equal("api_key" in document.litellm_params, false);
      assert.match(String(document.litellm_params.litellm_credential_name), /^onecomputer-provider-/);
      const groups = document.model_info.access_groups as unknown[];
      assert.equal(groups.length, 1);
      assert.match(String(groups[0]), /^ocp-[A-Za-z0-9_-]+-/);
    }
    const assistantRoutes = stableModels.filter((document) => document.model_name === "onecomputer-assistant");
    assert.equal(assistantRoutes.length, 2);
    assert.notEqual(assistantRoutes[0]!.model_info.id, assistantRoutes[1]!.model_info.id);
    assert.notEqual(
      (assistantRoutes[0]!.model_info.access_groups as unknown[])[0],
      (assistantRoutes[1]!.model_info.access_groups as unknown[])[0],
    );

    const credentials = requests.filter((request) => request.url === "/credentials");
    assert.ok(credentials.some((request) => (request.body.credential_values as Record<string, unknown>).api_key === alphaKey));
    assert.ok(credentials.some((request) => (request.body.credential_values as Record<string, unknown>).api_key === betaKey));
    assert.equal(requests.filter((request) => request.method === "PATCH" && request.url.startsWith("/credentials/")).length, 0, "First-use provider setup must create its stable credential instead of PATCHing a missing record");
    assert.equal(credentials.filter((request) => !String(request.body.credential_name).includes("-candidate-")).length, 2, "First-use provider setup must create one stable credential per tenant");
    const grants = requests.filter((request) => request.url === "/key/generate");
    assert.equal(grants.length, 2);
    for (const grant of grants) {
      assert.match(String((grant.body.models as unknown[])[0]), /^ocp-/);
      assert.match(grant.authorization, /^Bearer sk-provider-admin-/);
    }
    const stableProbes = requests.filter((request) => (
      request.url === "/chat/completions"
      && ["onecomputer-assistant", "onecomputer-openai", "claude-opus-4-6"].includes(String(request.body.model))
    ));
    assert.equal(stableProbes.length, 2);
    for (const probe of stableProbes) assert.match(probe.authorization, /^Bearer sk-ocp-/);
    for (const request of requests.filter((request) => !request.url.startsWith("/credentials"))) {
      assert.equal(JSON.stringify(request.body).includes(alphaKey), false);
      assert.equal(JSON.stringify(request.body).includes(betaKey), false);
    }

    const candidateStart = requests.length;
    rejectCandidate = true;
    await assert.rejects(
      gateway.configureManagedProvider({
        tenantId: "tenant-rejected",
        provider: "anthropic",
        apiKey: rejectedKey,
        existingModelIds: [],
      }),
      (error: unknown) => {
        assert.ok(error instanceof OneComputerError);
        assert.equal(error.code, "PROVIDER_CREDENTIAL_REJECTED");
        assert.equal(error.message.includes(rejectedKey), false);
        return true;
      },
    );
    const candidateRequests = requests.slice(candidateStart);
    const candidateStableRoutes = candidateRequests
      .filter((request) => request.url === "/model/new")
      .map(modelDocument)
      .filter((document) => Array.isArray(document.model_info.access_groups) && document.model_info.access_groups.length > 0);
    assert.equal(candidateStableRoutes.length, 0);
    for (const request of candidateRequests.filter((request) => !request.url.startsWith("/credentials"))) {
      assert.equal(JSON.stringify(request.body).includes(rejectedKey), false);
    }

    rejectCandidate = false;
    const rotationStart = requests.length;
    await assert.rejects(
      gateway.configureManagedProvider({
        tenantId: "tenant-alpha",
        provider: "openai",
        apiKey: rotatedKey,
        existingModelIds: alpha.modelIds,
      }),
      (error: unknown) => {
        assert.ok(error instanceof OneComputerError);
        assert.equal(error.code, "PROVIDER_ROUTE_FAILED");
        assert.equal(error.message.includes(rotatedKey), false);
        return true;
      },
    );
    const rotationRequests = requests.slice(rotationStart);
    assert.equal(rotationRequests.filter((request) => request.method === "PATCH" && request.url.startsWith("/credentials/")).length, 1, "Rotation must attempt a single stable credential PATCH");
    assert.equal(rotationRequests.filter((request) => request.url === "/credentials" && !String(request.body.credential_name).includes("-candidate-")).length, 0, "A semantically failed stable credential PATCH must fail closed instead of creating a replacement route");
    assert.equal(rotationRequests.filter((request) => request.url === "/model/new").map(modelDocument).filter((document) => Array.isArray(document.model_info.access_groups) && document.model_info.access_groups.length > 0).length, 0, "A semantically failed stable credential PATCH must not alter stable model routes");

    staticOpenAi = true;
    const staticStart = requests.length;
    await assert.rejects(
      gateway.configureManagedProvider({
        tenantId: "tenant-static",
        provider: "openai",
        apiKey: alphaKey,
        existingModelIds: [],
      }),
      (error: unknown) => {
        assert.ok(error instanceof OneComputerError);
        assert.equal(error.code, "PROVIDER_STATIC_CUTOVER_REQUIRED");
        return true;
      },
    );
    assert.deepEqual(requests.slice(staticStart).map((request) => request.url), ["/model/info"]);
  } finally {
    await close(server);
  }
});
