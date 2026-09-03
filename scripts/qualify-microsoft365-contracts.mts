import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { canonicalJson, m365ToolCatalog } from "@lemmacomputer/contracts";
import { m365CapabilityDefinitions, m365ControlInputSchemas } from "../apps/control-api/src/mcp-policy.js";

const execFileAsync = promisify(execFile);
const evidencePath = new URL("../config/product-policy/microsoft365-tool-contract-evidence.v1.json", import.meta.url);
const upstreamRoot = new URL("../integrations/ms365-mcp/", import.meta.url);

const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

const packageDocument = JSON.parse(await readFile(new URL("package.json", upstreamRoot), "utf8"));
const lockDocument = JSON.parse(await readFile(new URL("package-lock.json", upstreamRoot), "utf8"));
const packageName = "@softeria/ms-365-mcp-server";
const pinnedVersion = packageDocument.dependencies?.[packageName];
const locked = lockDocument.packages?.[`node_modules/${packageName}`];
assert.equal(typeof pinnedVersion, "string", "Microsoft 365 connector dependency must be pinned");
assert.equal(locked?.version, pinnedVersion, "package.json and package-lock.json must pin the same connector version");

let upstreamEndpoints: Array<Record<string, unknown>>;
let upstreamGraphToolsSource: string;
try {
  upstreamEndpoints = JSON.parse(await readFile(new URL(
    `node_modules/${packageName}/dist/endpoints.json`,
    upstreamRoot,
  ), "utf8"));
  upstreamGraphToolsSource = await readFile(new URL(
    `node_modules/${packageName}/dist/graph-tools.js`,
    upstreamRoot,
  ), "utf8");
} catch {
  throw new Error("Install the pinned upstream definitions first: npm ci --prefix integrations/ms365-mcp");
}

const names = Object.keys(m365ToolCatalog).sort();
const localTools = new Set(["list-approved-sharepoint-sites"]);
const upstreamUtilityTools = new Set(["download-bytes"]);
const evaluationFixture = JSON.parse(await readFile(new URL(
  "../tests/fixtures/microsoft365-tool-contract-evaluations.v1.json",
  import.meta.url,
), "utf8"));
assert.deepEqual(evaluationFixture.agents, ["claude", "codex", "hermes"]);
const upstreamDefinitions = Object.fromEntries(names.map((name) => {
  if (localTools.has(name)) {
    return [name, { source: "lemmacomputer-control-local", toolName: name }];
  }
  if (upstreamUtilityTools.has(name)) {
    const marker = `    name: "${name}",`;
    const markerIndex = upstreamGraphToolsSource.indexOf(marker);
    assert.notEqual(markerIndex, -1, `expected pinned upstream utility definition for ${name}`);
    const start = upstreamGraphToolsSource.lastIndexOf("  {", markerIndex);
    const end = upstreamGraphToolsSource.indexOf("\n  },\n  {", markerIndex);
    assert.notEqual(start, -1, `expected start of pinned upstream utility definition for ${name}`);
    assert.notEqual(end, -1, `expected end of pinned upstream utility definition for ${name}`);
    return [name, {
      source: `node_modules/${packageName}/dist/graph-tools.js`,
      definition: upstreamGraphToolsSource.slice(start, end + 4),
    }];
  }
  const matches = upstreamEndpoints.filter((endpoint) => endpoint.toolName === name);
  assert.equal(matches.length, 1, `expected one pinned upstream definition for ${name}`);
  return [name, matches[0]];
}));

const { stdout } = await execFileAsync("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, LEMMACOMPUTER_PRINT_MS365_CONTRACTS: "1" },
  maxBuffer: 16 * 1024 * 1024,
});
const bridge = JSON.parse(stdout);
assert.equal(bridge.version, 1);
assert.deepEqual(Object.keys(bridge.tools).sort(), names, "every product tool needs one bridge profile");

