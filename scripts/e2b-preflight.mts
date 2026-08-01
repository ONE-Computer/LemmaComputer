type JsonObject = Record<string, unknown>;

const value = (name: string) => process.env[name]?.trim() || undefined;
const required = (name: string) => {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
};

const apiKey = required("E2B_API_KEY");
const expectedTemplateId = value("E2B_TEMPLATE_ID");
const e2bApiBase = value("E2B_API_BASE_URL") ?? "https://api.e2b.app";

const response = await fetch(`${e2bApiBase.replace(/\/$/, "")}/templates`, {
  headers: { "x-api-key": apiKey, accept: "application/json" },
  signal: AbortSignal.timeout(20_000),
});
const body = await response.text();
if (!response.ok) throw new Error(`E2B template listing failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
const templates = JSON.parse(body) as unknown;
if (!Array.isArray(templates)) throw new Error("E2B template listing returned an unexpected shape");

const selected = expectedTemplateId
  ? templates.find((item) => item && typeof item === "object" && (item as JsonObject).templateID === expectedTemplateId) as JsonObject | undefined
  : undefined;
const missing = [
  "ONECOMPUTER_CONTROL_URL",
  "ONECOMPUTER_PROXY_TOKEN",
  "ONECOMPUTER_SESSION_COOKIE",
  "ONECOMPUTER_CONTROLLER_URL",
  "ONECOMPUTER_CONTROLLER_INTERNAL_TOKEN",
  "ONECOMPUTER_E2B_DENY_HOST",
  "MANAGED_SANDBOX_EGRESS_PROXY_URL_TEMPLATE",
].filter((name) => !value(name));

const report = {
  e2bApi: "reachable",
  templateCount: templates.length,
  configuredTemplate: expectedTemplateId ?? null,
  configuredTemplateState: selected ? {
    templateId: selected.templateID ?? null,
    names: Array.isArray(selected.names) ? selected.names : [],
    envdVersion: selected.envdVersion ?? null,
    buildStatus: selected.buildStatus ?? null,
    public: selected.public ?? null,
  } : null,
  missingQualificationVariables: missing,
  ready: Boolean(selected && selected.buildStatus === "ready" && !missing.length),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (!selected) {
  process.exitCode = 2;
} else if (selected.buildStatus !== "ready") {
  process.exitCode = 3;
} else if (missing.length) {
  process.exitCode = 4;
}
