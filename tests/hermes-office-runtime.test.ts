import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const execFileAsync = promisify(execFile);

test("the pinned Hermes runtime forwards each AI usage binding without shared state", async () => {
  const [dockerfile, patch, desktopPatch, chatAdapter] = await Promise.all([
    source("docker/Dockerfile.workspace"),
    source("docker/workspace/hermes-agent-lemmacomputer.patch"),
    source("docker/workspace/hermes-desktop-governed-effort.patch"),
    source("docker/workspace/lemmacomputer-agent-chat.py"),
  ]);
  assert.match(dockerfile, /HERMES_AGENT_TAG=v2026\.7\.20/);
  assert.match(dockerfile, /HERMES_AGENT_SHA256=285f3fc134ff466a90065e1517801a68993733b807158ee8f32aa01613786990/);
  assert.match(
    dockerfile,
    /patch --batch --forward --fuzz=0 -d \/opt\/lemmacomputer\/hermes-agent -p1 < \/tmp\/hermes-agent-lemmacomputer\.patch/,
  );
  assert.match(
    dockerfile,
    /patch --batch --forward --fuzz=0 -d \/src -p1 < \/tmp\/hermes-desktop-governed-effort\.patch/,
  );
  assert.match(desktopPatch, /\['low', 'medium', 'high'\]/);
  assert.match(desktopPatch, /provider === 'custom' && model\.startsWith\('lemmacomputer-'\)/);

  const additions = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  assert.match(additions, /_parse_ai_usage_task_binding_header/);
  assert.match(additions, /not 32 <= len\(raw\) <= 4096/);
  assert.match(additions, /runtime_kwargs\.pop\("request_overrides", None\)/);
  assert.match(additions, /request_overrides = dict\(raw_request_overrides or \{\}\)/);
  assert.match(additions, /extra_headers = dict\(raw_extra_headers or \{\}\)/);
  assert.match(additions, /extra_headers\[self\._AI_USAGE_TASK_BINDING_HEADER\] = usage_task_binding/);
  assert.match(additions, /request_overrides=request_overrides or None/);
  assert.equal(
    additions.match(/usage_task_binding=usage_task_binding/g)?.length,
    3,
    "sync, stream, and executor-to-agent boundaries must each forward the request-local value",
  );
  assert.doesNotMatch(additions, /ContextVar|os\.environ[^\n]*AI_USAGE_TASK_BINDING|self\.usage_task_binding/);

  assert.match(chatAdapter, /"x-lemmacomputer-ai-task-binding": usage_task_binding/);
  assert.match(chatAdapter, /f"\{HERMES_URL\}\/api\/sessions\/\{vendor_session_id\}\/chat\/stream"/);
});

