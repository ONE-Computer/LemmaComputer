import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnvironment } from "./environment-template.mjs";

const stateDirectoryName = ".runtime-remote-workspace-node";
const text = (value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
const safeSlug = (value) => value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");

export const qualificationNames = (projectName) => {
  const project = safeSlug(projectName);
  return {
    nodeProject: `${project}-remote-node`,
    nodeId: `${project}-remote-node-1`,
    nodeTransportNetwork: `${project}-remote-node-transport`,
    applicationNetwork: `${project}-remote-application`,
    relayNetwork: `${project}-remote-relay-ingress`,
  };
};

export const replaceEnvironment = (contents, replacements) => {
  const seen = new Set();
  const lines = contents.trimEnd().split(/\r?\n/).map((line) => {
    const separator = line.indexOf("=");
    const key = separator === -1 ? line : line.slice(0, separator);
    if (!replacements.has(key)) return line;
    seen.add(key);
    return `${key}=${replacements.get(key)}`;
  });
  const missing = [...replacements.keys()].filter((key) => !seen.has(key));
  if (missing.length) throw new Error(`Rendered controller environment is missing: ${missing.join(", ")}`);
  return `${lines.join("\n")}\n`;
};

export const renderNodeCompose = () => `name: \${QUALIFICATION_NODE_PROJECT:?set qualification node project}

services:
  workspace-controller:
    image: lemmacomputer/control-runtime:\${LEMMACOMPUTER_IMAGE_TAG:?set image tag}
    command: ["npm", "run", "start", "--workspace", "@lemmacomputer/workspace-controller"]
    init: true
    env_file:
      - path: \${QUALIFICATION_ROOT:?set qualification root}/workspace-controller.env
        format: raw
    networks:
      node-transport:
        aliases: [workspace-node]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    read_only: true
    tmpfs: [/tmp:rw,noexec,nosuid,size=64m]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    healthcheck:
      test: ["CMD", "node", "-e", "const n=require('node:net').connect(4101,'127.0.0.1');n.once('connect',()=>{n.end();process.exit(0)}).once('error',()=>process.exit(1))"]
      interval: 3s
      timeout: 3s
      retries: 30
    restart: unless-stopped

networks:
  node-transport:
    external: true
    name: \${QUALIFICATION_NODE_TRANSPORT_NETWORK:?set node transport network}
`;

export const renderControlOverride = () => `services:
  workspace-controller:
    profiles: [remote-workspace-node-colocated-controller-disabled]

  control-api:
    environment:
      CONTROLLER_URL: https://workspace-node:4101
      CONTROLLER_TLS_CA_B64: \${QUALIFICATION_NODE_CA_B64:?set node CA}
      CONTROLLER_TLS_CLIENT_CERT_B64: \${QUALIFICATION_NODE_CLIENT_CERT_B64:?set Control client certificate}
      CONTROLLER_TLS_CLIENT_KEY_B64: \${QUALIFICATION_NODE_CLIENT_KEY_B64:?set Control client key}
      CONTROLLER_TLS_SERVER_NAME: workspace-node
      LITELLM_WORKSPACE_URL: https://application-tls:4444
      AGENT_BRIDGE_URL: https://application-tls:4443
    networks:
      node-transport: {}
    depends_on: !override
      db-migrate: { condition: service_completed_successfully }
      auth-db-migrate: { condition: service_completed_successfully }
      litellm: { condition: service_healthy }
      litellm-admin-proxy: { condition: service_healthy }
      openvtc-consent: { condition: service_healthy }

  workspace-ingress:
    environment:
      WORKSPACE_INGRESS_VERIFY_UPSTREAM_TLS: "true"
      WORKSPACE_INGRESS_TLS_CA_B64: \${QUALIFICATION_NODE_CA_B64:?set node CA}

  remote-application-tls:
    image: lemmacomputer/control-runtime:\${LEMMACOMPUTER_IMAGE_TAG:?set image tag}
    user: "0:0"
    command: ["node", "/qualification/remote-workspace-node-tls-forwarder.mjs"]
    init: true
    read_only: true
    tmpfs: [/tmp:rw,noexec,nosuid,size=16m]
    volumes:
      - ./scripts/remote-workspace-node-tls-forwarder.mjs:/qualification/remote-workspace-node-tls-forwarder.mjs:ro
      - \${QUALIFICATION_ROOT:?set qualification root}/pki:/qualification-pki:ro
    networks:
      control-private: {}
      gateway-private: {}
      remote-application:
        aliases: [application-tls]
    healthcheck:
      test: ["CMD", "node", "-e", "const n=require('node:net');const p=[4443,4444];let c=0;for(const x of p)n.connect(x,'127.0.0.1').once('connect',function(){this.end();if(++c===p.length)process.exit(0)}).once('error',()=>process.exit(1))"]
      interval: 3s
      timeout: 3s
      retries: 30
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    restart: unless-stopped

networks:
  node-transport:
    external: true
    name: \${QUALIFICATION_NODE_TRANSPORT_NETWORK:?set node transport network}
  remote-application:
    external: true
    name: \${QUALIFICATION_APPLICATION_NETWORK:?set application network}
`;

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
};

