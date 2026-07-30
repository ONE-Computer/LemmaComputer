import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildKasmClipboardLaunch, KasmLocalAdapter, mapKasmState } from "@onecomputer/kasm-adapter";
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

test("Kasm operational states map to the canonical sandbox contract", () => {
  assert.equal(mapKasmState("running"), "ready");
  assert.equal(mapKasmState("starting"), "provisioning");
  assert.equal(mapKasmState("stopped"), "stopped");
  assert.equal(mapKasmState("error"), "failed");
});

test("local Kasm destroy tolerates a governed endpoint disappearing during disconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "onecomputer-docker-api-"));
  const socketPath = join(directory, "docker.sock");
  const workspaceNetwork = "onecomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
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
            "com.onecomputer.workspace-network": workspaceNetwork,
            "com.onecomputer.gateway-attached": "true",
            "com.onecomputer.control-attached": "true",
          },
          Env: [],
        },
        Name: "/onecomputer-sandbox-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      }));
      return;
    }
    if (request.method === "GET" && path === `/networks/${workspaceNetwork}`) {
      response.end(JSON.stringify({
        Containers: gatewayConnected
          ? { "gateway-container-id": { Name: "onecomputer-litellm" } }
          : {},
      }));
      return;
    }
    if (
      request.method === "POST"
      && path === `/networks/${workspaceNetwork}/disconnect`
      && body.Container === "onecomputer-litellm"
    ) {
      // Reproduce Docker's observed race: Compose drops the endpoint after
      // inspection, then Docker reports "not connected" as a 500 response.
      gatewayConnected = false;
      response.statusCode = 500;
      response.end(JSON.stringify({
        message: "container gateway-container-id is not connected to network onecomputer-workspace",
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
    const adapter = new KasmLocalAdapter({
      socketPath,
      image: "sha256:pinned-workspace",
      networkPrefix: "onecomputer-workspace",
      controlNetwork: "onecomputer-control",
      gatewayContainer: "onecomputer-litellm",
      controlContainer: "onecomputer-control-api",
      relayImage: "sha256:pinned-relay",
      installationKind: "customer-managed",
    });
    await assert.doesNotReject(adapter.destroy("sandbox-id"));
    assert.equal(networkRemoved, true);
    assert.equal(
      requests.some((item) => (
        item.path === `/networks/${workspaceNetwork}/disconnect`
        && item.body.Container === "onecomputer-control-api"
      )),
      false,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Cowork virtualization is rejected on hosted multi-tenant nodes", () => {
  assert.throws(
    () => new KasmLocalAdapter({
      image: "sha256:pinned-workspace",
      networkPrefix: "onecomputer-workspace",
      controlNetwork: "onecomputer-control",
      gatewayContainer: "onecomputer-litellm",
      controlContainer: "onecomputer-control-api",
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

test("local Kasm creates a hardened internal network and reconciles governed service attachments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "onecomputer-docker-api-"));
  const socketPath = join(directory, "docker.sock");
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let createCount = 0;
  let workspaceNetworkExists = false;
  let gatewayConnected = false;
  let controlConnected = false;
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
    if (path === "/containers/sandbox-id/json") {
      response.end(JSON.stringify({
        State: { Running: true, ExitCode: 0 },
        Config: {
          Labels: {
            "com.onecomputer.workspace-id": "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
            "com.onecomputer.workspace-network": "onecomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
            "com.onecomputer.control-attached": "true",
            "com.onecomputer.desktop-port": "16920",
          },
          Env: ["ONECOMPUTER_AGENT_BRIDGE_TOKEN=scoped-agent-bridge-token"],
        },
        Name: "/onecomputer-sandbox-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      }));
      return;
    }
    if (request.method === "GET" && path === "/networks/onecomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508" && workspaceNetworkExists) {
      response.end(JSON.stringify({
        Containers: {
          ...(gatewayConnected ? { "gateway-container-id": { Name: "onecomputer-litellm" } } : {}),
          ...(controlConnected ? { "control-container-id": { Name: "onecomputer-control-api" } } : {}),
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
    if (request.method === "POST" && path === "/networks/create" && body.Name === "onecomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508") {
      workspaceNetworkExists = true;
    }
    if (request.method === "POST" && path === "/networks/onecomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508/connect" && body.Container === "onecomputer-litellm") {
      gatewayConnected = true;
    }
    if (request.method === "POST" && path === "/networks/onecomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508/connect" && body.Container === "onecomputer-control-api") {
      controlConnected = true;
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
    agentProfile: "onecomputer-default-agent" as const,
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
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-folders", "list-calendars", "list-drives"],
    toolPolicies: {
      "list-mail-folders": "allow" as const,
      "list-calendars": "allow" as const,
      "list-drives": "allow" as const,
    },
  };
  const signedPolicy = policyFixture(policy, "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508");
  try {
    const adapter = new KasmLocalAdapter({
      socketPath,
      image: "sha256:pinned-workspace",
      networkPrefix: "onecomputer-workspace",
      controlNetwork: "onecomputer-control",
      gatewayContainer: "onecomputer-litellm",
      controlContainer: "onecomputer-control-api",
      relayImage: "sha256:pinned-relay",
      installationKind: "customer-managed",
      egressProxyImage: "sha256:pinned-egress-proxy",
      egressNetwork: "onecomputer-egress",
      timeZone: "Asia/Singapore",
      kvmEnabled: true,
      portStart: 16920,
      portEnd: 16920,
    });
    const createInput: Parameters<KasmLocalAdapter["create"]>[0] = {
      workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      policy,
      policyBundle: signedPolicy.bundle,
      policyVerificationKeys: signedPolicy.keys,
      gateway: {
        baseUrl: "http://litellm:4000",
        credential: "sk-scoped-workspace-agent-key",
        modelAlias: "onecomputer-assistant",
        expiresAt: "2026-07-21T00:00:00.000Z",
      },
      agentBridge: {
        baseUrl: "http://onecomputer-control:4100",
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
    const workspaceNetwork = "onecomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
    const networkCreate = requests.find((item) => item.path === "/networks/create" && item.body.Name === workspaceNetwork)!;
    assert.equal(networkCreate.body.Internal, true);
    assert.equal((networkCreate.body.Labels as Record<string, unknown>)["com.onecomputer.workspace-id"], "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508");
    const gatewayAttach = requests.find((item) => item.path === `/networks/${workspaceNetwork}/connect` && item.body.Container === "onecomputer-litellm")!;
    assert.deepEqual((gatewayAttach.body.EndpointConfig as Record<string, unknown>).Aliases, ["litellm"]);
    const controlAttach = requests.find((item) => item.path === `/networks/${workspaceNetwork}/connect` && item.body.Container === "onecomputer-control-api")!;
    assert.deepEqual((controlAttach.body.EndpointConfig as Record<string, unknown>).Aliases, ["onecomputer-control"]);
    const sandboxCreate = requests.find((item) => item.method === "POST" && item.path.startsWith("/containers/create?name=onecomputer-sandbox") && !item.path.includes("-egress") && !item.path.includes("-relay"))!;
    const host = sandboxCreate.body.HostConfig as Record<string, unknown>;
    assert.equal(host.NetworkMode, workspaceNetwork);
    assert.equal(host.Memory, 8_589_934_592);
    assert.equal(host.NanoCpus, 2_000_000_000);
    assert.deepEqual(host.CapDrop, ["NET_ADMIN", "NET_RAW", "SYS_ADMIN"]);
    const securityOptions = host.SecurityOpt as string[];
    assert.equal(securityOptions[0], "no-new-privileges");
    assert.match(securityOptions[1]!, /^seccomp=\{/);
    const seccomp = JSON.parse(securityOptions[1]!.slice("seccomp=".length)) as {
      defaultAction: string;
      syscalls: Array<{ names: string[]; action: string; args?: Array<{ value: number; op: string }> }>;
    };
    assert.equal(seccomp.defaultAction, "SCMP_ACT_ERRNO");
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
    const workspaceVolume = "onecomputer-workspace-home-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
    assert.deepEqual(host.Mounts, [{ Type: "volume", Source: workspaceVolume, Target: "/home/kasm-user" }]);
    const volumeCreate = requests.find((item) => item.path === "/volumes/create")!;
    assert.equal(volumeCreate.body.Name, workspaceVolume);
    const serialized = JSON.stringify(sandboxCreate.body);
    assert.ok(serialized.includes("ONECOMPUTER_ALLOWED_TOOLS=list-mail-folders,list-calendars,list-drives"));
    assert.ok(serialized.includes("ONECOMPUTER_GATEWAY_UPSTREAM=http://litellm:4000"));
    assert.ok(serialized.includes("ONECOMPUTER_GATEWAY_CREDENTIAL=sk-scoped-workspace-agent-key"));
    assert.ok(serialized.includes("ONECOMPUTER_SIGNED_POLICY_B64="));
    assert.ok(serialized.includes("ONECOMPUTER_POLICY_VERIFICATION_KEYS_B64="));
    assert.ok(serialized.includes("com.onecomputer.policy-signing-key-id"));
    assert.ok(serialized.includes("com.onecomputer.policy-bundle-digest"));
    assert.ok(!serialized.includes("POLICY_SIGNING_PRIVATE_KEY"));
    assert.ok(serialized.includes("ONECOMPUTER_CONTROL_UPSTREAM=http://onecomputer-control:4100"));
    assert.ok(serialized.includes("ONECOMPUTER_CLIPBOARD_ENABLED=true"));
    assert.ok(serialized.includes("ONECOMPUTER_CLIPBOARD_LOCAL_TO_WORKSPACE=true"));
    assert.ok(serialized.includes("ONECOMPUTER_CLIPBOARD_WORKSPACE_TO_LOCAL=true"));
    assert.ok(serialized.includes("ONECOMPUTER_CLIPBOARD_MAX_BYTES=65536"));
    assert.ok(serialized.includes("TZ=Asia/Singapore"));
    assert.ok(serialized.includes("ONECOMPUTER_TIME_ZONE=Asia/Singapore"));
    assert.ok(serialized.includes("ONECOMPUTER_COWORK_ENABLED=true"));
    assert.ok(serialized.includes('"com.onecomputer.cowork-enabled":"true"'));
    assert.ok(serialized.includes('"com.onecomputer.time-zone":"Asia/Singapore"'));
    assert.ok(serialized.includes("API_SERVER_ENABLED=true"));
    assert.ok(serialized.includes("API_SERVER_HOST=0.0.0.0"));
    assert.ok(serialized.includes("API_SERVER_PORT=8642"));
    assert.ok(serialized.includes("API_SERVER_KEY=workspace-specific-hermes-api-key-at-least-32-characters"));
    assert.equal(host.PortBindings, undefined);
    assert.ok(serialized.includes("HTTPS_PROXY=http://onecomputer:"));
    assert.ok(serialized.includes("@onecomputer-egress-proxy:3128"));
    assert.ok(!serialized.includes("EGRESS_GRANT_SECRET"));
    assert.ok(serialized.includes("com.onecomputer.control-attached"));
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
    assert.deepEqual(egressNetworking.EndpointsConfig[workspaceNetwork]?.Aliases, ["onecomputer-egress-proxy"]);
    assert.ok(JSON.stringify(egressCreate.body).includes("downloads.claude.ai"));
    assert.ok(requests.some((item) => item.path === "/networks/onecomputer-egress/connect" && item.body.Container === "egress-id"));
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
    await adapter.updateEgressPolicy("sandbox-id", {
      workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
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
    await adapter.status("sandbox-id");
    assert.equal(requests.filter((item) => item.path === `/networks/${workspaceNetwork}/connect` && item.body.Container === "onecomputer-litellm").length, 1);
    assert.equal(requests.filter((item) => item.path === `/networks/${workspaceNetwork}/connect` && item.body.Container === "onecomputer-control-api").length, 2);
    const launch = await adapter.open("sandbox-id");
    assert.deepEqual(launch.ingressTarget, {
      protocol: "https",
      host: "onecomputer-sandbox-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508-relay",
      port: 16_920,
    });
    const standardAdapter = new KasmLocalAdapter({
      socketPath,
      image: "sha256:pinned-workspace",
      networkPrefix: "onecomputer-workspace",
      controlNetwork: "onecomputer-control",
      gatewayContainer: "onecomputer-litellm",
      controlContainer: "onecomputer-control-api",
      relayImage: "sha256:pinned-relay",
      installationKind: "customer-managed",
      egressProxyImage: "sha256:pinned-egress-proxy",
      egressNetwork: "onecomputer-egress",
      kvmEnabled: false,
      portStart: 16920,
      portEnd: 16920,
    });
    await standardAdapter.create(createInput);
    const sandboxCreates = requests.filter((item) => item.method === "POST" && item.path.startsWith("/containers/create?name=onecomputer-sandbox") && !item.path.includes("-egress") && !item.path.includes("-relay"));
    const standardHost = sandboxCreates.at(-1)!.body.HostConfig as Record<string, unknown>;
    assert.equal(standardHost.Memory, 4_294_967_296);
    assert.equal(standardHost.Devices, undefined);
    assert.deepEqual(standardHost.SecurityOpt, ["no-new-privileges"]);
    assert.ok(JSON.stringify(sandboxCreates.at(-1)!.body).includes("ONECOMPUTER_COWORK_ENABLED=false"));

    await adapter.purgeWorkspace("b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508");
    assert.ok(requests.some((item) => item.method === "DELETE" && item.path === `/volumes/${workspaceVolume}?force=true`));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});


test("local Kasm retries container creation when Docker drops the workspace network", async () => {
  const directory = await mkdtemp(join(tmpdir(), "onecomputer-docker-api-"));
  const socketPath = join(directory, "docker.sock");
  const workspaceNetwork = "onecomputer-workspace-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
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
    const adapter = new KasmLocalAdapter({
      socketPath,
      image: "sha256:pinned-workspace",
      networkPrefix: "onecomputer-workspace",
      controlNetwork: "onecomputer-control",
      gatewayContainer: "onecomputer-litellm",
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
  const directory = await mkdtemp(join(tmpdir(), "onecomputer-docker-api-"));
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
    const adapter = new KasmLocalAdapter({
      socketPath,
      image: "sha256:pinned-workspace",
      networkPrefix: "onecomputer-workspace",
      controlNetwork: "onecomputer-control",
      gatewayContainer: "onecomputer-litellm",
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