test("the pinned Hermes browser runtime binds a verified identity only to the request-local agent run", async () => {
  const [dockerfile, patch, activityPatch, identityHelper, chatAdapter] = await Promise.all([
    source("docker/Dockerfile.workspace"),
    source("docker/workspace/hermes-agent-instance.patch"),
    source("docker/workspace/hermes-agent-activity.patch"),
    source("docker/workspace/lemmacomputer_hermes_mcp_identity.py"),
    source("docker/workspace/lemmacomputer-agent-chat.py"),
  ]);
  assert.match(
    dockerfile,
    /patch --batch --forward --fuzz=0 -d \/opt\/lemmacomputer\/hermes-agent -p1 < \/tmp\/hermes-agent-instance\.patch/,
  );
  const additions = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  assert.match(additions, /_parse_agent_instance_id_header/);
  assert.match(additions, /parsed\.version != 4 or str\(parsed\) != raw/);
  assert.match(additions, /LEMMACOMPUTER_AGENT_INSTANCE_ID.*_AGENT_INSTANCE_ID/);
  assert.match(additions, /agent_instance_id=agent_instance_id or ""/);
  assert.match(additions, /agent_instance_id=agent_instance_id/);
  assert.match(additions, /extra_headers\[self\._AGENT_INSTANCE_ID_HEADER\] = agent_instance_id/);
  assert.match(additions, /agent_instance_meta = capture_agent_instance_meta\(\)/);
  assert.match(additions, /session\.call_tool\([\s\S]*meta=agent_instance_meta/);
  assert.doesNotMatch(identityHelper, /os\.environ(?:\[|\.get)/);
  assert.match(identityHelper, /get_session_env/);
  assert.match(identityHelper, /parsed\.version != 4 or str\(parsed\) != raw/);
  assert.match(identityHelper, /\{"lemmacomputer": \{"agentInstanceId": raw\}\}/);
  assert.match(activityPatch, /tool_activity_event\(event_type, kwargs\.get\("is_error"\)\)/);
  assert.match(dockerfile, /patch --batch --forward --fuzz=0 -d \/opt\/lemmacomputer\/hermes-agent -p1 < \/tmp\/hermes-agent-activity\.patch/);
  assert.match(dockerfile, /HERMES_IDENTITY_SITE_PACKAGES=.*sysconfig\.get_paths\(\)\["purelib"\]/);
  assert.match(
    dockerfile,
    /\$\{HERMES_IDENTITY_SITE_PACKAGES\}\/lemmacomputer_hermes_mcp_identity\.py/,
    "the no-editable Hermes runtime must install the product helper into its virtualenv",
  );
  assert.match(
    dockerfile,
    /cd \/home\/kasm-user[\s\S]+python -c 'import lemmacomputer_hermes_mcp_identity'/,
    "the image build must prove the helper imports away from the Hermes source tree",
  );
  assert.match(chatAdapter, /"x-lemmacomputer-agent-instance-id": agent_instance_id/);
  assert.match(additions, /os\.environ\.get\("LEMMACOMPUTER_AGENT_INSTANCE_ID"/);
});

test("Hermes MCP metadata stays turn-local and malformed identities fail closed", async () => {
  const helperPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../docker/workspace/lemmacomputer_hermes_mcp_identity.py",
  );
  const program = String.raw`
import asyncio
import contextvars
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("identity", sys.argv[1])
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)
current = contextvars.ContextVar("current", default="")

def read_session_value(name, default=""):
    assert name == "LEMMACOMPUTER_AGENT_INSTANCE_ID"
    return current.get() or default

async def capture(value):
    token = current.set(value)
    try:
        await asyncio.sleep(0)
        return identity.capture_agent_instance_meta(read_session_value)
    finally:
        current.reset(token)

async def main():
    first = "11111111-1111-4111-8111-111111111111"
    second = "22222222-2222-4222-8222-222222222222"
    concurrent = await asyncio.gather(capture(first), capture(second))
    missing = await capture("")
    malformed = None
    try:
        await capture("11111111-1111-1111-8111-111111111111")
    except ValueError as error:
        malformed = str(error)
    print(json.dumps({"concurrent": concurrent, "missing": missing, "malformed": malformed}))

asyncio.run(main())
`;
  const { stdout } = await execFileAsync("python3", ["-c", program, helperPath]);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.concurrent, [
    { lemmacomputer: { agentInstanceId: "11111111-1111-4111-8111-111111111111" } },
    { lemmacomputer: { agentInstanceId: "22222222-2222-4222-8222-222222222222" } },
  ]);
  assert.equal(result.missing, null);
  assert.equal(result.malformed, "invalid agent instance identity");
});

test("Hermes Activity reports returned MCP errors as failed", async () => {
  const helperPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../docker/workspace/lemmacomputer_hermes_mcp_identity.py",
  );
  const program = String.raw`
import importlib.util
import json
import sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("identity", sys.argv[1])
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)
print(json.dumps({
    "started": identity.tool_activity_event("tool.started"),
    "completed": identity.tool_activity_event("tool.completed", False),
    "failed_result": identity.tool_activity_event("tool.completed", True),
    "explicit_failed": identity.tool_activity_event("tool.failed", False),
}))
`;
  const { stdout } = await execFileAsync("python3", ["-c", program, helperPath]);
  assert.deepEqual(JSON.parse(stdout), {
    started: "tool.started",
    completed: "tool.completed",
    failed_result: "tool.failed",
    explicit_failed: "tool.failed",
  });
});

