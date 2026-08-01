import assert from "node:assert/strict";
import test from "node:test";
import {
  E2bSandboxAdapter,
  ModalSandboxAdapter,
  type E2bSdk,
  type ModalSdk,
} from "@onecomputer/managed-sandbox-adapters";
import type { SandboxCreateInput } from "@onecomputer/kasm-adapter";
import { policyFixture } from "./policy-fixture.js";

const workspaceId = "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
const policy = {
  schemaVersion: 1 as const,
  policyVersionId: "policy-version-1",
  policyVersion: 1,
  policyHash: "a".repeat(64),
  workspaceProfile: "kasm-persistent-standard" as const,
  executionMode: "managed" as const,
  egressMode: "restricted" as const,
  agentId: "agent-alex",
  agentProfile: "onecomputer-default-agent" as const,
  networkProfile: "controlled-egress-v1" as const,
  modelAlias: "onecomputer-assistant",
  mcpServer: "onecomputer_ms365",
  allowedTools: ["list-mail-folders"],
  toolPolicies: { "list-mail-folders": "allow" as const },
  egress: {
    schemaVersion: 2 as const,
    mode: "restricted" as const,
    id: "egv_acme_default_v1",
    securityGroupId: "esg_acme_default",
    version: 1,
    name: "Default restricted",
    description: "Only approved destinations.",
    defaultAction: "deny" as const,
    documentHash: "b".repeat(64),
    rules: [],
  },
};
const signed = policyFixture(policy, workspaceId);

const input = (): SandboxCreateInput => ({
  workspaceId,
  policy,
  policyBundle: signed.bundle,
  policyVerificationKeys: signed.keys,
  gateway: {
    baseUrl: "https://models.example.com/v1",
    credential: "scoped-model-credential",
    modelAlias: "onecomputer-assistant",
    expiresAt: "2026-08-01T00:00:00.000Z",
  },
  agentBridge: {
    baseUrl: "https://control.example.com/internal/v1",
    token: "scoped-control-token",
  },
  egressProxy: {
    token: "signed-egress-grant",
    verificationSecret: "verification-secret-not-projected",
    expiresAt: "2026-08-01T00:00:00.000Z",
    expectedGrant: {
      tenantId: "acme",
      subjectId: "alex",
      workspaceId,
      agentId: policy.agentId,
      securityGroupVersionId: policy.egress.id,
      egressMode: policy.egressMode,
      policyHash: policy.policyHash,
    },
  },
});

test("E2B projects policy, persistent storage, controlled egress, and authenticated Kasm launch", async () => {
  let createOptions: Parameters<E2bSdk["create"]>[1] | undefined;
  let destroyedVolume = "";
  const killedSandboxes: string[] = [];
  let listSandboxCalls = 0;
  const sdk: E2bSdk = {
    async create(_template, options) {
      createOptions = options;
      return {
        sandboxId: "e2b-sandbox-1",
        getHost: (port) => `${port}-e2b-sandbox-1.e2b.app`,
        commands: {
          async run(command) {
            return { stdout: command.includes("VNC_PW") ? "generated-vnc-secret" : "" };
          },
        },
        files: { async write() {} },
      };
    },
    async connect() {
      return {
        sandboxId: "e2b-sandbox-1",
        getHost: (port) => `${port}-e2b-sandbox-1.e2b.app`,
        commands: {
          async run(command) {
            return { stdout: command.includes("VNC_PW") ? "generated-vnc-secret" : "" };
          },
        },
        files: { async write() {} },
      };
    },
    async getInfo() {
      return {
        sandboxId: "e2b-sandbox-1",
        templateId: "onecomputer",
        metadata: {
          "onecomputer.workspaceId": workspaceId,
          "onecomputer.egressVersionId": policy.egress.id,
          "onecomputer.egressHash": policy.egress.documentHash,
        },
        startedAt: new Date(),
        endAt: new Date(Date.now() + 60_000),
        state: "running",
        cpuCount: 2,
        memoryMB: 4096,
        envdVersion: "1",
        diskSizeMB: 10_000,
      };
    },
    async kill(id) { killedSandboxes.push(id); return true; },
    async listSandboxes() {
      listSandboxCalls += 1;
      return listSandboxCalls === 1 ? [] : [{
        sandboxId: "orphaned-e2b-sandbox",
        templateId: "onecomputer-template",
        metadata: { "onecomputer.workspaceId": workspaceId },
        startedAt: new Date(),
        endAt: new Date(Date.now() + 60_000),
        state: "running",
        cpuCount: 2,
        memoryMB: 4096,
        envdVersion: "1",
        diskSizeMB: 10_000,
      }];
    },
    async listVolumes() { return [{ volumeId: "vol-1", name: `oc-${workspaceId.replaceAll("-", "")}` }]; },
    async createVolume() { return { volumeId: "vol-new" }; },
    async destroyVolume(id) { destroyedVolume = id; return true; },
  };
  const adapter = new E2bSandboxAdapter({
    apiKey: "e2b-key",
    templateId: "onecomputer-template",
    egressProxyUrlTemplate: "https://egress.example.com",
  }, sdk);

  const created = await adapter.create(input());
  assert.equal(created.state, "ready");
  assert.deepEqual(createOptions?.network, {
    allowPublicTraffic: true,
    allowOut: ["egress.example.com", "models.example.com", "control.example.com"],
    denyOut: [],
  });
  assert.equal(createOptions?.secure, true);
  assert.equal(createOptions?.allowInternetAccess, true);
  assert.deepEqual(createOptions?.lifecycle, { onTimeout: "pause", autoResume: true });
  assert.equal(createOptions?.volumeMounts?.["/home/kasm-user"], `oc-${workspaceId.replaceAll("-", "")}`);
  assert.equal(createOptions?.envs?.ONECOMPUTER_SIGNED_POLICY_B64?.length > 20, true);
  assert.equal(createOptions?.envs?.HTTPS_PROXY?.startsWith("https://onecomputer:signed-egress-grant@egress.example.com/"), true);
  assert.equal(createOptions?.envs?.ONECOMPUTER_GATEWAY_CREDENTIAL, "scoped-model-credential");

  const launch = await adapter.open("e2b-sandbox-1");
  const launchUrl = new URL(launch.launchUrl);
  assert.equal(launchUrl.username, "kasm_user");
  assert.equal(launchUrl.password, "generated-vnc-secret");
  assert.equal(launchUrl.searchParams.get("clipboard_up"), "true");

  await adapter.purgeWorkspace(workspaceId);
  assert.equal(destroyedVolume, "vol-1");
  assert.deepEqual(killedSandboxes, ["orphaned-e2b-sandbox"]);
});

