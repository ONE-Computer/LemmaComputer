import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildKasmClipboardLaunch,
  DEFAULT_DOCKER_WORKSPACE_STARTUP_TIMEOUT_MS,
  DockerKasmVncAdapter,
  ELECTRON_WORKSPACE_APPARMOR_PROFILE,
} from "@lemmacomputer/kasm-adapter";
import { policyFixture } from "./policy-fixture.js";

test("Kasm launch forces the native clipboard contract instead of browser-local defaults", () => {
  const enabled = buildKasmClipboardLaunch("https://127.0.0.1:16920/", {
    enabled: true,
    localToWorkspace: true,
    workspaceToLocal: true,
    maxBytes: 65_536,
  }, new Date("2026-07-23T02:00:00.000Z"));
  const enabledUrl = new URL(enabled.launchUrl);
  assert.equal(enabledUrl.searchParams.get("clipboard_up"), "true");
  assert.equal(enabledUrl.searchParams.get("clipboard_down"), "true");
  assert.equal(enabledUrl.searchParams.get("clipboard_seamless"), "true");
  assert.equal(enabledUrl.searchParams.get("translate_shortcuts"), "true");
  assert.deepEqual(enabled.clipboard, {
    status: "available",
    reasonCode: "CLIPBOARD_READY",
    mode: "native",
    localToWorkspace: true,
    workspaceToLocal: true,
    mimeTypes: ["text/plain"],
    maxBytes: 65_536,
    requiresUserGesture: true,
    supportedBrowsers: ["chromium"],
    fallback: "kasm-control-panel",
  });

  const disabled = buildKasmClipboardLaunch("https://127.0.0.1:16920/", {
    enabled: false,
    localToWorkspace: true,
    workspaceToLocal: true,
    maxBytes: 65_536,
  }, new Date("2026-07-23T02:00:00.000Z"));
  const disabledUrl = new URL(disabled.launchUrl);
  assert.equal(disabledUrl.searchParams.get("clipboard_up"), "false");
  assert.equal(disabledUrl.searchParams.get("clipboard_down"), "false");
  assert.equal(disabledUrl.searchParams.get("clipboard_seamless"), "false");
  assert.equal(disabled.clipboard.status, "policy_disabled");
  assert.equal(disabled.clipboard.reasonCode, "CLIPBOARD_POLICY_DISABLED");
});

test("local Kasm gives workspace initialization a production-safe startup window", () => {
  assert.equal(DEFAULT_DOCKER_WORKSPACE_STARTUP_TIMEOUT_MS, 60_000);
});

