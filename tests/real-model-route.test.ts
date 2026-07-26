import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const source = (relativePath: string) => readFile(path.join(root, relativePath), "utf8");

test("the approved model aliases have pinned real routes and no fallback", async () => {
  const config = await source("config/litellm/config.yaml");
  for (const alias of ["onecomputer-assistant", "onecomputer-claude", "onecomputer-openai", "onecomputer-glm"]) {
    assert.equal((config.match(new RegExp(`model_name: ${alias}`, "g")) ?? []).length, 1);
  }
  assert.match(config, /model: anthropic\/claude-sonnet-4-6/);
  assert.match(config, /model: openai\/gpt-5\.6-luna/);
  assert.match(config, /model: zai\/glm-5/);
  assert.match(config, /model_name: claude-sonnet-4-6\s+litellm_params:\s+model: anthropic\/claude-sonnet-4-6/);
  assert.match(config, /model_name: claude-opus-4-6\s+litellm_params:\s+model: openai\/gpt-5\.6-luna/);
  assert.match(config, /model_name: claude-sonnet-4-5\s+litellm_params:\s+model: zai\/glm-5/);
  assert.match(config, /model_name: onecomputer-glm[\s\S]*?supports_vision: false/);
  assert.match(config, /model_name: onecomputer-openai[\s\S]*?supports_vision: true/);
  assert.doesNotMatch(config, /fallbacks:/);
  assert.match(config, /turn_off_message_logging: true/);
  assert.match(config, /log_raw_request_response: false/);
});