test("the Hermes API cannot report ready before the required connector MCP is registered", async () => {
  const [patch, entrypoint, chatAdapter, workspaceDockerfile] = await Promise.all([
    source("docker/workspace/hermes-agent-lemmacomputer.patch"),
    source("docker/workspace/lemmacomputer-workspace-entrypoint.sh"),
    source("docker/workspace/lemmacomputer-agent-chat.py"),
    source("docker/Dockerfile.workspace"),
  ]);
  const additions = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");

  assert.match(entrypoint, /LEMMACOMPUTER_REQUIRED_MCP_SERVER=lemmacomputer_connectors/);
  assert.match(additions, /def _required_mcp_server_readiness\(\)/);
  assert.match(additions, /get_mcp_status/);
  assert.match(additions, /LEMMACOMPUTER_REQUIRED_MCP_SERVER/);
  assert.match(additions, /for attempt in range\(1, 6\)/);
  assert.match(additions, /Required MCP server did not register tools/);
  assert.match(additions, /"required_mcp_unavailable"/);
  assert.match(additions, /status=503/);
  assert.match(additions, /"required_mcp": required_mcp/);
  assert.doesNotMatch(additions, /"server": required_server/);

  assert.match(chatAdapter, /f"\{HERMES_URL\}\/health\/detailed"/);
  assert.match(chatAdapter, /"required_mcp"/);
  assert.match(chatAdapter, /"hermes_connectors_unavailable"/);
  assert.match(
    workspaceDockerfile,
    /hermes-gateway\.pid[\s\S]+127\.0\.0\.1:8652\/health[\s\S]+hermes-claw-chat\.pid[\s\S]+\/dev\/tcp\/127\.0\.0\.1\/8642/,
  );
});

test("the workspace image pins the Hermes Office skills and their native runtimes", async () => {
  const [dockerfile, requirements, nodePackage, nodeLock, entrypoint] = await Promise.all([
    source("docker/Dockerfile.workspace"),
    source("docker/workspace/hermes-office-requirements.txt"),
    source("docker/workspace/hermes-office-node/package.json"),
    source("docker/workspace/hermes-office-node/package-lock.json"),
    source("docker/workspace/lemmacomputer-workspace-entrypoint.sh"),
  ]);

  assert.match(dockerfile, /HERMES_OFFICE_SKILLS_COMMIT=a606d24cf2a9d1137d77fd92e7da459c89947fbd/);
  assert.match(dockerfile, /HERMES_OFFICE_SKILLS_SHA256=c379fc38badf3bc31938be80c15aa3a13bc6c4bb3b852902e5d988676763c20c/);
  assert.match(dockerfile, /NODE_VERSION=22\.23\.1/);
  assert.match(dockerfile, /NODE_SHA256=9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578/);

  for (const skill of ["docx", "pdf", "powerpoint", "xlsx", "ocr-and-documents"]) {
    assert.match(
      dockerfile,
      new RegExp(`hermes-office-skills/skills/productivity/${skill} /opt/lemmacomputer/hermes-agent/skills/productivity/${skill}`),
    );
    assert.match(
      dockerfile,
      new RegExp(`/opt/lemmacomputer/hermes-agent/skills/productivity/${skill}/SKILL\\.md`),
    );
  }

  for (const aptPackage of [
    "libreoffice",
    "pandoc",
    "poppler-utils",
    "qpdf",
    "tesseract-ocr",
    "unzip",
    "zip",
  ]) {
    assert.match(dockerfile, new RegExp(`\\s${aptPackage}\\s`));
  }
  assert.match(dockerfile, /lemmacomputer-libreoffice/);
  assert.match(dockerfile, /command -v npm soffice libreoffice pandoc pdftoppm pdftotext qpdf tesseract unzip zip/);
  assert.match(dockerfile, /soffice --headless --version/);
  assert.match(entrypoint, /remove_stale_libreoffice_lock\(\)/);
  assert.match(entrypoint, /pgrep -u 1000 -f '\/usr\/lib\/libreoffice\/program\/\(oosplash\|soffice\\\.bin\)'/);
  assert.match(entrypoint, /rm -f -- "\$office_profile\/\.lock"/);
  assert.match(entrypoint, /remove_stale_libreoffice_lock/);
  assert.match(dockerfile, /hermes-office-venv/);
  assert.match(dockerfile, /hermes-office-requirements\.txt/);

  for (const requirement of [
    "defusedxml",
    "lxml",
    "markitdown[pptx,xlsx]",
    "openpyxl",
    "pandas",
    "pdf2image",
    "pdfplumber",
    "pillow",
    "pymupdf",
    "pymupdf4llm",
    "pypdf",
    "pytesseract",
    "python-docx",
    "python-pptx",
    "reportlab",
  ]) {
    assert.match(requirements.toLowerCase(), new RegExp(`^${requirement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}==`, "m"));
  }

  const packageJson = JSON.parse(nodePackage);
  const packageLock = JSON.parse(nodeLock);
  assert.deepEqual(packageJson.dependencies, {
    docx: "9.7.1",
    pptxgenjs: "4.0.1",
    react: "19.2.8",
    "react-dom": "19.2.8",
    "react-icons": "5.7.0",
    sharp: "0.35.3",
  });
  assert.deepEqual(packageLock.packages[""].dependencies, packageJson.dependencies);
});