const capture = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(text(result.stderr) || `${command} ${args.join(" ")} failed`);
  return text(result.stdout).trim();
};

const pem64 = (path) => Buffer.from(readFileSync(path)).toString("base64");
const issueCertificate = ({ directory, prefix, commonName, usage, subjectAltName, serial }) => {
  execFileSync("openssl", [
    "req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${prefix}.key`, "-out", `${prefix}.csr`, "-subj", `/CN=${commonName}`,
  ], { cwd: directory, stdio: "pipe" });
  const extensions = [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    `extendedKeyUsage=${usage}`,
    ...(subjectAltName ? [`subjectAltName=${subjectAltName}`] : []),
  ].join("\n");
  writeFileSync(resolve(directory, `${prefix}.ext`), `${extensions}\n`, { mode: 0o600 });
  execFileSync("openssl", [
    "x509", "-req", "-in", `${prefix}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key",
    "-set_serial", String(serial), "-out", `${prefix}.crt`, "-days", "2", "-extfile", `${prefix}.ext`,
  ], { cwd: directory, stdio: "pipe" });
};

const generateAuthority = ({ directory, name, serverName, serverAltName, clientCommonName }) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt",
    "-subj", `/CN=lemmacomputer-${name}-qualification-ca`, "-days", "2",
  ], { cwd: directory, stdio: "pipe" });
  issueCertificate({ directory, prefix: "server", commonName: serverName, usage: "serverAuth", subjectAltName: serverAltName, serial: 1000 });
  if (clientCommonName) issueCertificate({ directory, prefix: "client", commonName: clientCommonName, usage: "clientAuth", serial: 1001 });
};

const ensureNetwork = (name, internal) => {
  const found = spawnSync("docker", ["network", "inspect", name], { stdio: "ignore" }).status === 0;
  if (!found) run("docker", ["network", "create", ...(internal ? ["--internal"] : []), name]);
};

const activeRuntimeContainers = (networkPrefix) => {
  const names = new Set();
  for (const label of [
    "com.lemmacomputer.sandbox.provider=docker-kasmvnc",
    "com.lemmacomputer.sandbox.relay=docker-kasmvnc",
    "com.lemmacomputer.egress-proxy=v2",
  ]) {
    for (const name of capture("docker", ["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}"]).split(/\r?\n/).filter(Boolean)) {
      const labels = JSON.parse(capture("docker", ["inspect", "--format", "{{json .Config.Labels}}", name]));
      if (String(labels["com.lemmacomputer.workspace-network"] ?? "").startsWith(`${networkPrefix}-`)) names.add(name);
    }
  }
  return [...names].sort();
};

const assertNoActiveRuntimes = (networkPrefix, action) => {
  const active = activeRuntimeContainers(networkPrefix);
  if (active.length) throw new Error([
    `Refusing to ${action} the workspace-node topology while ${active.length} managed runtime container${active.length === 1 ? " exists" : "s exist"}:`,
    ...active.map((name) => `  - ${name}`),
    "Stop every workspace through LemmaComputer first. Persistent workspace volumes will be retained.",
  ].join("\n"));
};

const requireCharacterDevice = (path) => {
  if (!existsSync(path) || !statSync(path).isCharacterDevice()) throw new Error(`Cowork qualification requires ${path} to be a character device`);
};

const composeArguments = (state, ...args) => [
  "compose", "--env-file", state.composeEnv, "-f", "compose.yaml", "-f", state.controlOverride, ...args,
];
const nodeComposeArguments = (state, ...args) => [
  "compose", "--env-file", state.composeEnv, "-f", state.nodeCompose, ...args,
];

const readLocalEnvironment = () => {
  if (!existsSync(".env")) throw new Error(".env is missing; run npm run worktree:init first");
  const contents = readFileSync(".env", "utf8");
  const parsed = parseEnvironment(contents);
  const value = (key) => parsed.values.get(key) ?? "";
  if (value("LEMMACOMPUTER_INSTALLATION_KIND") !== "worktree") throw new Error("Remote-node qualification is restricted to an isolated worktree profile");
  const branch = capture("git", ["branch", "--show-current"]);
  if (!branch || branch === "main") throw new Error("Remote-node qualification must run from an isolated task branch, not main");
  return { contents, value };
};

const prepareState = ({ cowork }) => {
  const environment = readLocalEnvironment();
  run(process.execPath, ["scripts/render-service-env.mjs"]);
  const root = resolve(stateDirectoryName);
  const pki = resolve(root, "pki");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const names = qualificationNames(environment.value("LEMMACOMPUTER_COMPOSE_PROJECT_NAME") || "lemmacomputer-worktree");
  const bridgeAddress = capture("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"]).trim();
  if (!bridgeAddress) throw new Error("Docker bridge has no gateway address for the local remote-node relay");
  if (cowork) {
    requireCharacterDevice("/dev/kvm");
    requireCharacterDevice("/dev/vhost-vsock");
  }

  const nodePki = resolve(pki, "node");
  const applicationPki = resolve(pki, "application");
  generateAuthority({
    directory: nodePki,
    name: "remote-node",
    serverName: "workspace-node",
    serverAltName: `DNS:workspace-node,IP:${bridgeAddress}`,
    clientCommonName: "lemmacomputer-control",
  });
  generateAuthority({
    directory: applicationPki,
    name: "remote-application",
    serverName: "application-tls",
    serverAltName: "DNS:application-tls",
  });
  for (const [source, target] of [
    [resolve(applicationPki, "server.crt"), resolve(pki, "application-server.crt")],
    [resolve(applicationPki, "server.key"), resolve(pki, "application-server.key")],
  ]) writeFileSync(target, readFileSync(source), { mode: 0o600 });

  const nodeCa = pem64(resolve(nodePki, "ca.crt"));
  const nodeServerCert = pem64(resolve(nodePki, "server.crt"));
  const nodeServerKey = pem64(resolve(nodePki, "server.key"));
  const nodeClientCert = pem64(resolve(nodePki, "client.crt"));
  const nodeClientKey = pem64(resolve(nodePki, "client.key"));
  const applicationCa = pem64(resolve(applicationPki, "ca.crt"));
  const controllerEnvironment = replaceEnvironment(readFileSync(".runtime-env/workspace-controller.env", "utf8"), new Map([
    ["CONTROLLER_HOST", "0.0.0.0"],
    ["WORKSPACE_NODE_ID", names.nodeId],
    ["WORKSPACE_NODE_TOPOLOGY", "remote"],
    ["WORKSPACE_NODE_AUTH_MODE", "mtls"],
    ["WORKSPACE_NODE_TLS_CA_B64", nodeCa],
    ["WORKSPACE_NODE_TLS_SERVER_CERT_B64", nodeServerCert],
    ["WORKSPACE_NODE_TLS_SERVER_KEY_B64", nodeServerKey],
    ["WORKSPACE_NODE_CLIENT_COMMON_NAME", "lemmacomputer-control"],
    ["WORKSPACE_RELAY_BIND_HOST", bridgeAddress],
    ["WORKSPACE_NODE_RELAY_NETWORK", names.relayNetwork],
    ["WORKSPACE_NODE_APPLICATION_NETWORK", names.applicationNetwork],
    ["WORKSPACE_NODE_APPLICATION_TLS_CA_B64", applicationCa],
    ["KASM_PUBLIC_HOST", bridgeAddress],
    ["KASM_LOCAL_KVM_ENABLED", cowork ? "true" : environment.value("LEMMACOMPUTER_KASM_LOCAL_KVM_ENABLED") || "false"],
  ]));
  const controllerEnv = resolve(root, "workspace-controller.env");
  writeFileSync(controllerEnv, controllerEnvironment, { mode: 0o600 });
  const composeEnv = resolve(root, "compose.env");
  writeFileSync(composeEnv, `${environment.contents.trimEnd()}\n${[
    `QUALIFICATION_ROOT=${root}`,
    `QUALIFICATION_NODE_PROJECT=${names.nodeProject}`,
    `QUALIFICATION_NODE_TRANSPORT_NETWORK=${names.nodeTransportNetwork}`,
    `QUALIFICATION_APPLICATION_NETWORK=${names.applicationNetwork}`,
    `QUALIFICATION_NODE_CA_B64=${nodeCa}`,
    `QUALIFICATION_NODE_CLIENT_CERT_B64=${nodeClientCert}`,
    `QUALIFICATION_NODE_CLIENT_KEY_B64=${nodeClientKey}`,
  ].join("\n")}\n`, { mode: 0o600 });
  chmodSync(composeEnv, 0o600);
  const nodeCompose = resolve(root, "node.compose.yaml");
  const controlOverride = resolve(root, "control.override.yaml");
  writeFileSync(nodeCompose, renderNodeCompose(), { mode: 0o600 });
  writeFileSync(controlOverride, renderControlOverride(), { mode: 0o600 });
  const state = {
    root, pki, composeEnv, controllerEnv, nodeCompose, controlOverride, names,
    projectName: environment.value("LEMMACOMPUTER_COMPOSE_PROJECT_NAME"),
    networkPrefix: environment.value("LEMMACOMPUTER_KASM_LOCAL_NETWORK_PREFIX"),
    webUrl: environment.value("LEMMACOMPUTER_PUBLIC_WEB_URL"),
    cowork,
  };
  writeFileSync(resolve(root, "state.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
};

const loadState = () => {
  const path = resolve(stateDirectoryName, "state.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
};

const bringUp = (state) => {
  ensureNetwork(state.names.nodeTransportNetwork, true);
  ensureNetwork(state.names.applicationNetwork, true);
  ensureNetwork(state.names.relayNetwork, false);
  run("docker", ["compose", "--env-file", ".env", "-f", "compose.yaml", "build", "control-api"]);
  run("docker", nodeComposeArguments(state, "up", "-d", "--wait", "--wait-timeout", "300"));
  run("docker", composeArguments(state, "up", "-d", "--build", "--wait", "--wait-timeout", "300"));
};

const up = ({ cowork }) => {
  const existing = loadState();
  const environment = readLocalEnvironment();
  const networkPrefix = environment.value("LEMMACOMPUTER_KASM_LOCAL_NETWORK_PREFIX");
  if (!existing) assertNoActiveRuntimes(networkPrefix, "enable remote");
  if (existing) {
    if (cowork && !existing.cowork) throw new Error("The existing qualification was created without Cowork; stop all workspaces, run down, then run up --cowork");
    bringUp(existing);
    process.stdout.write(`Remote workspace-node qualification was reapplied at ${existing.webUrl}.\n`);
    return;
  }
  const state = prepareState({ cowork });
  bringUp(state);
  process.stdout.write([
    `Remote workspace-node qualification is ready at ${state.webUrl}.`,
    "The existing worktree databases and Compose volumes were preserved.",
    cowork ? "Cowork device projection is enabled for newly started Claude Desktop workspaces." : "Use --cowork to require and enable KVM/vsock projection.",
    "Run the same command with status to inspect it, or down after stopping every workspace.",
    "",
  ].join("\n"));
};

const config = ({ cowork }) => {
  if (loadState()) throw new Error("Run status for the active qualification, or down before rendering a fresh configuration");
  const environment = readLocalEnvironment();
  assertNoActiveRuntimes(environment.value("LEMMACOMPUTER_KASM_LOCAL_NETWORK_PREFIX"), "render a different remote");
  const state = prepareState({ cowork });
  try {
    run("docker", nodeComposeArguments(state, "config", "--quiet"));
    run("docker", composeArguments(state, "config", "--quiet"));
    process.stdout.write("Remote workspace-node qualification Compose configuration is valid.\n");
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
};

const status = () => {
  const state = loadState();
  if (!state) {
    process.stdout.write("Remote workspace-node qualification is not configured in this worktree.\n");
    return;
  }
  process.stdout.write(`Remote workspace-node qualification: ${state.webUrl}\n`);
  run("docker", nodeComposeArguments(state, "ps"));
  run("docker", composeArguments(state, "ps", "control-api", "workspace-ingress", "remote-application-tls"));
};

const down = () => {
  const state = loadState();
  if (!state) {
    process.stdout.write("Remote workspace-node qualification is not configured in this worktree.\n");
    return;
  }
  assertNoActiveRuntimes(state.networkPrefix, "disable remote");
  run(process.execPath, ["scripts/render-service-env.mjs"]);
  run("docker", ["compose", "--env-file", ".env", "-f", "compose.yaml", "up", "-d", "--build", "--wait", "--wait-timeout", "300"]);
  run("docker", composeArguments(state, "rm", "-s", "-f", "remote-application-tls"));
  run("docker", nodeComposeArguments(state, "down"));
  for (const network of [state.names.nodeTransportNetwork, state.names.applicationNetwork, state.names.relayNetwork]) {
    const result = spawnSync("docker", ["network", "rm", network], { encoding: "utf8" });
    if (result.status !== 0 && !/not found/i.test(text(result.stderr))) throw new Error(text(result.stderr) || `Unable to remove network ${network}`);
  }
  rmSync(state.root, { recursive: true, force: true });
  process.stdout.write("Colocated worktree topology restored; databases and persistent Compose volumes were retained.\n");
};

export function runRemoteWorkspaceNodeQualification(args = process.argv.slice(2)) {
  const command = args.find((argument) => !argument.startsWith("--")) ?? "up";
  const cowork = args.includes("--cowork");
  if (!new Set(["config", "up", "status", "down"]).has(command)) throw new Error("Usage: npm run qualify:remote-workspace-node -- [config|up|status|down] [--cowork]");
  if (command === "config") return config({ cowork });
  if (command === "up") return up({ cowork });
  if (command === "status") return status();
  return down();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runRemoteWorkspaceNodeQualification();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