test("E2B exposes provider-hosted ACP chat endpoints only for granted runtimes", async () => {
  const sdk = {
    create: async () => ({
      sandboxId: "e2b-chat-sandbox",
      getHost: (port: number) => `${port}-e2b-chat-sandbox.e2b.app`,
      commands: { run: async () => ({ stdout: "" }) },
      files: { write: async () => undefined },
    }),
    connect: async () => ({
      sandboxId: "e2b-chat-sandbox",
      getHost: (port: number) => `${port}-e2b-chat-sandbox.e2b.app`,
      commands: { run: async () => ({ stdout: "" }) },
      files: { write: async () => undefined },
    }),
    listSandboxes: async () => [], listVolumes: async () => [], createVolume: async () => ({ volumeId: "v" }),
  } as unknown as E2bSdk;
  const adapter = new E2bSandboxAdapter({ apiKey: "e2b-key", templateId: "onecomputer-template", egressProxyUrlTemplate: "https://egress.example.com" }, sdk);
  const created = await adapter.create({ ...input(), chatRuntimes: [{ catalogId: "opencode-cli", key: "k".repeat(32) }] });
  assert.deepEqual(created.chatEndpoints, [{ catalogId: "opencode-cli", url: "https://8645-e2b-chat-sandbox.e2b.app" }]);
});

test("E2B rolls back resources when workspace bootstrap cannot become ready", async () => {
  let killedSandbox = "";
  let destroyedVolume = "";
  const sdk: E2bSdk = {
    async create() {
      return {
        sandboxId: "e2b-orphan-candidate",
        getHost: (port) => `${port}-e2b-orphan-candidate.e2b.app`,
        commands: {
          async run(command) {
            if (command.includes("workspace-ready")) throw new Error("workspace readiness timeout");
            return { stdout: "" };
          },
        },
        files: { async write() {} },
      };
    },
    async connect() { throw new Error("not used"); },
    async getInfo() { throw new Error("not used"); },
    async kill(id) { killedSandbox = id; return true; },
    async listSandboxes() { return []; },
    async listVolumes() { return []; },
    async createVolume() { return { volumeId: "e2b-created-volume" }; },
    async destroyVolume(id) { destroyedVolume = id; return true; },
  };
  const adapter = new E2bSandboxAdapter({
    apiKey: "e2b-key",
    templateId: "onecomputer-template",
    egressProxyUrlTemplate: "https://egress.example.com",
  }, sdk);

  await assert.rejects(adapter.create(input()), /E2B sandbox operation failed/);
  assert.equal(killedSandbox, "e2b-orphan-candidate");
  assert.equal(destroyedVolume, "e2b-created-volume");
});