test("the provider credential is injected only into LiteLLM", async () => {
  const compose = await source("compose.yaml");
  const litellm = compose.split("  litellm:")[1]?.split("\n  openvtc-consent:")[0] ?? "";
  const everythingElse = compose.replace(litellm, "");
  assert.match(litellm, /OPENAI_API_KEY: \$\{ONECOMPUTER_OPENAI_API_KEY:/);
  assert.match(litellm, /ANTHROPIC_API_KEY: \$\{ONECOMPUTER_CLAUDE_API_KEY:/);
  assert.match(litellm, /ZAI_API_KEY: \$\{ONECOMPUTER_GLM_API_KEY:/);
  assert.doesNotMatch(everythingElse, /ONECOMPUTER_(?:OPENAI|CLAUDE|GLM)_API_KEY/);
});

test("LiteLLM rejects image input when the selected deployment does not advertise vision", async () => {
  const callback = await source("integrations/litellm/onecomputer_policy_callback.py");
  assert.match(callback, /async_pre_call_deployment_hook/);
  assert.match(callback, /_contains_image_input/);
  assert.match(callback, /litellm\.get_model_info\(model\)/);
  assert.match(callback, /MODEL_IMAGE_INPUT_UNSUPPORTED/);
  assert.match(callback, /status_code=422/);
});

test("the connection account lookup bypass is purpose-bound and exact", async () => {
  const callback = await source("integrations/litellm/onecomputer_policy_callback.py");
  const adapter = await source("packages/litellm-adapter/src/index.ts");
  assert.match(callback, /metadata\.get\("onecomputer_connection_credential"\) is True/);
  assert.match(callback, /metadata\.get\("onecomputer_connection_account_lookup"\) is True/);
  assert.match(callback, /metadata\.get\("onecomputer_connection_server"\) == MS365_SERVER_NAME/);
  assert.match(callback, /payload\.get\("toolName"\) == MS365_ACCOUNT_LOOKUP_TOOL/);
  assert.match(callback, /payload\.get\("arguments"\) == MS365_ACCOUNT_LOOKUP_ARGUMENTS/);
  assert.match(callback, /\{\s*"\$select": "displayName,mail,userPrincipalName",?\s*\}/);
  assert.match(adapter, /const accountLookup = serverName === "onecomputer_ms365"/);
  assert.match(adapter, /onecomputer_connection_account_lookup: accountLookup/);
  assert.match(adapter, /mcp_tool_permissions: \{ \[serverName\]: accountLookup \? \["get-current-user"\] : \[\] \}/);
});

test("Claude Desktop is pinned and receives managed gateway policy rather than provider credentials", async () => {
  const dockerfile = await source("docker/Dockerfile.workspace");
  const entrypoint = await source("infra/issue-010/onecomputer-workspace-entrypoint.sh");
  const proxy = await source("infra/issue-010/onecomputer-gateway-proxy.py");
  assert.match(dockerfile, /CLAUDE_DESKTOP_VERSION=1\.22209\.3/);
  assert.match(dockerfile, /CLAUDE_DESKTOP_SHA256=d427f46a/);
  assert.match(dockerfile, /CLAUDE_CODE_VERSION=2\.1\.215/);
  assert.match(dockerfile, /CLAUDE_CODE_SHA256=7ff9594e/);
  assert.match(dockerfile, /claude-code-releases\/\$\{CLAUDE_CODE_VERSION\}\/linux-x64\/claude\.zst/);
  assert.match(dockerfile, /claude --version/);
  assert.match(entrypoint, /Claude-3p\/claude-code\/\$\{claude_code_version\}/);
  assert.match(entrypoint, /\.verified/);
  assert.match(entrypoint, /\/etc\/claude-desktop\/managed-settings\.json/);
  assert.match(entrypoint, /"inferenceGatewayBaseUrl": "http:\/\/127\.0\.0\.1:4312"/);
  assert.doesNotMatch(entrypoint, /inferenceGatewayBaseUrl[^\n]+4312\/v1/);
  assert.match(entrypoint, /"disableDeploymentModeChooser": True/);
  assert.match(entrypoint, /"isLocalDevMcpEnabled": False/);
  assert.match(entrypoint, /"isDesktopExtensionEnabled": False/);
  assert.match(entrypoint, /claude-sonnet-4-5/);
  assert.match(proxy, /"\/v1\/messages"/);
  assert.match(proxy, /"\/mcp-rest\/tools\/call"/);
  assert.match(entrypoint, /"managedMcpServers"/);
  assert.match(entrypoint, /onecomputer-mcp-stdio/);
  assert.doesNotMatch(`${dockerfile}\n${entrypoint}\n${proxy}`, /ONECOMPUTER_(?:OPENAI|CLAUDE|GLM)_API_KEY|LITELLM_MASTER_KEY/);
});

test("the workspace image enforces bounded native text clipboard without content logging", async () => {
  const dockerfile = await source("docker/Dockerfile.workspace");
  const entrypoint = await source("infra/issue-010/onecomputer-workspace-entrypoint.sh");
  const client = await source("infra/issue-010/onecomputer-kasm-clipboard.js");
  assert.match(dockerfile, /onecomputer-kasm-clipboard\.js/);
  assert.match(dockerfile, /COPY .* \/usr\/share\/kasmvnc\/www\/app\/onecomputer-kasm-clipboard\.js/);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends[\s\S]*\n      mousepad \\\n[\s\S]*\n      zstd \\/);
  assert.match(dockerfile, /chmod 0644 \/usr\/share\/kasmvnc\/www\/app\/onecomputer-kasm-clipboard\.js/);
  assert.match(dockerfile, /<script src="app\/onecomputer-kasm-clipboard\.js">/);
  assert.match(entrypoint, /ONECOMPUTER_CLIPBOARD_MAX_BYTES:=65536/);
  assert.match(entrypoint, /allow_mimetypes:\s+- text\/plain/);
  assert.match(entrypoint, /server_to_client:\s+enabled: \{workspace_to_local\}\s+size: \{max_bytes\}/);
  assert.match(entrypoint, /client_to_server:\s+enabled: \{local_to_workspace\}\s+size: \{max_bytes\}/);
  assert.match(entrypoint, /data_loss_prevention:\s+logging:\s+level: off/);
  assert.match(client, /clipboard permission is blocked/i);
  assert.match(client, /native clipboard is unavailable/i);
  assert.match(client, /clipboard sharing is disabled/i);
  assert.doesNotMatch(client, /clipboard\.(?:read|write|readText|writeText)\s*\(/);
});

test("the workspace image includes a pinned Firefox ESR locked to governed egress", async () => {
  const dockerfile = await source("docker/Dockerfile.workspace");
  const entrypoint = await source("infra/issue-010/onecomputer-workspace-entrypoint.sh");
  const policies = JSON.parse(await source("infra/issue-010/firefox-policies.json"));
  assert.match(dockerfile, /FIREFOX_VERSION=140\.12\.0esr/);
  assert.match(dockerfile, /FIREFOX_SHA256=3323ee13/);
  assert.match(dockerfile, /firefox-\$\{FIREFOX_VERSION\}\.tar\.xz/);
  assert.match(dockerfile, /sha256sum -c/);
  assert.match(dockerfile, /onecomputer-egress-broker\.py \/usr\/local\/libexec\/onecomputer-egress-broker/);
  assert.match(entrypoint, /onecomputer-firefox\.desktop.*\/home\/kasm-user\/Desktop\/Firefox\.desktop/);
  assert.match(entrypoint, /ONECOMPUTER_EGRESS_UPSTREAM="\$HTTPS_PROXY"/);
  assert.match(entrypoint, /onecomputer-egress-broker/);
  assert.equal(policies.policies.Proxy.Mode, "manual");
  assert.equal(policies.policies.Proxy.Locked, true);
  assert.equal(policies.policies.Proxy.HTTPProxy, "127.0.0.1:4313");
  assert.equal(policies.policies.Proxy.UseHTTPProxyForAllProtocols, true);
  assert.equal(policies.policies.Proxy.UseProxyForDNS, true);
  assert.equal(policies.policies.DisableAppUpdate, true);
  assert.equal(policies.policies.DisableTelemetry, true);
  assert.equal(policies.policies.OfferToSaveLogins, false);
});

test("optional browser and agent artifacts are pinned and launch-gated", async () => {
  const dockerfile = await source("docker/Dockerfile.workspace");
  const entrypoint = await source("infra/issue-010/onecomputer-workspace-entrypoint.sh");
  const gatewayProxy = await source("infra/issue-010/onecomputer-gateway-proxy.py");
  const mcpBridge = await source("infra/issue-010/onecomputer-mcp-stdio.py");
  const chatAdapter = await source("infra/issue-010/onecomputer-agent-chat.py");
  const chatRequirements = await source("infra/issue-010/agent-chat-requirements.txt");
  const chromePolicies = JSON.parse(await source("infra/issue-010/google-chrome-policies.json"));
  const claudeLauncher = await source("infra/issue-010/onecomputer-claude");
  const codexLauncher = await source("infra/issue-010/onecomputer-codex");
  const hermesDesktopLauncher = await source("infra/issue-010/onecomputer-hermes-desktop");

  assert.match(dockerfile, /GOOGLE_CHROME_VERSION=150\.0\.7871\.186-1/);
  assert.match(dockerfile, /GOOGLE_CHROME_SHA256=4193e00b/);
  assert.match(dockerfile, /npm run pack --workspace apps\/desktop/);
  assert.match(dockerfile, /release\/linux-unpacked/);
  assert.doesNotMatch(dockerfile, /COPY .*\.desktop \/usr\/share\/applications\/onecomputer-/);
  assert.match(dockerfile, /\/usr\/local\/share\/onecomputer\/applications\/onecomputer-google-chrome\.desktop/);
  assert.equal(chromePolicies.ProxyMode, "fixed_servers");
  assert.equal(chromePolicies.ProxyServer, "http://127.0.0.1:4313");
  assert.match(claudeLauncher, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:4315/);
  assert.match(claudeLauncher, /--strict-mcp-config/);
  assert.match(codexLauncher, /OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:4317\/v1/);
  assert.match(codexLauncher, /--ask-for-approval never/);
  assert.match(entrypoint, /model_provider = "onecomputer"/);
  assert.match(entrypoint, /base_url = "http:\/\/127\.0\.0\.1:4317\/v1"/);
  assert.match(entrypoint, /supports_websockets = false/);
  assert.match(entrypoint, /default_tools_approval_mode = "approve"/);
  assert.match(chatRequirements, /claude-agent-sdk==0\.2\.128/);
  assert.match(chatRequirements, /openai-codex==0\.144\.4/);
  assert.match(dockerfile, /openai-codex"\)\)'\)" = "0\.144\.4"/);
  assert.match(chatAdapter, /approval\\s\+\(\?:is\\s\+\)\?required/);
  assert.match(chatAdapter, /"Waiting for governed approval"/);
  assert.match(chatAdapter, /approval_state in \{"approval_required", "approved", "executing"\}/);
  assert.match(chatAdapter, /"type": "image"/);
  assert.match(chatAdapter, /ImageInput\(attachment\["url"\]\)/);
  assert.match(chatAdapter, /"type": "image_url"/);
  assert.match(chatAdapter, /"instructions": SYSTEM_PROMPT/);
  assert.match(chatAdapter, /human identifier such as a filename/);
  assert.match(chatAdapter, /prompt_with_documents/);
  assert.match(chatAdapter, /pdftotext/);
  assert.match(mcpBridge, /filename visible in an attached screenshot is enough to begin discovery/);
  assert.match(mcpBridge, /call list-drives to resolve driveId, then search-onedrive-files/);
  assert.match(mcpBridge, /threading\.Thread\(/);
  assert.match(mcpBridge, /RESPONSE_LOCK = threading\.Lock\(\)/);
  assert.match(chatAdapter, /MAX_TURN_SECONDS = 15 \* 60/);
  assert.match(chatAdapter, /timeout=MAX_TURN_SECONDS/);
  assert.match(hermesDesktopLauncher, /HERMES_DESKTOP_HERMES_ROOT=\/opt\/onecomputer\/hermes-agent/);
  assert.match(hermesDesktopLauncher, /Hermes --no-sandbox/);
  assert.match(entrypoint, /ONEComputer-Agent\.desktop/);
  assert.match(entrypoint, /Hermes-Claw\.desktop/);
  assert.match(entrypoint, /onecomputer-hermes-agent-cli\.desktop.*Hermes-Agent-CLI\.desktop/);
  assert.doesNotMatch(entrypoint, /onecomputer-hermes-claw\.desktop/);
  for (const selection of ["google-chrome", "claude-cli", "codex-cli", "hermes-desktop"]) {
    assert.match(entrypoint, new RegExp(selection));
  }
  assert.match(entrypoint, /chmod 0700 \/opt\/google\/chrome\/google-chrome/);
  assert.match(entrypoint, /chmod 0700 \/usr\/local\/bin\/onecomputer-claude/);
  assert.match(entrypoint, /chmod 0700 \/usr\/local\/bin\/onecomputer-hermes-desktop/);
  assert.match(gatewayProxy, /\{4312, 4314, 4315, 4316, 4317\}/);
  for (const port of [4312, 4314, 4315, 4316, 4317]) {
    assert.match(mcpBridge, new RegExp(`127\\.0\\.0\\.1:${port}`));
  }
});

test("the Hermes sandbox gateway includes its pinned private API runtime without a home-log ownership collision", async () => {
  const dockerfile = await source("docker/Dockerfile.workspace");
  const entrypoint = await source("infra/issue-010/onecomputer-workspace-entrypoint.sh");
  assert.match(dockerfile, /aiohttp==3\.14\.1/);
  assert.match(dockerfile, /import aiohttp/);
  assert.match(dockerfile, /uv pip install[\s\S]*mcp==1\.26\.0[\s\S]*starlette==1\.0\.1/);
  assert.match(dockerfile, /importlib\.metadata\.version\("mcp"\).*1\.26\.0/);
  assert.match(entrypoint, /hermes gateway run/);
  assert.match(entrypoint, /managed_office_toolsets = \["file", "skills", "terminal", "vision"\]/);
  assert.match(entrypoint, /cli_toolsets = managed_office_toolsets \+ \["onecomputer_ms365"\]/);
  assert.match(entrypoint, /api_toolsets = managed_office_toolsets \+ \["onecomputer_ms365"\]/);
  assert.match(entrypoint, /cli_toolsets = \["hermes-cli", "onecomputer_ms365"\]/);
  assert.match(entrypoint, /api_toolsets = \["hermes-api-server", "onecomputer_ms365"\]/);
  assert.match(entrypoint, /"reasoning_effort": False/);
  assert.match(entrypoint, /\/run\/onecomputer\/hermes-gateway-bootstrap\.log/);
  assert.doesNotMatch(entrypoint, />>\/home\/kasm-user\/\.hermes\/logs\/gateway\.log/);
});