test("local Kasm observes readiness at the timeout boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lemmacomputer-docker-api-"));
  const socketPath = join(directory, "docker.sock");
  let inspections = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const path = request.url?.replace(/^\/v1\.47/, "") ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/containers/sandbox-id/json") {
      inspections += 1;
      response.end(JSON.stringify({
        State: {
          Running: true,
          Status: "running",
          Health: { Status: inspections === 1 ? "starting" : "healthy" },
        },
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const adapter = new DockerKasmVncAdapter({
      socketPath,
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "lemmacomputer-control",
      gatewayContainer: "lemmacomputer-litellm",
      relayImage: "sha256:pinned-relay",
      installationKind: "customer-managed",
      startupPollMs: 50,
      startupTimeoutMs: 5,
    });
    await (adapter as unknown as { waitForStartup: (id: string) => Promise<void> }).waitForStartup("sandbox-id");
    assert.equal(inspections, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Kasm allows a running workspace to recover from transient unhealthy readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lemmacomputer-docker-api-"));
  const socketPath = join(directory, "docker.sock");
  let inspections = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const path = request.url?.replace(/^\/v1\.47/, "") ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/containers/sandbox-id/json") {
      inspections += 1;
      response.end(JSON.stringify({
        State: {
          Running: true,
          Status: "running",
          ExitCode: 0,
          Health: { Status: inspections === 1 ? "unhealthy" : "healthy" },
        },
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const adapter = new DockerKasmVncAdapter({
      socketPath,
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "lemmacomputer-control",
      gatewayContainer: "lemmacomputer-litellm",
      relayImage: "sha256:pinned-relay",
      installationKind: "customer-managed",
      startupPollMs: 1,
      startupTimeoutMs: 100,
    });
    await (adapter as unknown as { waitForStartup: (id: string) => Promise<void> }).waitForStartup("sandbox-id");
    assert.equal(inspections, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Kasm reconciliation restores governed endpoints after Compose replaces them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lemmacomputer-docker-api-"));
  const socketPath = join(directory, "docker.sock");
  const workspaceNetwork = "lemmacomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
  const connections: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const path = request.url?.replace(/^\/v1\.47/, "") ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/containers/json?all=1") {
      response.end(JSON.stringify([{ State: "running", Labels: {
        "com.lemmacomputer.workspace-network": workspaceNetwork,
        "com.lemmacomputer.gateway-attached": "true",
        "com.lemmacomputer.control-attached": "true",
      } }]));
      return;
    }
    if (request.method === "GET" && path === `/networks/${workspaceNetwork}`) {
      response.end(JSON.stringify({ Containers: {} }));
      return;
    }
    if (request.method === "POST" && path === `/networks/${workspaceNetwork}/connect`) connections.push(body);
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const adapter = new DockerKasmVncAdapter({
      socketPath,
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "lemmacomputer-control",
      gatewayContainer: "lemmacomputer-litellm",
      controlContainer: "lemmacomputer-control-api",
      relayImage: "sha256:pinned-relay",
      installationKind: "customer-managed",
    });
    await adapter.reconcile();
    assert.deepEqual(connections, [
      { Container: "lemmacomputer-litellm", EndpointConfig: { Aliases: ["litellm"] } },
      { Container: "lemmacomputer-control-api", EndpointConfig: { Aliases: ["lemmacomputer-control", "control-api"] } },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Kasm destroy tolerates a governed endpoint disappearing during disconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lemmacomputer-docker-api-"));
  const socketPath = join(directory, "docker.sock");
  const workspaceNetwork = "lemmacomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let gatewayConnected = true;
  let networkRemoved = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const path = request.url?.replace(/^\/v1\.47/, "") ?? "";
    requests.push({ method: request.method ?? "", path, body });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/containers/sandbox-id/json") {
      response.end(JSON.stringify({
        Config: {
          Labels: {
            "com.lemmacomputer.workspace-id": "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
            "com.lemmacomputer.workspace-network": workspaceNetwork,
            "com.lemmacomputer.gateway-attached": "true",
            "com.lemmacomputer.control-attached": "true",
          },
          Env: [],
        },
        Name: "/lemmacomputer-sandbox-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      }));
      return;
    }
    if (request.method === "GET" && path === `/networks/${workspaceNetwork}`) {
      response.end(JSON.stringify({
        Containers: gatewayConnected
          ? { "gateway-container-id": { Name: "lemmacomputer-litellm" } }
          : {},
      }));
      return;
    }
    if (
      request.method === "POST"
      && path === `/networks/${workspaceNetwork}/disconnect`
      && body.Container === "lemmacomputer-litellm"
    ) {
      // Reproduce Docker's observed race: Compose drops the endpoint after
      // inspection, then Docker reports "not connected" as a 500 response.
      gatewayConnected = false;
      response.statusCode = 500;
      response.end(JSON.stringify({
        message: "container gateway-container-id is not connected to network lemmacomputer-workspace",
      }));
      return;
    }
    if (request.method === "DELETE" && path === `/networks/${workspaceNetwork}`) {
      networkRemoved = true;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const adapter = new DockerKasmVncAdapter({
      socketPath,
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "lemmacomputer-control",
      gatewayContainer: "lemmacomputer-litellm",
      controlContainer: "lemmacomputer-control-api",
      relayImage: "sha256:pinned-relay",
      installationKind: "customer-managed",
    });
    await assert.doesNotReject(adapter.destroy("b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508", "sandbox-id"));
    assert.equal(networkRemoved, true);
    assert.equal(
      requests.some((item) => (
        item.path === `/networks/${workspaceNetwork}/disconnect`
        && item.body.Container === "lemmacomputer-control-api"
      )),
      false,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote Kasm destroy removes stale colocated endpoints after the sandbox is already gone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lemmacomputer-docker-api-"));
  const socketPath = join(directory, "docker.sock");
  const workspaceId = "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
  const workspaceNetwork = `lemmacomputer-workspace-${workspaceId}`;
  const connected = new Set(["lemmacomputer-litellm", "lemmacomputer-control-api"]);
  let networkRemoved = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const path = request.url?.replace(/^\/v1\.47/, "") ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/containers/missing-sandbox/json") {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }
    if (request.method === "GET" && path === `/networks/${workspaceNetwork}`) {
      response.end(JSON.stringify({
        Containers: Object.fromEntries([...connected].map((name, index) => [`container-${index}`, { Name: name }])),
      }));
      return;
    }
    if (request.method === "POST" && path === `/networks/${workspaceNetwork}/disconnect`) {
      connected.delete(String(body.Container));
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "DELETE" && path === `/networks/${workspaceNetwork}`) {
      assert.deepEqual([...connected], []);
      networkRemoved = true;
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "DELETE" && path.startsWith("/containers/")) {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const adapter = new DockerKasmVncAdapter({
      socketPath,
      topology: "remote",
      nodeId: "workspace-node-test",
      publicHost: "workspace.internal.example.test",
      relayBindHost: "10.0.1.10",
      relayNetwork: "workspace-relay-private",
      relayTlsCertificate: "test-certificate",
      relayTlsKey: "test-private-key",
      relayTlsClientCa: "test-node-ca",
      relayTlsClientCommonName: "lemmacomputer-workspace-ingress",
      applicationNetwork: "workspace-app-private",
      applicationTlsCa: "test-application-ca",
      applicationTlsClientCertificate: "test-application-client-certificate",
      applicationTlsClientKey: "test-application-client-key",
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "lemmacomputer-control",
      gatewayContainer: "lemmacomputer-litellm",
      controlContainer: "lemmacomputer-control-api",
      relayImage: "sha256:pinned-relay",
      installationKind: "hosted",
    });
    await assert.doesNotReject(adapter.destroy(workspaceId, "missing-sandbox"));
    assert.equal(networkRemoved, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("hosted Cowork virtualization is rejected on a colocated node", () => {
  assert.throws(
    () => new DockerKasmVncAdapter({
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "lemmacomputer-control",
      gatewayContainer: "lemmacomputer-litellm",
      controlContainer: "lemmacomputer-control-api",
      relayImage: "sha256:pinned-relay",
      installationKind: "hosted",
      kvmEnabled: true,
    }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "COWORK_HOST_ISOLATION_REQUIRED",
      );
      return true;
    },
  );
});

test("hosted Cowork virtualization is allowed on a fully isolated remote node", () => {
  assert.doesNotThrow(
    () => new DockerKasmVncAdapter({
      topology: "remote",
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "lemmacomputer-control",
      gatewayContainer: "lemmacomputer-litellm",
      controlContainer: "lemmacomputer-control-api",
      relayImage: "sha256:pinned-relay",
      installationKind: "hosted",
      kvmEnabled: true,
      publicHost: "workspace-node.internal",
      relayBindHost: "10.0.1.10",
      relayNetwork: "workspace-relay-private",
      relayTlsCertificate: "test-certificate",
      relayTlsKey: "test-private-key",
      relayTlsClientCa: "test-node-ca",
      relayTlsClientCommonName: "lemmacomputer-workspace-ingress",
      applicationNetwork: "workspace-application-private",
      applicationTlsCa: "test-application-ca",
      applicationTlsClientCertificate: "test-application-client-certificate",
      applicationTlsClientKey: "test-application-client-key",
    }),
  );
});

const electronPolicyFixture = () => {
  const workspaceId = "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
  const policy = {
    schemaVersion: 1 as const,
    policyVersionId: "policy-version-electron",
    policyVersion: 1,
    policyHash: "a".repeat(64),
    workspaceProfile: "kasm-persistent-standard" as const,
    agentId: "agent-alex",
    agentProfile: "lemmacomputer-default-agent" as const,
    applications: ["visual-studio-code"] as const,
    networkProfile: "controlled-egress-v1" as const,
    clipboard: {
      enabled: true,
      localToWorkspace: true,
      workspaceToLocal: true,
      maxBytes: 65_536,
    },
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-folders"],
    toolPolicies: { "list-mail-folders": "allow" as const },
  };
  const signed = policyFixture(policy, workspaceId);
  return {
    workspaceId,
    input: {
      workspaceId,
      accessGeneration: 1,
      authority: {
        tenantId: "acme",
        subjectId: "alex",
        workspaceId,
        accessGeneration: 1,
        correlationId: "correlation-electron-sandbox",
        policyDigest: policy.policyHash,
        policyKeyId: signed.bundle.keyId,
      },
      policy,
      policyBundle: signed.bundle,
      policyVerificationKeys: signed.keys,
    },
  };
};

test("Chromium and Electron selections fail closed without the node AppArmor capability", async () => {
  const fixture = electronPolicyFixture();
  const adapter = new DockerKasmVncAdapter({
    socketPath: "/nonexistent/docker.sock",
    image: "sha256:pinned-workspace",
    networkPrefix: "lemmacomputer-workspace",
    controlNetwork: "lemmacomputer-control",
    gatewayContainer: "lemmacomputer-litellm",
    relayImage: "sha256:pinned-relay",
    installationKind: "customer-managed",
  });
  await assert.rejects(
    adapter.create(fixture.input),
    (error: unknown) => (error as { code?: string }).code === "ELECTRON_SANDBOX_NOT_CONFIGURED",
  );
});

test("hosted Chromium and Electron selections require a remote workspace node", async () => {
  const fixture = electronPolicyFixture();
  const adapter = new DockerKasmVncAdapter({
    socketPath: "/nonexistent/docker.sock",
    image: "sha256:pinned-workspace",
    networkPrefix: "lemmacomputer-workspace",
    controlNetwork: "lemmacomputer-control",
    gatewayContainer: "lemmacomputer-litellm",
    relayImage: "sha256:pinned-relay",
    installationKind: "hosted",
    electronSandboxEnabled: true,
  });
  await assert.rejects(
    adapter.create(fixture.input),
    (error: unknown) => (error as { code?: string }).code === "ELECTRON_HOST_ISOLATION_REQUIRED",
  );
});

test("remote Docker/KasmVNC nodes fail closed without private TLS relay configuration", async () => {
  assert.throws(
    () => new DockerKasmVncAdapter({
      topology: "remote",
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "lemmacomputer-control",
      gatewayContainer: "lemmacomputer-litellm",
      relayImage: "sha256:pinned-relay",
      installationKind: "hosted",
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "WORKSPACE_NODE_REMOTE_CONFIGURATION_INCOMPLETE",
  );

  const adapter = new DockerKasmVncAdapter({
    topology: "remote",
    nodeId: "workspace-node-test",
    publicHost: "workspace.internal.example.test",
    relayBindHost: "10.0.1.10",
    relayNetwork: "workspace-relay-private",
    relayTlsCertificate: "test-certificate",
    relayTlsKey: "test-private-key",
    relayTlsClientCa: "test-node-ca",
    relayTlsClientCommonName: "lemmacomputer-workspace-ingress",
    applicationNetwork: "workspace-app-private",
    applicationTlsCa: "test-application-ca",
    applicationTlsClientCertificate: "test-application-client-certificate",
    applicationTlsClientKey: "test-application-client-key",
    image: "sha256:pinned-workspace",
    networkPrefix: "lemmacomputer-workspace",
    controlNetwork: "lemmacomputer-control",
    gatewayContainer: "unused-on-remote-nodes",
    relayImage: "sha256:pinned-relay",
    installationKind: "hosted",
  });
  await assert.rejects(
    (adapter as unknown as { ensureRemoteApplicationRelay: (...args: unknown[]) => Promise<void> })
      .ensureRemoteApplicationRelay("b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508", "gateway", "http://litellm:4000", 4000, "workspace-network"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "WORKSPACE_NODE_REMOTE_UPSTREAM_INSECURE",
  );
});

test("remote application relays disable TLS socket reuse and strip hop-by-hop headers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lemmacomputer-application-relay-"));
  const socketPath = join(directory, "docker.sock");
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const path = request.url?.slice("/v1.47".length) ?? "";
    requests.push({ method: request.method ?? "", path, body });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path.startsWith("/containers/")) {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }
    if (request.method === "POST" && path.startsWith("/containers/create")) {
      response.statusCode = 201;
      response.end(JSON.stringify({ Id: "application-relay-id" }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const adapter = new DockerKasmVncAdapter({
      socketPath,
      topology: "remote",
      nodeId: "workspace-node-test",
      publicHost: "workspace.internal.example.test",
      relayBindHost: "10.0.1.10",
      relayNetwork: "workspace-relay-private",
      relayTlsCertificate: "test-certificate",
      relayTlsKey: "test-private-key",
      relayTlsClientCa: "test-node-ca",
      relayTlsClientCommonName: "lemmacomputer-workspace-ingress",
      applicationNetwork: "workspace-app-private",
      applicationTlsCa: "test-application-ca",
      applicationTlsClientCertificate: "test-application-client-certificate",
      applicationTlsClientKey: "test-application-client-key",
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "unused-on-remote-nodes",
      gatewayContainer: "unused-on-remote-nodes",
      relayImage: "sha256:pinned-relay",
      installationKind: "hosted",
    });
    await (adapter as unknown as { ensureRemoteApplicationRelay: (...args: unknown[]) => Promise<void> })
      .ensureRemoteApplicationRelay(
        "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
        "control",
        "https://application.internal.example.test:4443",
        4100,
        "workspace-network",
      );
    const created = requests.find((item) => item.method === "POST" && item.path.startsWith("/containers/create"))!;
    const command = ((created.body.Cmd as string[]) ?? []).join(" ");
    assert.match(command, /hopByHop/);
    assert.match(command, /agent:false/);
    assert.match(command, /connection:\"close\"/);
    assert.match(command, /responseHeaders/);
    assert.match(command, /cert,key/);
    const environment = (created.body.Env as string[]) ?? [];
    assert.ok(environment.some((value) => value.startsWith("UPSTREAM_CLIENT_CERT_B64=")));
    assert.ok(environment.some((value) => value.startsWith("UPSTREAM_CLIENT_KEY_B64=")));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote desktop relay publishes from a private ingress network and reaches only its workspace upstream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lemmacomputer-remote-relay-"));
  const socketPath = join(directory, "docker.sock");
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const path = request.url?.replace(/^\/v1\.47/, "") ?? "";
    requests.push({ method: request.method ?? "", path, body });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path.includes("/json")) {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }
    if (request.method === "POST" && path.startsWith("/containers/create")) {
      response.statusCode = 201;
      response.end(JSON.stringify({ Id: "relay-id" }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const adapter = new DockerKasmVncAdapter({
      socketPath,
      topology: "remote",
      nodeId: "workspace-node-test",
      publicHost: "workspace.internal.example.test",
      relayBindHost: "10.0.1.10",
      relayNetwork: "workspace-relay-private",
      relayTlsCertificate: "test-certificate",
      relayTlsKey: "test-private-key",
      relayTlsClientCa: "test-node-ca",
      relayTlsClientCommonName: "lemmacomputer-workspace-ingress",
      applicationNetwork: "workspace-app-private",
      applicationTlsCa: "test-application-ca",
      applicationTlsClientCertificate: "test-application-client-certificate",
      applicationTlsClientKey: "test-application-client-key",
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "unused-on-remote-nodes",
      gatewayContainer: "unused-on-remote-nodes",
      relayImage: "sha256:pinned-relay",
      installationKind: "hosted",
    });
    await (adapter as unknown as {
      ensureRelay: (workspaceId: string, sandboxName: string, sandboxId: string, port: number, workspaceNetwork: string) => Promise<void>;
    }).ensureRelay(
      "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      "lemmacomputer-sandbox-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      "sandbox-id",
      16_920,
      "lemmacomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
    );
    const created = requests.find((item) => item.method === "POST" && item.path.startsWith("/containers/create"))!;
    const host = created.body.HostConfig as Record<string, unknown>;
    const command = ((created.body.Cmd as string[]) ?? []).join(" ");
    const environment = (created.body.Env as string[]) ?? [];
    assert.equal(host.NetworkMode, "workspace-relay-private");
    assert.deepEqual(host.PortBindings, { "16920/tcp": [{ HostIp: "10.0.1.10", HostPort: "16920" }] });
    assert.match(command, /requestCert:true/);
    assert.match(command, /rejectUnauthorized:true/);
    assert.match(command, /getPeerCertificate/);
    assert.ok(environment.some((value) => value.startsWith("RELAY_CLIENT_CA_B64=")));
    assert.ok(environment.includes("RELAY_CLIENT_COMMON_NAME=lemmacomputer-workspace-ingress"));
    assert.ok(requests.some((item) => (
      item.path === "/networks/lemmacomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508/connect"
      && item.body.Container === "relay-id"
    )));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Kasm creates a hardened internal network and reconciles governed service attachments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lemmacomputer-docker-api-"));
  const socketPath = join(directory, "docker.sock");
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let createCount = 0;
  let workspaceNetworkExists = false;
  let gatewayConnected = false;
  let controlConnected = false;
  let workspaceVolumeRecord: { Name: string; Labels: Record<string, unknown> } | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const path = request.url?.replace(/^\/v1\.47/, "") ?? "";
    requests.push({ method: request.method ?? "", path, body });
    response.setHeader("content-type", "application/json");
    if (path === "/containers/json?all=1") {
      response.end("[]");
      return;
    }
    if (request.method === "GET" && path.startsWith("/volumes?filters=")) {
      response.end(JSON.stringify({ Volumes: workspaceVolumeRecord ? [workspaceVolumeRecord] : [] }));
      return;
    }
    if (path === "/containers/sandbox-id/json") {
      response.end(JSON.stringify({
        State: { Running: true, ExitCode: 0 },
        Config: {
          Labels: {
            "com.lemmacomputer.workspace-id": "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
            "com.lemmacomputer.workspace-network": "lemmacomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
            "com.lemmacomputer.control-attached": "true",
            "com.lemmacomputer.desktop-port": "16920",
          },
          Env: ["LEMMACOMPUTER_AGENT_BRIDGE_TOKEN=scoped-agent-bridge-token"],
        },
        Name: "/lemmacomputer-sandbox-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      }));
      return;
    }
    if (request.method === "GET" && path === "/networks/lemmacomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508" && workspaceNetworkExists) {
      response.end(JSON.stringify({
        Containers: {
          ...(gatewayConnected ? { "gateway-container-id": { Name: "lemmacomputer-litellm" } } : {}),
          ...(controlConnected ? { "control-container-id": { Name: "lemmacomputer-control-api" } } : {}),
        },
      }));
      return;
    }
    if (request.method === "GET" && (path.startsWith("/networks/") || path.startsWith("/volumes/") || path.includes("/json"))) {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }
    if (request.method === "POST" && path.startsWith("/containers/create")) {
      createCount += 1;
      response.statusCode = 201;
      response.end(JSON.stringify({
        Id: path.includes("-egress") ? "egress-id" : path.includes("-relay") ? "relay-id" : "sandbox-id",
      }));
      return;
    }
    if (request.method === "POST" && path === "/networks/create" && body.Name === "lemmacomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508") {
      workspaceNetworkExists = true;
    }
    if (request.method === "POST" && path === "/networks/lemmacomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508/connect" && body.Container === "lemmacomputer-litellm") {
      gatewayConnected = true;
    }
    if (request.method === "POST" && path === "/networks/lemmacomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508/connect" && body.Container === "lemmacomputer-control-api") {
      controlConnected = true;
    }
    if (request.method === "POST" && path === "/volumes/create") {
      workspaceVolumeRecord = { Name: String(body.Name), Labels: body.Labels as Record<string, unknown> };
    }
    if (request.method === "DELETE" && path.startsWith("/volumes/")) {
      workspaceVolumeRecord = undefined;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const policy = {
    schemaVersion: 1 as const,
    policyVersionId: "policy-version-1",
    policyVersion: 1,
    policyHash: "d".repeat(64),
    workspaceProfile: "kasm-persistent-standard" as const,
    agentId: "agent-alex",
    agentProfile: "lemmacomputer-default-agent" as const,
    applications: ["google-chrome", "visual-studio-code", "obsidian"] as const,
    networkProfile: "controlled-egress-v1" as const,
    clipboard: {
      enabled: true,
      localToWorkspace: true,
      workspaceToLocal: true,
      maxBytes: 65_536,
    },
    egress: {
      id: "egv_acme_updates_v1",
      securityGroupId: "esg_acme_updates",
      version: 1,
      name: "Approved updates",
      description: "Only the approved update domain.",
      defaultAction: "deny" as const,
      documentHash: "e".repeat(64),
      rules: [{
        id: "claude-downloads",
        action: "allow" as const,
        protocol: "https" as const,
        host: "downloads.claude.ai",
        includeSubdomains: false,
        port: 443,
        purpose: "Download Claude Desktop updates",
      }],
    },
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-folders", "list-calendars", "list-drives"],
    toolPolicies: {
      "list-mail-folders": "allow" as const,
      "list-calendars": "allow" as const,
      "list-drives": "allow" as const,
    },
  };
  const signedPolicy = policyFixture(policy, "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508");
  try {
    const adapter = new DockerKasmVncAdapter({
      socketPath,
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "lemmacomputer-control",
      gatewayContainer: "lemmacomputer-litellm",
      controlContainer: "lemmacomputer-control-api",
      relayImage: "sha256:pinned-relay",
      installationKind: "customer-managed",
      egressProxyImage: "sha256:pinned-egress-proxy",
      egressNetwork: "lemmacomputer-egress",
      timeZone: "Asia/Singapore",
      kvmEnabled: true,
      electronSandboxEnabled: true,
      portStart: 16920,
      portEnd: 16920,
    });
    const createInput: Parameters<DockerKasmVncAdapter["create"]>[0] = {
      workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      accessGeneration: 1,
      authority: {
        tenantId: "acme",
        subjectId: "alex",
        workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
        accessGeneration: 1,
        correlationId: "correlation-kasm-adapter",
        policyDigest: policy.policyHash,
        policyKeyId: signedPolicy.bundle.keyId,
      },
      policy,
      policyBundle: signedPolicy.bundle,
      policyVerificationKeys: signedPolicy.keys,
      gateway: {
        baseUrl: "http://litellm:4000",
        credential: "sk-scoped-workspace-agent-key",
        modelAlias: "lemmacomputer-assistant",
        expiresAt: "2026-07-21T00:00:00.000Z",
      },
      agentBridge: {
        baseUrl: "http://lemmacomputer-control:4100",
        token: "scoped-agent-bridge-token-at-least-24-characters",
        expiresAt: "2026-07-21T00:00:00.000Z",
      },
      egressProxy: {
        token: "signed-workspace-egress-token-at-least-24-characters",
        verificationSecret: "workspace-derived-verification-secret-at-least-32-characters",
        expiresAt: "2026-07-24T00:00:00.000Z",
        expectedGrant: {
          tenantId: "acme",
          subjectId: "alex",
          workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
          accessGeneration: 1,
          agentId: "agent-alex",
          securityGroupVersionId: "egv_acme_updates_v1",
          egressMode: "restricted",
          policyHash: "d".repeat(64),
        },
      },
      chatRuntimes: [{
        catalogId: "hermes-claw",
        key: "workspace-specific-hermes-api-key-at-least-32-characters",
      }],
    };
    await adapter.create(createInput);
    const workspaceNetwork = "lemmacomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
    const networkCreate = requests.find((item) => item.path === "/networks/create" && item.body.Name === workspaceNetwork)!;
    assert.equal(networkCreate.body.Internal, true);
    assert.equal((networkCreate.body.Labels as Record<string, unknown>)["com.lemmacomputer.workspace-id"], "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508");
    const gatewayAttach = requests.find((item) => item.path === `/networks/${workspaceNetwork}/connect` && item.body.Container === "lemmacomputer-litellm")!;
    assert.deepEqual((gatewayAttach.body.EndpointConfig as Record<string, unknown>).Aliases, ["litellm"]);
    const controlAttach = requests.find((item) => item.path === `/networks/${workspaceNetwork}/connect` && item.body.Container === "lemmacomputer-control-api")!;
    assert.deepEqual((controlAttach.body.EndpointConfig as Record<string, unknown>).Aliases, ["lemmacomputer-control", "control-api"]);
    const sandboxCreate = requests.find((item) => item.method === "POST" && item.path.startsWith("/containers/create?name=lemmacomputer-sandbox") && !item.path.includes("-egress") && !item.path.includes("-relay"))!;
    const host = sandboxCreate.body.HostConfig as Record<string, unknown>;
    assert.equal(host.NetworkMode, workspaceNetwork);
    assert.equal(host.Memory, 8_589_934_592);
    assert.equal(host.NanoCpus, 2_000_000_000);
    assert.deepEqual(host.CapDrop, ["ALL"]);
    assert.deepEqual(host.CapAdd, ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]);
    const securityOptions = host.SecurityOpt as string[];
    assert.equal(securityOptions[0], "no-new-privileges");
    assert.equal(securityOptions[1], `apparmor=${ELECTRON_WORKSPACE_APPARMOR_PROFILE}`);
    assert.match(securityOptions[2]!, /^seccomp=\{/);
    const seccomp = JSON.parse(securityOptions[2]!.slice("seccomp=".length)) as {
      defaultAction: string;
      syscalls: Array<{
        names: string[];
        action: string;
        args?: Array<{ value: number; valueTwo?: number; op: string }>;
        includes?: { caps?: string[] };
      }>;
    };
    assert.equal(seccomp.defaultAction, "SCMP_ACT_ERRNO");
    const electronNamespaceRules = seccomp.syscalls.slice(0, 3);
    assert.deepEqual(
      electronNamespaceRules.map((rule) => ({ names: rule.names, action: rule.action, args: rule.args })),
      [{
        names: ["clone"],
        action: "SCMP_ACT_ALLOW",
        args: [{ index: 0, value: 268_435_456, valueTwo: 268_435_456, op: "SCMP_CMP_MASKED_EQ" }],
      }, {
        names: ["clone"],
        action: "SCMP_ACT_ALLOW",
        args: [{ index: 0, value: 2_114_060_288, valueTwo: 536_870_912, op: "SCMP_CMP_MASKED_EQ" }],
      }, {
        names: ["unshare"],
        action: "SCMP_ACT_ALLOW",
        args: [{ index: 0, value: 268_435_456, valueTwo: 268_435_456, op: "SCMP_CMP_MASKED_EQ" }],
      }],
    );
    for (const rule of electronNamespaceRules) {
      const argument = rule.args?.[0];
      assert.equal(argument?.op, "SCMP_CMP_MASKED_EQ");
      assert.equal(
        (argument!.valueTwo! & argument!.value) >>> 0,
        argument!.valueTwo,
        `${rule.names.join(",")} masked-equality datum must fit within its mask`,
      );
    }
    assert.equal(
      seccomp.syscalls.some((rule) => (
        rule.names.includes("clone3")
        && rule.action === "SCMP_ACT_ALLOW"
        && !rule.includes?.caps?.includes("CAP_SYS_ADMIN")
      )),
      false,
    );
    assert.deepEqual(
      seccomp.syscalls
        .filter((rule) => rule.names.length === 1 && rule.names[0] === "socket")
        .map((rule) => ({ action: rule.action, value: rule.args?.[0]?.value, op: rule.args?.[0]?.op })),
      [
        { action: "SCMP_ACT_ALLOW", value: 38, op: "SCMP_CMP_LT" },
        { action: "SCMP_ACT_ALLOW", value: 39, op: "SCMP_CMP_EQ" },
        { action: "SCMP_ACT_ALLOW", value: 40, op: "SCMP_CMP_EQ" },
        { action: "SCMP_ACT_ALLOW", value: 40, op: "SCMP_CMP_GT" },
      ],
    );
    assert.deepEqual(host.Devices, [{
      PathOnHost: "/dev/kvm",
      PathInContainer: "/dev/kvm",
      CgroupPermissions: "rwm",
    }, {
      PathOnHost: "/dev/vhost-vsock",
      PathInContainer: "/dev/vhost-vsock",
      CgroupPermissions: "rwm",
    }]);
    const workspaceVolume = "lemmacomputer-workspace-home-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508-g1";
    assert.deepEqual(host.Mounts, [{ Type: "volume", Source: workspaceVolume, Target: "/home/kasm-user" }]);
    const volumeCreate = requests.find((item) => item.path === "/volumes/create")!;
    assert.equal(volumeCreate.body.Name, workspaceVolume);
    const serialized = JSON.stringify(sandboxCreate.body);
    assert.ok(serialized.includes("LEMMACOMPUTER_ALLOWED_TOOLS=list-mail-folders,list-calendars,list-drives"));
    assert.ok(serialized.includes("LEMMACOMPUTER_GATEWAY_UPSTREAM=http://litellm:4000"));
    assert.ok(serialized.includes("LEMMACOMPUTER_GATEWAY_CREDENTIAL=sk-scoped-workspace-agent-key"));
    assert.ok(serialized.includes("LEMMACOMPUTER_SIGNED_POLICY_B64="));
    assert.ok(serialized.includes("LEMMACOMPUTER_POLICY_VERIFICATION_KEYS_B64="));
    assert.ok(serialized.includes("com.lemmacomputer.policy-signing-key-id"));
    assert.ok(serialized.includes("com.lemmacomputer.policy-bundle-digest"));
    assert.ok(!serialized.includes("POLICY_SIGNING_PRIVATE_KEY"));
    assert.ok(serialized.includes("LEMMACOMPUTER_CONTROL_UPSTREAM=http://lemmacomputer-control:4100"));
    assert.ok(serialized.includes("LEMMACOMPUTER_CLIPBOARD_ENABLED=true"));
    assert.ok(serialized.includes("LEMMACOMPUTER_CLIPBOARD_LOCAL_TO_WORKSPACE=true"));
    assert.ok(serialized.includes("LEMMACOMPUTER_CLIPBOARD_WORKSPACE_TO_LOCAL=true"));
    assert.ok(serialized.includes("LEMMACOMPUTER_CLIPBOARD_MAX_BYTES=65536"));
    assert.ok(serialized.includes("TZ=Asia/Singapore"));
    assert.ok(serialized.includes("LEMMACOMPUTER_TIME_ZONE=Asia/Singapore"));
    assert.ok(serialized.includes("LEMMACOMPUTER_COWORK_ENABLED=true"));
    assert.ok(serialized.includes(
      "VNCOPTIONS=-DisableBasicAuth=1 -PreferBandwidth -DynamicQualityMin=4 -DynamicQualityMax=7 -DLP_ClipDelay=0",
    ));
    assert.ok(serialized.includes('"com.lemmacomputer.cowork-enabled":"true"'));
    assert.ok(serialized.includes('"com.lemmacomputer.time-zone":"Asia/Singapore"'));
    assert.ok(serialized.includes("API_SERVER_ENABLED=true"));
    assert.ok(serialized.includes("API_SERVER_HOST=0.0.0.0"));
    assert.ok(serialized.includes("API_SERVER_PORT=8642"));
    assert.ok(serialized.includes("API_SERVER_KEY=workspace-specific-hermes-api-key-at-least-32-characters"));
    assert.equal(host.PortBindings, undefined);
    assert.ok(serialized.includes("HTTPS_PROXY=http://lemmacomputer:"));
    assert.ok(serialized.includes("@lemmacomputer-egress-proxy:3128"));
    assert.ok(!serialized.includes("EGRESS_GRANT_SECRET"));
    assert.ok(serialized.includes("com.lemmacomputer.control-attached"));
    assert.ok(!serialized.includes("OPENAI_API_KEY"));
    assert.ok(!serialized.includes("LITELLM_MASTER_KEY"));
    assert.ok(!serialized.includes("CLIENT_SECRET"));
    assert.ok(!serialized.includes("DATABASE_URL"));
    assert.ok(!serialized.includes("DOCKER_HOST"));
    const egressCreate = requests.find((item) => item.method === "POST" && item.path.startsWith("/containers/create") && item.path.includes("-egress"))!;
    const egressHost = egressCreate.body.HostConfig as Record<string, unknown>;
    assert.equal(egressHost.NetworkMode, workspaceNetwork);
    assert.deepEqual(egressHost.CapDrop, ["ALL"]);
    assert.equal(egressHost.ReadonlyRootfs, true);
    const egressNetworking = egressCreate.body.NetworkingConfig as { EndpointsConfig: Record<string, { Aliases: string[] }> };
    assert.deepEqual(egressNetworking.EndpointsConfig[workspaceNetwork]?.Aliases, ["lemmacomputer-egress-proxy"]);
    assert.ok(JSON.stringify(egressCreate.body).includes("downloads.claude.ai"));
    assert.ok(requests.some((item) => item.path === "/networks/lemmacomputer-egress/connect" && item.body.Container === "egress-id"));
    const updatedPolicy = {
      ...policy,
      policyHash: "f".repeat(64),
      egress: {
        ...policy.egress,
        id: "egv_acme_updates_v2",
        version: 2,
        documentHash: "1".repeat(64),
        rules: [{
          id: "deny-chatgpt",
          action: "deny" as const,
          protocol: "https" as const,
          host: "chatgpt.com",
          includeSubdomains: true,
          port: 443,
          purpose: "Block ChatGPT",
        }],
      },
    };
    const updatedSignedPolicy = policyFixture(updatedPolicy, "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508");
    await adapter.updateEgressPolicy("b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508", "sandbox-id", {
      workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      authority: {
        tenantId: "acme",
        subjectId: "alex",
        workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
        accessGeneration: 1,
        correlationId: "correlation-egress-update",
        policyDigest: updatedPolicy.policyHash,
        policyKeyId: updatedSignedPolicy.bundle.keyId,
      },
      policy: updatedPolicy,
      policyBundle: updatedSignedPolicy.bundle,
      policyVerificationKeys: updatedSignedPolicy.keys,
      egressProxy: {
        token: "replacement-egress-token-at-least-24-characters",
        verificationSecret: "workspace-derived-verification-secret-at-least-32-characters",
        expiresAt: "2026-07-24T00:00:00.000Z",
        expectedGrant: {
          tenantId: "acme",
          subjectId: "alex",
          workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
          accessGeneration: 1,
          agentId: "agent-alex",
          securityGroupVersionId: "egv_acme_updates_v2",
          egressMode: "restricted",
          policyHash: "f".repeat(64),
        },
      },
    });
    const egressCreates = requests.filter((item) => item.method === "POST" && item.path.startsWith("/containers/create") && item.path.includes("-egress"));
    assert.equal(egressCreates.length, 2);
    assert.ok(JSON.stringify(egressCreates[1]!.body).includes("chatgpt.com"));
    assert.equal(requests.some((item) => item.method === "DELETE" && item.path === "/containers/sandbox-id?force=true&v=true"), false);
    // Simulate Compose replacing Control and dropping its dynamic endpoint.
    controlConnected = false;
    await adapter.status("b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508", "sandbox-id");
    assert.equal(requests.filter((item) => item.path === `/networks/${workspaceNetwork}/connect` && item.body.Container === "lemmacomputer-litellm").length, 1);
    assert.equal(requests.filter((item) => item.path === `/networks/${workspaceNetwork}/connect` && item.body.Container === "lemmacomputer-control-api").length, 2);
    const launch = await adapter.open("b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508", "sandbox-id");
    assert.deepEqual(launch.ingressTarget, {
      protocol: "https",
      host: "lemma-ws-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508-relay",
      port: 16_920,
    });
    assert.ok(launch.ingressTarget!.host.length <= 63);
    const relayCreate = requests.find((item) => item.method === "POST" && item.path.includes("/containers/create?name=lemma-ws-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508-relay"));
    assert.ok(relayCreate);
    assert.ok(new URLSearchParams(relayCreate.path.split("?")[1]).get("name")!.length <= 63);
    const standardAdapter = new DockerKasmVncAdapter({
      socketPath,
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "lemmacomputer-control",
      gatewayContainer: "lemmacomputer-litellm",
      controlContainer: "lemmacomputer-control-api",
      relayImage: "sha256:pinned-relay",
      installationKind: "customer-managed",
      egressProxyImage: "sha256:pinned-egress-proxy",
      egressNetwork: "lemmacomputer-egress",
      kvmEnabled: false,
      electronSandboxEnabled: true,
      portStart: 16920,
      portEnd: 16920,
    });
    await standardAdapter.create(createInput);
    const sandboxCreates = requests.filter((item) => item.method === "POST" && item.path.startsWith("/containers/create?name=lemmacomputer-sandbox") && !item.path.includes("-egress") && !item.path.includes("-relay"));
    const standardHost = sandboxCreates.at(-1)!.body.HostConfig as Record<string, unknown>;
    assert.equal(standardHost.Memory, 4_294_967_296);
    assert.equal(standardHost.Devices, undefined);
    const standardSecurityOptions = standardHost.SecurityOpt as string[];
    assert.equal(standardSecurityOptions[0], "no-new-privileges");
    assert.equal(standardSecurityOptions[1], `apparmor=${ELECTRON_WORKSPACE_APPARMOR_PROFILE}`);
    assert.match(standardSecurityOptions[2]!, /^seccomp=\{/);
    const standardSeccomp = JSON.parse(standardSecurityOptions[2]!.slice("seccomp=".length)) as {
      syscalls: Array<{ names: string[]; args?: Array<{ value: number; op: string }> }>;
    };
    assert.equal(standardSeccomp.syscalls.some((rule) => (
      rule.names.length === 1
      && rule.names[0] === "socket"
      && rule.args?.[0]?.value === 40
      && rule.args[0].op === "SCMP_CMP_EQ"
    )), false);
    assert.ok(JSON.stringify(sandboxCreates.at(-1)!.body).includes("LEMMACOMPUTER_ELECTRON_SANDBOX_ENABLED=true"));
    assert.ok(JSON.stringify(sandboxCreates.at(-1)!.body).includes("LEMMACOMPUTER_COWORK_ENABLED=false"));

    const baseWorkspaceId = "88888888-8888-4888-8888-888888888888";
    const { egress: _selectedEgress, ...policyWithoutEgress } = policy;
    const basePolicy = {
      ...policyWithoutEgress,
      policyVersionId: "policy-version-base",
      policyHash: "8".repeat(64),
      agents: [],
      applications: [],
      modelAlias: null,
    };
    const baseSignedPolicy = policyFixture(basePolicy, baseWorkspaceId);
    await standardAdapter.create({
      workspaceId: baseWorkspaceId,
      accessGeneration: 1,
      authority: {
        tenantId: "acme",
        subjectId: "alex",
        workspaceId: baseWorkspaceId,
        accessGeneration: 1,
        correlationId: "correlation-base-workspace",
        policyDigest: basePolicy.policyHash,
        policyKeyId: baseSignedPolicy.bundle.keyId,
      },
      policy: basePolicy,
      policyBundle: baseSignedPolicy.bundle,
      policyVerificationKeys: baseSignedPolicy.keys,
    });
    const baseCreate = requests.filter((item) => (
      item.method === "POST"
      && item.path.startsWith(`/containers/create?name=lemmacomputer-sandbox-${baseWorkspaceId}`)
    )).at(-1)!;
    const baseLabels = baseCreate.body.Labels as Record<string, string>;
    const baseEnvironment = baseCreate.body.Env as string[];
    assert.equal(baseLabels["com.lemmacomputer.enabled-agents"], "");
    assert.equal(baseLabels["com.lemmacomputer.enabled-applications"], "");
    assert.equal(baseLabels["com.lemmacomputer.gateway-attached"], "false");
    assert.equal(baseLabels["com.lemmacomputer.control-attached"], "false");
    assert.equal(baseLabels["com.lemmacomputer.model-alias"], undefined);
    assert.ok(baseEnvironment.includes("LEMMACOMPUTER_ENABLED_AGENTS="));
    assert.ok(baseEnvironment.includes("LEMMACOMPUTER_ENABLED_APPLICATIONS="));
    assert.equal(baseEnvironment.some((value) => value.startsWith("LEMMACOMPUTER_GATEWAY_")), false);
    assert.equal(baseEnvironment.some((value) => value.startsWith("LEMMACOMPUTER_MODEL_ALIAS=")), false);
    assert.equal(baseEnvironment.some((value) => value.startsWith("LEMMACOMPUTER_AGENT_BRIDGE_TOKEN=")), false);

    await adapter.purgeWorkspace("b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508", 1);
    assert.ok(requests.some((item) => item.method === "DELETE" && item.path === `/volumes/${workspaceVolume}?force=true`));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});


test("a paused stale purge can delete only its generation-specific volume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lemmacomputer-docker-api-"));
  const socketPath = join(directory, "docker.sock");
  const deleted: string[] = [];
  let volumeExists = true;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const path = request.url?.slice("/v1.47".length) ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path.startsWith("/volumes?filters=")) {
      response.end(JSON.stringify({ Volumes: volumeExists ? [{
        Name: "lemmacomputer-workspace-home-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508-g2",
        Labels: {
          "com.lemmacomputer.workspace-id": "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
          "com.lemmacomputer.storage-generation": "2",
        },
      }] : [] }));
      return;
    }
    if (request.method === "DELETE") {
      deleted.push(path);
      volumeExists = false;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const adapter = new DockerKasmVncAdapter({
      socketPath,
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "lemmacomputer-control",
      gatewayContainer: "lemmacomputer-litellm",
      relayImage: "sha256:pinned-relay",
      installationKind: "hosted",
    });
    await adapter.purgeWorkspace("b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508", 2);
    assert.deepEqual(deleted, [
      "/volumes/lemmacomputer-workspace-home-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508-g2?force=true",
    ]);
    assert.equal(deleted.some((path) => path.includes("-g3")), false, "a replacement volume created while the stale handler was paused has a different address");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Kasm retries container creation when Docker drops the workspace network", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lemmacomputer-docker-api-"));
  const socketPath = join(directory, "docker.sock");
  const workspaceNetwork = "lemmacomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
  let creates = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const path = request.url?.slice("/v1.47".length) ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && path === "/containers/create") {
      creates += 1;
      if (creates === 1) {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "failed to set up container networking: network " + workspaceNetwork + " not found" }));
        return;
      }
      response.statusCode = 201;
      response.end(JSON.stringify({ Id: "sandbox-id" }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const adapter = new DockerKasmVncAdapter({
      socketPath,
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "lemmacomputer-control",
      gatewayContainer: "lemmacomputer-litellm",
      relayImage: "sha256:pinned-relay",
      installationKind: "customer-managed",
    });
    let reconciliations = 0;
    const result = await (adapter as unknown as {
      createContainer: (path: string, body: Record<string, unknown>, network: string, prepare: () => Promise<void>) => Promise<Record<string, unknown>>;
    }).createContainer("/containers/create", {}, workspaceNetwork, async () => { reconciliations += 1; });
    assert.equal(result.Id, "sandbox-id");
    assert.equal(creates, 2);
    assert.equal(reconciliations, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Kasm surfaces allowlisted exit-78 diagnostics before cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lemmacomputer-docker-api-"));
  const socketPath = join(directory, "docker.sock");
  const message = "Cowork cannot create an AF_VSOCK socket; check the workspace seccomp profile";
  const frame = Buffer.alloc(8 + Buffer.byteLength(message));
  frame[0] = 2;
  frame.writeUInt32BE(Buffer.byteLength(message), 4);
  frame.write(message, 8);
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const path = request.url?.slice("/v1.47".length) ?? "";
    if (path === "/containers/sandbox-id/json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ State: { Running: false, Status: "exited", ExitCode: 78 } }));
      return;
    }
    if (path.startsWith("/containers/sandbox-id/logs?")) {
      response.end(frame);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const adapter = new DockerKasmVncAdapter({
      socketPath,
      image: "sha256:pinned-workspace",
      networkPrefix: "lemmacomputer-workspace",
      controlNetwork: "lemmacomputer-control",
      gatewayContainer: "lemmacomputer-litellm",
      relayImage: "sha256:pinned-relay",
      installationKind: "customer-managed",
      startupPollMs: 1,
      startupTimeoutMs: 20,
    });
    await assert.rejects(
      (adapter as unknown as { waitForStartup: (id: string) => Promise<void> }).waitForStartup("sandbox-id"),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "WORKSPACE_STARTUP_REJECTED");
        assert.match((error as Error).message, /Cowork cannot create an AF_VSOCK socket/);
        assert.equal((error as { retryable?: boolean }).retryable, false);
        return true;
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Kasm allowlists bounded entrypoint validation without exposing arbitrary logs", () => {
  const adapter = new DockerKasmVncAdapter({
    image: "sha256:pinned-workspace",
    networkPrefix: "lemmacomputer-workspace",
    controlNetwork: "lemmacomputer-control",
    gatewayContainer: "lemmacomputer-litellm",
    relayImage: "sha256:pinned-relay",
    installationKind: "customer-managed",
  });
  const diagnostic = (adapter as unknown as { safeStartupDiagnostic: (logs: string) => string | undefined })
    .safeStartupDiagnostic.bind(adapter);
  for (const message of [
    "unrecognized agent selection",
    "managed workspaces require restricted egress",
    "Cowork requires the virtualization device at /dev/kvm",
    "Electron applications require the enforced LemmaComputer AppArmor profile",
    "Hermes Agent CLI MODEL_ALIAS is invalid",
    "persistent crontab has unsafe ownership, mode, or size",
  ]) assert.equal(diagnostic(`prefix\n${message}\nsuffix`), message);
  assert.equal(diagnostic("provider secret=do-not-surface"), undefined);
});