const forbidden = new Set(["filter", "search", "orderby", "skip", "count", "fetchAllPages", "expand", "expandExtendedProperties"]);
for (const [name, profile] of Object.entries(bridge.tools) as Array<[string, { inputSchema: { properties?: Record<string, unknown>; additionalProperties?: boolean } }]>) {
  assert.equal(profile.inputSchema.additionalProperties, false, `${name} must reject additional arguments`);
  for (const property of Object.keys(profile.inputSchema.properties ?? {})) {
    assert.equal(forbidden.has(property), false, `${name} exposes unqualified raw Graph field ${property}`);
  }
}
assert.deepEqual(
  Object.keys(bridge.tools["get-calendar-view"].inputSchema.properties).sort(),
  ["endDateTime", "startDateTime", "timezone", "top"],
  "calendar view must expose only its canonical bounded window contract",
);
for (const evaluation of evaluationFixture.cases ?? []) {
  const sequence = evaluation.expectedSequence ?? [];
  for (const toolName of sequence) {
    assert.ok(names.includes(toolName), `${evaluation.id} references an unqualified tool ${toolName}`);
  }
  const fields = new Set(sequence.flatMap((toolName: string) =>
    Object.keys(bridge.tools[toolName].inputSchema.properties ?? {})));
  for (const required of evaluation.requiredArguments ?? []) {
    assert.ok(fields.has(required), `${evaluation.id} does not exercise required field ${required}`);
  }
  for (const forbiddenArgument of evaluation.forbiddenArguments ?? []) {
    assert.equal(fields.has(forbiddenArgument), false,
      `${evaluation.id} advertises forbidden field ${forbiddenArgument}`);
  }
}

const control = Object.fromEntries(names.map((name) => {
  const capability = m365CapabilityDefinitions[name as keyof typeof m365CapabilityDefinitions];
  assert.ok(capability, `Control is missing the ${name} capability`);
  const inputSchema = m365ControlInputSchemas[name as keyof typeof m365ControlInputSchemas];
  assert.ok(inputSchema, `Control is missing the ${name} input schema`);
  const bridgeSchema = bridge.tools[name].inputSchema;
  assert.equal(inputSchema.additionalProperties, false, `Control ${name} must reject additional arguments`);
  const controlProperties = Object.keys(inputSchema.properties ?? {}).sort();
  const bridgeProperties = Object.keys(bridgeSchema.properties ?? {}).sort();
  if (name === "upload-file-content") {
    assert.deepEqual(
      bridgeProperties.filter((field) => field !== "localFilePath"),
      controlProperties,
      "the workspace-local upload extension must be the only bridge/Control field difference",
    );
  } else if (name === "delete-onedrive-file") {
    assert.deepEqual(
      bridgeProperties.filter((field) => field !== "resourceName"),
      controlProperties.filter((field) => field !== "confirm"),
      "the governed deletion audit name must be the only bridge/Control field difference",
    );
  } else {
    assert.deepEqual(bridgeProperties, controlProperties, `${name} bridge and Control fields drifted`);
  }
  const controlRequired = (inputSchema.required ?? [])
    .filter((field: string) => name !== "upload-file-content" || field !== "body")
    .sort();
  const bridgeRequired = (bridgeSchema.required ?? [])
    .filter((field: string) => name !== "upload-file-content" || field !== "localFilePath")
    .filter((field: string) => name !== "delete-onedrive-file" || field !== "resourceName")
    .sort();
  assert.deepEqual(
    bridgeRequired,
    controlRequired,
    `${name} bridge and Control required fields drifted`,
  );
  return [name, { schemaId: capability.schemaId, schemaHash: capability.schemaHash, inputSchema }];
}));

const evidence = {
  schemaVersion: 1,
  contractVersion: bridge.version,
  toolCount: names.length,
  evaluationFixtureHash: sha256(evaluationFixture),
  upstream: {
    package: packageName,
    version: pinnedVersion,
    integrity: locked.integrity,
    definitionsHash: sha256(upstreamDefinitions),
    toolDefinitionHashes: Object.fromEntries(names.map((name) => [name, sha256(upstreamDefinitions[name])])),
  },
  effective: {
    bridgeHash: sha256(bridge),
    controlHash: sha256(control),
    combinedHash: sha256({ bridge, control }),
  },
};

if (process.argv.includes("--write")) {
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
  console.log(`Wrote ${evidencePath.pathname}`);
} else {
  const expected = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(canonicalJson(evidence), canonicalJson(expected),
    "Microsoft 365 upstream or effective contract drifted; review the diff and regenerate evidence explicitly");
  console.log(`Qualified ${names.length} Microsoft 365 tool contracts at v${bridge.version}.`);
}
