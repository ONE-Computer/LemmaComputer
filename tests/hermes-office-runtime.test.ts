import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const execFileAsync = promisify(execFile);

test("the workspace image pins the Hermes Office skills and their native runtimes", async () => {
  const [dockerfile, requirements, nodePackage, nodeLock] = await Promise.all([
    source("docker/Dockerfile.workspace"),
    source("docker/workspace/hermes-office-requirements.txt"),
    source("docker/workspace/hermes-office-node/package.json"),
    source("docker/workspace/hermes-office-node/package-lock.json"),
  ]);

  assert.match(dockerfile, /HERMES_OFFICE_SKILLS_COMMIT=a606d24cf2a9d1137d77fd92e7da459c89947fbd/);
  assert.match(dockerfile, /HERMES_OFFICE_SKILLS_SHA256=c379fc38badf3bc31938be80c15aa3a13bc6c4bb3b852902e5d988676763c20c/);
  assert.match(dockerfile, /NODE_VERSION=22\.23\.1/);
  assert.match(dockerfile, /NODE_SHA256=9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578/);

  for (const skill of ["docx", "pdf", "powerpoint", "xlsx", "ocr-and-documents"]) {
    assert.match(
      dockerfile,
      new RegExp(`hermes-office-skills/skills/productivity/${skill} /opt/onecomputer/hermes-agent/skills/productivity/${skill}`),
    );
    assert.match(
      dockerfile,
      new RegExp(`/opt/onecomputer/hermes-agent/skills/productivity/${skill}/SKILL\\.md`),
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
  assert.match(dockerfile, /onecomputer-libreoffice/);
  assert.match(dockerfile, /command -v npm soffice libreoffice pandoc pdftoppm pdftotext qpdf tesseract unzip zip/);
  assert.match(dockerfile, /soffice --headless --version/);
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
    source("docker/workspace/onecomputer-workspace-entrypoint.sh"),
    source("docker/workspace/onecomputer-hermes-config.py"),
    source("docker/workspace/onecomputer-hermes"),
    source("docker/workspace/onecomputer-hermes-desktop"),
    source("docker/workspace/onecomputer-agent-chat.py"),
  ]);

  assert.match(entrypoint, /sync_hermes_skills\(\)/);
  assert.match(entrypoint, /from tools\.skills_sync import sync_skills; sync_skills\(quiet=True\)/);
  assert.match(entrypoint, /sync_hermes_skills \/home\/kasm-user\/\.hermes/);
  assert.match(entrypoint, /sync_hermes_skills \/home\/kasm-user\/\.hermes-desktop/);
  assert.match(entrypoint, /HERMES_BUNDLED_SKILLS=\/opt\/onecomputer\/hermes-agent\/skills/);
  assert.match(entrypoint, /onecomputer-hermes-config/);
  assert.match(profileConfig, /OFFICE_DEFAULT_SKILLS = frozenset/);
  assert.match(profileConfig, /REVIEWED_DEFAULT_SKILLS = OFFICE_DEFAULT_SKILLS \| frozenset\(\{"make-a-site"}\)/);
  for (const skill of ["docx", "pdf", "powerpoint", "xlsx", "ocr-and-documents"]) {
    assert.match(profileConfig, new RegExp(`"${skill}"`));
  }
  assert.match(profileConfig, /current_bundled - previous_bundled/);
  assert.match(profileConfig, /disabled\.update\(skills_to_default_off - REVIEWED_DEFAULT_SKILLS\)/);
  assert.match(profileConfig, /existing\.get\("skills"\)/);
  assert.match(profileConfig, /SKILL_STATE_FILE = "\.onecomputer-skill-defaults\.json"/);
  assert.match(profileConfig, /managed_office_toolsets = \["file", "skills", "terminal", "vision"\]/);
  assert.match(profileConfig, /cli_toolsets = \["hermes-cli", "onecomputer_connectors"\]/);
  assert.match(profileConfig, /api_toolsets = \["hermes-api-server", "onecomputer_connectors"\]/);
  assert.match(profileConfig, /managed_office_tools\.isdisjoint\(resolve_toolset\(name\)\)/);

  for (const launcher of [cliLauncher, desktopLauncher]) {
    assert.match(launcher, /HERMES_BUNDLED_SKILLS=\/opt\/onecomputer\/hermes-agent\/skills/);
    assert.match(launcher, /PATH=\/opt\/onecomputer\/hermes-office-venv\/bin:/);
    assert.match(launcher, /NODE_PATH=\/opt\/onecomputer\/hermes-office-node\/node_modules/);
  }
  assert.match(desktopLauncher, /HERMES_DESKTOP_PYTHON=\/opt\/onecomputer\/hermes-venv\/bin\/python/);

  assert.match(chatAdapter, /Hermes has workspace-local file, terminal, skills, and vision tools/);
  assert.match(chatAdapter, /public-web and unrelated native toolsets remain restricted/);
  assert.match(chatAdapter, /Invoke an assigned MCP tool directly/);
  assert.match(chatAdapter, /path as localFilePath; do not read or base64-encode/);
  assert.match(chatAdapter, /ATTACHMENT_ROOT = STATE_DIR \/ "attachments"/);
  assert.match(chatAdapter, /ATTACHMENT_INBOX_ROOT = HOME \/ "ONEComputer" \/ "Inbox"/);
  assert.match(chatAdapter, /ONECOMPUTER_CHAT_ATTACHMENT_RETENTION_DAYS/);
  assert.match(chatAdapter, /def persist_attachment\(filename: str, media_type: str, data: bytes, source: str\)/);
  assert.match(chatAdapter, /os\.O_EXCL \| getattr\(os, "O_NOFOLLOW", 0\)/);
  assert.match(chatAdapter, /"originalFilename": filename/);
  assert.match(chatAdapter, /os\.symlink\(path, visible_path\)/);
  assert.match(chatAdapter, /"type": "data-file-reference"/);
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
  const chatAdapter = await source("docker/workspace/onecomputer-agent-chat.py");
  const functions = chatAdapter.slice(
    chatAdapter.indexOf("def cleanup_expired_attachments"),
    chatAdapter.indexOf("def validate_user_message"),
  );
  const home = await mkdtemp(path.join(tmpdir(), "onecomputer-attachment-test-"));
  const program = `
import hashlib, json, os, re, shutil, sys, time, uuid
from pathlib import Path
from typing import Any
HOME = Path(sys.argv[1])
ATTACHMENT_ROOT = HOME / ".onecomputer-chat" / "hermes-claw" / "attachments"
ATTACHMENT_INBOX_ROOT = HOME / "ONEComputer" / "Inbox"
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
    assert.match(result.manifest.inboxPath, /ONEComputer\/Inbox\/Telegram/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("governed Calendar discovery advertises only argument shapes Control allows", async () => {
  const bridge = await source("docker/workspace/onecomputer-connectors-stdio.py");
  const schemas = bridge.slice(bridge.indexOf("BOUNDED_LIST_INPUT_PROPERTIES"), bridge.indexOf("LIST_DRIVES_INPUT_SCHEMA"));

  assert.match(schemas, /CALENDAR_VIEW_INPUT_SCHEMA/);
  assert.match(schemas, /LIST_CALENDAR_EVENTS_INPUT_SCHEMA/);
  assert.match(schemas, /"additionalProperties": False/);
  assert.doesNotMatch(schemas, /fetchAllPages|includeHeaders|expandExtendedProperties|"expand"/);
  assert.match(schemas, /"required": \["startDateTime", "endDateTime"\]/);
  assert.match(bridge, /if upstream_name == "get-calendar-view":\n            input_schema = CALENDAR_VIEW_INPUT_SCHEMA/);
  assert.match(bridge, /elif upstream_name == "list-calendar-events":\n            input_schema = LIST_CALENDAR_EVENTS_INPUT_SCHEMA/);
});

test("governed OneDrive deletion carries the resolved filename into approval metadata", async () => {
  const [bridge, broker, control] = await Promise.all([
    source("docker/workspace/onecomputer-connectors-stdio.py"),
    source("docker/workspace/onecomputer-gateway-proxy.py"),
    source("apps/control-api/src/server.ts"),
  ]);

  assert.match(bridge, /"required": \["driveId", "driveItemId", "resourceName", "If-Match"\]/);
  assert.match(bridge, /exact name as resourceName/);
  assert.match(bridge, /request_json\("\/onecomputer\/deletions"/);
  assert.match(broker, /\/internal\/v1\/agent\/deletions/);
  assert.match(control, /safeSummary: `Delete \$\{input\.resourceName\} from OneDrive`/);
  assert.match(control, /resourceName: input\.resourceName/);
});