test("managed providers reject Docker-local routes and missing governed egress", async () => {
  const sdk = {
    listVolumes: async () => [],
  } as unknown as E2bSdk;
  const adapter = new E2bSandboxAdapter({
    apiKey: "e2b-key",
    templateId: "onecomputer-template",
    egressProxyUrlTemplate: "https://egress.example.com",
  }, sdk);
  await assert.rejects(
    adapter.create({
      ...input(),
      gateway: { ...input().gateway!, baseUrl: "http://litellm:4000" },
    }),
    (error: unknown) => error instanceof Error && error.message.includes("provider-reachable HTTPS"),
  );
  await assert.rejects(
    adapter.create({ ...input(), egressProxy: undefined }),
    (error: unknown) => error instanceof Error && error.message.includes("policy-bound external egress proxy"),
  );
});

test("E2B retries reuse the workspace sandbox only when the policy projection matches", async () => {
  let createCalls = 0;
  const metadata = {
    "onecomputer.workspaceId": workspaceId,
    "onecomputer.policyHash": policy.policyHash,
  };
  const sdk = {
    listSandboxes: async () => [{
      sandboxId: "existing-e2b",
      templateId: "onecomputer",
      metadata,
      startedAt: new Date(),
      endAt: new Date(Date.now() + 60_000),
      state: "running",
      cpuCount: 2,
      memoryMB: 4096,
      envdVersion: "1",
      diskSizeMB: 10_000,
    }],
    create: async () => { createCalls += 1; throw new Error("must not create"); },
  } as unknown as E2bSdk;
  const adapter = new E2bSandboxAdapter({
    apiKey: "e2b-key",
    templateId: "onecomputer-template",
    egressProxyUrlTemplate: "https://egress.example.com",
  }, sdk);
  const created = await adapter.create(input());
  assert.equal(created.providerId, "existing-e2b");
  assert.equal(createCalls, 0);
});

test("Modal uses gVisor network controls, a persistent volume, secrets, readiness, and connect tokens", async () => {
  let createOptions: Parameters<ModalSdk["createSandbox"]>[2];
  let secretValues: Record<string, string> = {};
  let deletedVolume = "";
  const sandbox = {
    sandboxId: "modal-sandbox-1",
    waitUntilReady: async () => undefined,
    getTags: async () => ({
      "onecomputer.workspaceId": workspaceId,
      "onecomputer.egressVersionId": policy.egress.id,
      "onecomputer.egressHash": policy.egress.documentHash,
    }),
    createConnectToken: async () => ({ url: "https://workspace.w.modal.host", token: "modal-connect-token" }),
    terminate: async () => undefined,
    filesystem: { writeText: async () => undefined },
    exec: async () => ({ wait: async () => 0 }),
  };
  const sdk = {
    app: async () => ({ appId: "app-1" }),
    image: () => ({ imageId: "image-1" }),
    sandboxFromId: async () => sandbox,
    sandboxByName: async () => null,
    createSandbox: async (_app, _image, options) => {
      createOptions = options;
      return sandbox;
    },
    volume: async () => ({ volumeId: "volume-1" }),
    deleteVolume: async (name) => { deletedVolume = name; },
    secret: async (values) => {
      secretValues = values;
      return { secretId: "secret-1" };
    },
  } as unknown as ModalSdk;
  const adapter = new ModalSandboxAdapter({
    appName: "onecomputer",
    imageRef: "ghcr.io/onecomputer/workspace:sha256",
    egressProxyUrlTemplate: "https://egress.example.com",
  }, sdk);

  const created = await adapter.create(input());
  assert.equal(created.state, "ready");
  assert.deepEqual(createOptions?.outboundDomainAllowlist, [
    "egress.example.com",
    "models.example.com",
    "control.example.com",
  ]);
  assert.deepEqual(createOptions?.outboundCidrAllowlist, []);
  assert.equal(createOptions?.encryptedPorts?.[0], 6901);
  assert.equal(createOptions?.volumes?.["/home/kasm-user"] !== undefined, true);
  assert.equal(secretValues.ONECOMPUTER_GATEWAY_CREDENTIAL, "scoped-model-credential");

  const launch = await adapter.open("modal-sandbox-1");
  assert.equal(new URL(launch.launchUrl).searchParams.get("_modal_connect_token"), "modal-connect-token");
  await adapter.purgeWorkspace(workspaceId);
  assert.equal(deletedVolume, `oc-${workspaceId.replaceAll("-", "")}`);
});

