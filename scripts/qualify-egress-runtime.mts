import { spawnSync } from "node:child_process";
import { deriveEgressProxySecret, issueEgressProxyGrant } from "@onecomputer/egress-policy";

const controllerUrl = process.env.CONTROLLER_URL ?? "http://127.0.0.1:14101";
const controllerToken = process.env.CONTROLLER_INTERNAL_TOKEN;
if (!controllerToken) throw new Error("CONTROLLER_INTERNAL_TOKEN is required");

const workspaceId = "22222222-2222-4222-8222-222222222222";
const sandboxName = `onecomputer-sandbox-${workspaceId}`;
const expectedGrant = {
  tenantId: "qualification",
  subjectId: "firewall-test",
  workspaceId,
  agentId: "agent-firewall-test",
  securityGroupVersionId: "egv_qualification_updates_v1",
  policyHash: "d".repeat(64),
};
const verificationSecret = deriveEgressProxySecret("qualification-root-secret-at-least-thirty-two-characters", workspaceId);
const token = issueEgressProxyGrant(verificationSecret, expectedGrant, new Date(), 3600);
// The egress qualification does not contact Control through the workspace
// broker, but the broker still validates that injected bridge credentials have
// the current v2 shape before it starts.
const qualificationAgentBridgeToken = `ocab2_${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 })).toString("base64url")}.${"q".repeat(43)}`;
const policy = {
  schemaVersion: 1,
  policyVersionId: "qualification-policy-v1",
  policyVersion: 1,
  policyHash: expectedGrant.policyHash,
  workspaceProfile: "claude-desktop-standard-v1",
  agentId: expectedGrant.agentId,
  agentProfile: "claude-desktop-managed-v1",
  networkProfile: "controlled-egress-v1",
  egress: {
    id: expectedGrant.securityGroupVersionId,
    securityGroupId: "esg_qualification_updates",
    version: 1,
    name: "Approved agent updates",
    description: "Isolated runtime qualification policy.",
    defaultAction: "deny",
    documentHash: "e".repeat(64),
    rules: [{
      id: "claude-downloads",
      action: "allow",
      protocol: "https",
      host: "downloads.claude.ai",
      includeSubdomains: false,
      port: 443,
      purpose: "Qualify approved update access",
    }],
  },
  clipboard: { enabled: true, localToWorkspace: true, workspaceToLocal: true, maxBytes: 65_536 },
  modelAlias: "onecomputer-claude",
  mcpServer: "onecomputer_ms365",
  allowedTools: ["list-mail-folders"],
  toolPolicies: { "list-mail-folders": "allow" },
};

const controller = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${controllerUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      "x-controller-token": controllerToken,
      ...init?.headers,
    },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Controller ${response.status}: ${JSON.stringify(body)}`);
  return body as Record<string, unknown> | null;
};

const docker = (...args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
  return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};

let providerId: string | undefined;
try {
  const created = await controller("/internal/v1/sandboxes", {
    method: "POST",
    body: JSON.stringify({
      workspaceId,
      correlationId: "v2-002-runtime-qualification",
      policy,
      gateway: {
        baseUrl: "http://litellm:4000",
        credential: "qualification-workspace-key-at-least-24-characters",
        modelAlias: "onecomputer-claude",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      agentBridge: {
        baseUrl: "http://onecomputer-control:4100",
        token: qualificationAgentBridgeToken,
      },
      egressProxy: {
        token,
        verificationSecret,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        expectedGrant,
      },
    }),
  });
  providerId = String(created?.providerId);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await controller(`/internal/v1/sandboxes/${encodeURIComponent(providerId)}`);
    if (status?.state === "ready") break;
    if (status?.state === "failed") throw new Error(`Qualification sandbox failed: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const inspect = docker("inspect", sandboxName, `${sandboxName}-egress`, "--format", "{{json .NetworkSettings.Networks}}");
  if (inspect.status !== 0) throw new Error(inspect.stderr);
  const runtimeState = docker("inspect", sandboxName, `${sandboxName}-egress`, "--format", "{{json .State}}");
  let proxyReady = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = docker("exec", `${sandboxName}-egress`, "node", "-e", "const net=require('node:net');const s=net.connect(3128,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),500)");
    if (probe.status === 0) {
      proxyReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!proxyReady) throw new Error("Egress proxy did not become ready");
  const allowed = docker("exec", sandboxName, "sh", "-lc", "curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 20 https://downloads.claude.ai/");
  const forbiddenProvider = docker("exec", sandboxName, "sh", "-lc", "curl --silent --show-error --output /dev/null --max-time 10 https://api.anthropic.com/");
  const rawIp = docker("exec", sandboxName, "sh", "-lc", "curl --silent --show-error --insecure --output /dev/null --max-time 10 https://104.18.0.1/");
  const alternatePort = docker("exec", sandboxName, "sh", "-lc", "curl --silent --show-error --output /dev/null --max-time 10 https://downloads.claude.ai:8443/");
  const direct = docker("exec", sandboxName, "sh", "-lc", "HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy= curl --silent --show-error --output /dev/null --max-time 8 https://example.com/");
  const proxyLogs = docker("logs", `${sandboxName}-egress`);
  const serializedLogs = proxyLogs.stdout + proxyLogs.stderr;
  const redact = (value: string) => value.replaceAll(token, "[grant]").replaceAll(verificationSecret, "[secret]").slice(0, 1_000);
  const result = {
    workspaceId,
    providerId,
    networks: inspect.stdout.split("\n").map((line) => JSON.parse(line)),
    runtimeState: runtimeState.stdout.split("\n").map((line) => JSON.parse(line)),
    allowed: { exitCode: allowed.status, httpStatus: allowed.stdout, error: redact(allowed.stderr) },
    denied: {
      forbiddenProvider: { exitCode: forbiddenProvider.status },
      rawIp: { exitCode: rawIp.status },
      alternatePort: { exitCode: alternatePort.status },
      directWithoutProxy: { exitCode: direct.status },
    },
    audit: {
      hasAllowedRule: serializedLogs.includes('"ruleId":"claude-downloads"'),
      hasDefaultDeny: serializedLogs.includes('"reasonCode":"EGRESS_DEFAULT_DENY"'),
      containsCredential: serializedLogs.includes(token) || serializedLogs.includes(verificationSecret),
      containsQueryOrPayload: /"query"|"payload"|"body"/.test(serializedLogs),
      startupLog: redact(serializedLogs),
    },
  };
  if (
    allowed.status !== 0
    || forbiddenProvider.status === 0
    || rawIp.status === 0
    || alternatePort.status === 0
    || direct.status === 0
    || result.audit.containsCredential
    || result.audit.containsQueryOrPayload
  ) throw new Error(`Egress qualification failed: ${JSON.stringify(result)}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  if (process.env.KEEP_QUALIFICATION_WORKSPACE !== "true") {
    if (providerId) {
      await controller(`/internal/v1/sandboxes/${encodeURIComponent(providerId)}`, { method: "DELETE" }).catch(() => undefined);
    } else {
      docker("rm", "-f", sandboxName, `${sandboxName}-egress`, `${sandboxName}-relay`);
    }
    await controller(`/internal/v1/workspaces/${workspaceId}/storage`, { method: "DELETE" }).catch(() => undefined);
    docker("network", "rm", `onecomputer-workspace-${workspaceId}`);
  }
}