test("selected Hermes profiles seed reviewed skills by default and expose the mode-appropriate tools", async () => {
  const [entrypoint, profileConfig, cliLauncher, desktopLauncher, chatAdapter] = await Promise.all([
    source("docker/workspace/lemmacomputer-workspace-entrypoint.sh"),
    source("docker/workspace/lemmacomputer-hermes-config.py"),
    source("docker/workspace/lemmacomputer-hermes"),
    source("docker/workspace/lemmacomputer-hermes-desktop"),
    source("docker/workspace/lemmacomputer-agent-chat.py"),
  ]);

  assert.match(entrypoint, /sync_hermes_skills\(\)/);
  assert.match(entrypoint, /from tools\.skills_sync import sync_skills; sync_skills\(quiet=True\)/);
  assert.match(entrypoint, /sync_hermes_skills \/home\/kasm-user\/\.hermes/);
  assert.match(entrypoint, /sync_hermes_skills \/home\/kasm-user\/\.hermes-desktop/);
  assert.match(entrypoint, /sync_hermes_skills \/home\/kasm-user\/\.hermes \\\n+  && install_agent_skill \/home\/kasm-user\/\.hermes/);
  assert.match(entrypoint, /sync_hermes_skills \/home\/kasm-user\/\.hermes-desktop \\\n+  && install_agent_skill \/home\/kasm-user\/\.hermes-desktop/);
  assert.match(entrypoint, /HERMES_BUNDLED_SKILLS=\/opt\/lemmacomputer\/hermes-agent\/skills/);
  assert.match(entrypoint, /lemmacomputer-hermes-config/);
  assert.match(entrypoint, /LEMMACOMPUTER_CONNECTOR_RECOVERY_STATE_FILE="\/home\/kasm-user\/\.hermes\/\.lemmacomputer-connectors-recovery\.json"/);
  assert.match(profileConfig, /OFFICE_DEFAULT_SKILLS = frozenset/);
  assert.match(profileConfig, /LEMMACOMPUTER_CONNECTOR_RECOVERY_DEADLINE_SECONDS/);
  assert.match(chatAdapter, /"hermes_connectors_recovery_exhausted"/);
  assert.match(profileConfig, /REVIEWED_DEFAULT_SKILLS = OFFICE_DEFAULT_SKILLS \| frozenset\(\{"make-a-site"}\)/);
  for (const skill of ["docx", "pdf", "powerpoint", "xlsx", "ocr-and-documents"]) {
    assert.match(profileConfig, new RegExp(`"${skill}"`));
  }
  assert.match(profileConfig, /current_bundled - previous_bundled/);
  assert.match(profileConfig, /disabled\.update\(skills_to_default_off - REVIEWED_DEFAULT_SKILLS\)/);
  assert.match(profileConfig, /existing\.get\("skills"\)/);
  assert.match(profileConfig, /SKILL_STATE_FILE = "\.lemmacomputer-skill-defaults\.json"/);
  assert.match(profileConfig, /managed_office_toolsets = \["file", "skills", "terminal", "vision"\]/);
  assert.match(profileConfig, /cli_toolsets = \["hermes-cli", "lemmacomputer_connectors"\]/);
  assert.match(profileConfig, /api_toolsets = \["hermes-api-server", "lemmacomputer_connectors"\]/);
  assert.match(profileConfig, /managed_office_tools\.isdisjoint\(resolve_toolset\(name\)\)/);

  for (const launcher of [cliLauncher, desktopLauncher]) {
    assert.match(launcher, /HERMES_BUNDLED_SKILLS=\/opt\/lemmacomputer\/hermes-agent\/skills/);
    assert.match(launcher, /PATH=\/opt\/lemmacomputer\/hermes-office-venv\/bin:/);
    assert.match(launcher, /NODE_PATH=\/opt\/lemmacomputer\/hermes-office-node\/node_modules/);
  }
  assert.match(desktopLauncher, /HERMES_DESKTOP_PYTHON=\/opt\/lemmacomputer\/hermes-venv\/bin\/python/);

  assert.match(chatAdapter, /Hermes has workspace-local file, terminal, skills, and vision tools/);
  assert.match(chatAdapter, /public-web and unrelated native toolsets remain restricted/);
  assert.match(chatAdapter, /Invoke an assigned MCP tool directly/);
  assert.match(chatAdapter, /path as localFilePath; do not read or base64-encode/);
  assert.match(chatAdapter, /ATTACHMENT_ROOT = STATE_DIR \/ "attachments"/);
  assert.match(chatAdapter, /ATTACHMENT_INBOX_ROOT = HOME \/ "LemmaComputer" \/ "Inbox"/);
  assert.match(chatAdapter, /LEMMACOMPUTER_CHAT_ATTACHMENT_RETENTION_DAYS/);
  assert.match(chatAdapter, /def persist_attachment\(filename: str, media_type: str, data: bytes, source: str\)/);
  assert.match(chatAdapter, /os\.O_EXCL \| getattr\(os, "O_NOFOLLOW", 0\)/);
  assert.match(chatAdapter, /"originalFilename": filename/);
  assert.match(chatAdapter, /os\.symlink\(path, visible_path\)/);
  assert.match(chatAdapter, /part\.get\("type"\) == "data-file-reference"/);
  assert.doesNotMatch(chatAdapter, /persisted_parts\.append\(\{\s*"type": "file",[\s\S]*?"url": url/);
  assert.match(chatAdapter, /"workspacePath": workspace_path/);
  assert.match(chatAdapter, /pass the exact workspace path below as localFilePath/);
  assert.match(chatAdapter, /Treat greetings, acknowledgements, small talk/);
  assert.match(chatAdapter, /Do not load or invoke a skill for those messages/);
  assert.match(chatAdapter, /concrete task clearly matches that skill's documented scope/);
  assert.match(chatAdapter, /Before using any tool, briefly tell the employee/);
  assert.match(chatAdapter, /\/chat\/stream/);
  assert.doesNotMatch(chatAdapter, /Got it — I’m working on that\./);
  assert.match(chatAdapter, /configured IANA timezone/);
  assert.match(chatAdapter, /Before a calendar write/);
});

test("chat attachments retain original metadata, appear in the workspace Inbox, and expire together", async () => {
  const chatAdapter = await source("docker/workspace/lemmacomputer-agent-chat.py");
  const functions = chatAdapter.slice(
    chatAdapter.indexOf("def cleanup_expired_attachments"),
    chatAdapter.indexOf("def validate_user_message"),
  );
  const home = await mkdtemp(path.join(tmpdir(), "lemmacomputer-attachment-test-"));
  const program = `
import hashlib, json, os, re, shutil, sys, time, uuid
from pathlib import Path
from typing import Any
HOME = Path(sys.argv[1])
ATTACHMENT_ROOT = HOME / ".lemmacomputer-chat" / "hermes-claw" / "attachments"
ATTACHMENT_INBOX_ROOT = HOME / "LemmaComputer" / "Inbox"
ATTACHMENT_RETENTION_DAYS = 1
def now(): return "2026-07-29T00:00:00Z"
${functions}
stored = Path(persist_attachment("Business Overview.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", b"deck-bytes", "telegram"))
manifest = json.loads((stored.parent / "manifest.json").read_text())
visible = Path(manifest["inboxPath"])
result = {"stored": stored.exists(), "visible": visible.is_symlink(), "target": visible.resolve() == stored, "manifest": manifest}
os.utime(stored.parent, (0, 0))
cleanup_expired_attachments()
result["expired"] = not stored.parent.exists() and not visible.parent.exists()
print(json.dumps(result))
`;
  try {
    const { stdout } = await execFileAsync("python3", ["-c", program, home]);
    const result = JSON.parse(stdout);
    assert.equal(result.stored, true);
    assert.equal(result.visible, true);
    assert.equal(result.target, true);
    assert.equal(result.expired, true);
    assert.equal(result.manifest.originalFilename, "Business Overview.pptx");
    assert.equal(result.manifest.source, "telegram");
    assert.equal(result.manifest.byteLength, 10);
    assert.match(result.manifest.inboxPath, /LemmaComputer\/Inbox\/Telegram/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Telegram deliverables are snapshotted from a bounded Outbox into immutable artifact storage", async () => {
  const chatAdapter = await source("docker/workspace/lemmacomputer-agent-chat.py");
  const functions = chatAdapter.slice(chatAdapter.indexOf("def snapshot_outbox"), chatAdapter.indexOf("def validate_user_message"));
  const home = await mkdtemp(path.join(tmpdir(), "lemmacomputer-outbox-test-"));
  const program = `
import hashlib, json, os, re, shutil, stat, sys, time, uuid
from pathlib import Path
from typing import Any
HOME = Path(sys.argv[1])
STATE_DIR = HOME / ".lemmacomputer-chat" / "hermes-claw"
ARTIFACT_ROOT = STATE_DIR / "artifacts"
ARTIFACT_OUTBOX_ROOT = HOME / "LemmaComputer" / "Outbox"
ATTACHMENT_RETENTION_DAYS = 1
MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
MAX_TOTAL_ARTIFACT_BYTES = 100 * 1024 * 1024
MAX_ATTACHMENTS = 4
ARTIFACT_MEDIA_TYPES = {".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"}
def attachment_text(media_type, data): return None
def now(): return "2026-07-30T00:00:00Z"
def write_attachment_manifest(path, document): path.write_text(json.dumps(document))
${functions}
before = snapshot_outbox()
deliverable = ARTIFACT_OUTBOX_ROOT / "Board Update.pptx"
deliverable.write_bytes(b"valid-generated-deck")
artifacts, notice = persist_outbox_artifacts(before)
manifest = json.loads((ARTIFACT_ROOT / artifacts[0]["artifactId"] / "manifest.json").read_text())
second, second_notice = persist_outbox_artifacts(snapshot_outbox())
result = {"artifacts": artifacts, "notice": notice, "manifest": manifest, "second": second, "secondNotice": second_notice,
  "stored": (ARTIFACT_ROOT / artifacts[0]["artifactId"] / "Board Update.pptx").read_bytes().decode()}
print(json.dumps(result))
`;
  try {
    const { stdout } = await execFileAsync("python3", ["-c", program, home]);
    const result = JSON.parse(stdout);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].filename, "Board Update.pptx");
    assert.equal(result.artifacts[0].byteLength, 20);
    assert.equal(result.stored, "valid-generated-deck");
    assert.equal(result.notice, null);
    assert.deepEqual(result.second, []);
    assert.equal(result.manifest.sha256, result.artifacts[0].sha256);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("governed Calendar discovery advertises only argument shapes Control allows", async () => {
  const bridge = await source("docker/workspace/lemmacomputer-connectors-stdio.py");
  const schemas = bridge.slice(bridge.indexOf("BOUNDED_LIST_INPUT_PROPERTIES"), bridge.indexOf("LIST_DRIVES_INPUT_SCHEMA"));

  assert.match(schemas, /CALENDAR_VIEW_INPUT_SCHEMA/);
  assert.match(schemas, /LIST_CALENDAR_EVENTS_INPUT_SCHEMA/);
  assert.match(schemas, /"additionalProperties": False/);
  assert.doesNotMatch(schemas, /fetchAllPages|includeHeaders|expandExtendedProperties|"expand"/);
  assert.doesNotMatch(schemas, /"filter"|"search"|"orderby"|"skip"|"select"|"count"/);
  assert.match(schemas, /"required": \["startDateTime", "endDateTime"\]/);
  assert.match(bridge, /MS365_READ_INPUT_SCHEMAS = \{/);
  assert.match(bridge, /"get-calendar-view": CALENDAR_VIEW_INPUT_SCHEMA/);
  assert.match(bridge, /input_schema = effective_ms365_input_schema\(upstream_name\)/);
});

test("governed OneDrive deletion carries the resolved filename into approval metadata", async () => {
  const [bridge, broker, control] = await Promise.all([
    source("docker/workspace/lemmacomputer-connectors-stdio.py"),
    source("docker/workspace/lemmacomputer-gateway-proxy.py"),
    source("apps/control-api/src/server.ts"),
  ]);

  assert.match(bridge, /"required": \["driveId", "driveItemId", "resourceName", "If-Match"\]/);
  assert.match(bridge, /exact name as resourceName/);
  assert.match(bridge, /request_json\("\/lemmacomputer\/deletions"/);
  assert.match(broker, /\/internal\/v1\/agent\/deletions/);
  assert.match(control, /safeSummary: `Delete \$\{input\.resourceName\} from OneDrive`/);
  assert.match(control, /resourceName: input\.resourceName/);
});