test("Modal retries reuse a named sandbox with the same policy projection", async () => {
  let createCalls = 0;
  const existing = {
    sandboxId: "existing-modal",
    getTags: async () => ({
      "onecomputer.workspaceId": workspaceId,
      "onecomputer.policyHash": policy.policyHash,
    }),
    terminate: async () => undefined,
  };
  const sdk = {
    sandboxByName: async () => existing,
    createSandbox: async () => { createCalls += 1; throw new Error("must not create"); },
  } as unknown as ModalSdk;
  const adapter = new ModalSandboxAdapter({
    appName: "onecomputer",
    imageRef: "ghcr.io/onecomputer/workspace:sha256",
    egressProxyUrlTemplate: "https://egress.example.com",
  }, sdk);
  const created = await adapter.create(input());
  assert.equal(created.providerId, "existing-modal");
  assert.equal(createCalls, 0);
});

test("managed provider live egress rotation replaces the broker grant without exposing it in a command", async () => {
  let written = "";
  let command = "";
  const sdk = {
    connect: async () => ({
      sandboxId: "sandbox-1",
      getHost: () => "host",
      files: { write: async (_path: string, value: string) => { written = value; } },
      commands: { run: async (value: string) => { command = value; return { stdout: "" }; } },
    }),
  } as unknown as E2bSdk;
  const adapter = new E2bSandboxAdapter({
    apiKey: "e2b-key",
    templateId: "onecomputer-template",
    egressProxyUrlTemplate: "https://egress.example.com",
  }, sdk);
  await adapter.updateEgressPolicy("sandbox-1", input());
  assert.match(written, /^https:\/\/onecomputer:signed-egress-grant@egress\.example\.com\/\n$/);
  assert.equal(command.includes("signed-egress-grant"), false);
  assert.match(command, /onecomputer-egress-broker/);
});

test("E2B captures a PNG inside the sandbox boundary for VCR upload", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==", "base64");
  let captureCommand = "";
  const sdk = {
    connect: async () => ({
      sandboxId: "e2b-vcr-sandbox",
      commands: { run: async (command: string) => { captureCommand = command; return { stdout: png.toString("base64") }; } },
      files: { write: async () => undefined },
      getHost: () => "host",
    }),
  } as unknown as E2bSdk;
  const adapter = new E2bSandboxAdapter({
    apiKey: "e2b-key",
    templateId: "onecomputer-template",
    egressProxyUrlTemplate: "https://egress.example.com",
  }, sdk);
  const captured = await adapter.captureFrame("e2b-vcr-sandbox", "browser");
  assert.equal(captured.sourceApplication, "browser");
  assert.equal(captured.mimeType, "image/png");
  assert.deepEqual(Buffer.from(captured.imageBase64, "base64"), png);
  assert.match(captureCommand, /xdotool search/);
  assert.match(captureCommand, /windowactivate/);
  assert.match(captureCommand, /gnome-screenshot -w/);
});

test("E2B starts Codex/OpenCode ACP as a provider-local streaming process", async () => {
  const commands: string[] = [];
  const starts: Array<{ cwd?: string; envs?: Record<string, string>; stdin?: boolean }> = [];
  const sdk = {
    connect: async () => ({
      sandboxId: "e2b-acp-sandbox",
      commands: {
        async run(command: string, options?: { background?: boolean; cwd?: string; envs?: Record<string, string>; stdin?: boolean; onStdout?: (chunk: string) => void }) {
          commands.push(command);
          starts.push(options ?? {});
          options?.onStdout?.("{\\\"jsonrpc\\\":\\\"2.0\\\"}\\n");
          return { pid: 42, sendStdin: async () => undefined, closeStdin: async () => undefined, kill: async () => true, wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
        },
      },
      getHost: () => "host",
      files: { write: async () => undefined },
    }),
  } as unknown as E2bSdk;
  const adapter = new E2bSandboxAdapter({ apiKey: "e2b-key", templateId: "onecomputer-template", egressProxyUrlTemplate: "https://egress.example.com" }, sdk);
  const chunks: string[] = [];
  const process = await adapter.startAcp("e2b-acp-sandbox", { agentCatalogId: "opencode-cli", cwd: "/workspace/task", environment: { HOME: "/home/kasm-user" }, onStdout: (chunk) => chunks.push(chunk) });
  assert.equal(process.pid, 42);
  assert.match(commands[0]!, /opencode acp/);
  assert.equal(starts[0]?.cwd, "/workspace/task");
  assert.deepEqual(starts[0]?.envs, { HOME: "/home/kasm-user" });
  assert.equal(starts[0]?.stdin, true);
  assert.deepEqual(chunks, ["{\\\"jsonrpc\\\":\\\"2.0\\\"}\\n"]);
});
