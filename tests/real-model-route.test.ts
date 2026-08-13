import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { mvpPolicyDocument, upgradeHistoricMvpPolicyDocument } from "@lemmacomputer/workspace-store";
import { projectServiceEnvironment } from "../scripts/deployment-config.mjs";

const root = path.resolve(import.meta.dirname, "..");
const source = (relativePath: string) => readFile(path.join(root, relativePath), "utf8");

test("LiteLLM keeps independent request capacity for live MCP authorization callbacks", async () => {
  const [compose, callback, connections] = await Promise.all([
    source("compose.yaml"),
    source("integrations/litellm/lemmacomputer_policy_callback.py"),
    source("apps/control-api/src/connections.ts"),
  ]);
  const service = compose.split("  litellm:")[1]?.split("\n  openvtc-consent:")[0] ?? "";
  assert.match(service, /--num_workers\s*\n\s*- "2"/);
  assert.match(callback, /await asyncio\.to_thread\(_request_decision, payload\)/);
  assert.match(callback, /POLICY_TIMEOUT_SECONDS = 15/);
  assert.match(connections, /this\.connectionStatus\(identity, connector\)/);
  assert.match(connections, /userOAuthConnectionTools\(identity, connector\.serverName\)/);
});

test("OpenAI, Anthropic, GLM, and Bedrock routes are database-managed", async () => {
  const [config, providerSettings, bootstrapPolicy] = await Promise.all([
    source("config/litellm/config.yaml"),
    source("packages/litellm-adapter/src/provider-settings.ts"),
    source("packages/workspace-store/src/identity-policy.ts"),
  ]);
  for (const alias of ["lemmacomputer-assistant", "lemmacomputer-claude", "lemmacomputer-openai", "lemmacomputer-glm", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-opus-4-6"]) {
    assert.doesNotMatch(config, new RegExp(`model_name: ${alias}`));
  }
  assert.match(config, /model_list: \[\]/);
  assert.doesNotMatch(config, /api_key: os\.environ/);
  assert.match(providerSettings, /managedProviderModels/);
  assert.match(providerSettings, /litellm_credential_name/);
  assert.match(providerSettings, /tenantManagedModelAccessGroup/);
  assert.doesNotMatch(config, /fallbacks:/);
  assert.match(config, /turn_off_message_logging: true/);
  assert.match(config, /log_raw_request_response: false/);
  assert.match(bootstrapPolicy, /mvpDefaultModelAliases = \["lemmacomputer-claude", "lemmacomputer-openai", "lemmacomputer-glm", "lemmacomputer-bedrock"\]/);
  assert.match(bootstrapPolicy, /modelAliases: \[\.\.\.modelAliases\]/);
});

test("managed Claude Desktop accepts the organization auto route", async () => {
  const entrypoint = await source("docker/workspace/lemmacomputer-workspace-entrypoint.sh");
  assert.match(
    entrypoint,
    /lemmacomputer-auto\|lemmacomputer-assistant\) model_label="Standard organization route"/,
  );
});

test("historic demo defaults gain GLM and Bedrock while customer policy remains unchanged", async () => {
  const historic = mvpPolicyDocument("Initial MVP policy", ["lemmacomputer-claude", "lemmacomputer-openai"]);
  const upgraded = upgradeHistoricMvpPolicyDocument(historic);
  assert.ok(upgraded && typeof upgraded === "object" && !Array.isArray(upgraded));
  assert.deepEqual((upgraded as Record<string, unknown>).modelAliases, [
    "lemmacomputer-claude",
    "lemmacomputer-openai",
    "lemmacomputer-glm",
    "lemmacomputer-bedrock",
  ]);
  assert.equal(
    upgradeHistoricMvpPolicyDocument({ ...historic, revisionNote: "Customer-restricted model policy" }),
    null,
  );
  const bootstrapPolicy = await source("packages/workspace-store/src/identity-policy.ts");
  assert.match(bootstrapPolicy, /pv\.document_hash = ANY\(\$1::text\[\]\)/);
});

test("provider setup uses Control and LiteLLM credentials, never provider environment keys or the LiteLLM admin UI", async () => {
  const [compose, example, web] = await Promise.all([
    source("compose.yaml"),
    source(".env.example"),
    source("apps/web/src/App.jsx"),
  ]);
  const litellm = compose.split("  litellm:")[1]?.split("\n  openvtc-consent:")[0] ?? "";
  const everythingElse = compose.replace(litellm, "");
  const litellmEnvironment = projectServiceEnvironment().litellm;
  assert.doesNotMatch(litellm, /(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|ZAI_API_KEY|UI_USERNAME|UI_PASSWORD)/);
  assert.match(litellm, /env_file:\s+- path: \.runtime-env\/litellm\.env\s+format: raw/);
  assert.equal(litellmEnvironment.DISABLE_ADMIN_UI, "true");
  assert.doesNotMatch(everythingElse, /LEMMACOMPUTER_(?:OPENAI|CLAUDE|GLM)_API_KEY/);
  assert.doesNotMatch(example, /LEMMACOMPUTER_(?:OPENAI|CLAUDE|GLM)_API_KEY/);
  assert.match(web, /Provider settings/);
  assert.match(web, /glm: "GLM \(Z\.ai\)"/);
  assert.match(web, /name="provider-api-key" type="password"/);
  assert.doesNotMatch(web, /gatewayAdminUrl/);
});

test("the local workspace receives an explicit host-seeded IANA timezone", async () => {
  const [compose, example, initializer, entrypoint] = await Promise.all([
    source("compose.yaml"),
    source(".env.example"),
    source("scripts/initialize-env.mjs"),
    source("docker/workspace/lemmacomputer-workspace-entrypoint.sh"),
  ]);
  const controllerEnvironment = projectServiceEnvironment()["workspace-controller"];
  assert.match(example, /^LEMMACOMPUTER_TIME_ZONE=Etc\/UTC$/m);
  assert.match(initializer, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
  assert.match(compose, /env_file:\s+- path: \.runtime-env\/workspace-controller\.env\s+format: raw/);
  assert.equal(controllerEnvironment.KASM_LOCAL_TIME_ZONE, "Etc/UTC");
  assert.equal(controllerEnvironment.KASM_LOCAL_KVM_ENABLED, "false");
  assert.equal(controllerEnvironment.LEMMACOMPUTER_INSTALLATION_KIND, "customer-managed");
  assert.match(entrypoint, /LEMMACOMPUTER_TIME_ZONE="\$LEMMACOMPUTER_TIME_ZONE"/);
});

test("LiteLLM rejects image input when the selected deployment does not advertise vision", async () => {
  const callback = await source("integrations/litellm/lemmacomputer_policy_callback.py");
  assert.match(callback, /async_pre_call_deployment_hook/);
  assert.match(callback, /_contains_image_input/);
  assert.match(callback, /litellm\.get_model_info\(model\)/);
  assert.match(callback, /MODEL_IMAGE_INPUT_UNSUPPORTED/);
  assert.match(callback, /status_code=422/);
});

test("the connection account lookup bypass is purpose-bound and exact", async () => {
  const callback = await source("integrations/litellm/lemmacomputer_policy_callback.py");
  const adapter = await source("packages/litellm-adapter/src/index.ts");
  assert.match(callback, /metadata\.get\("lemmacomputer_connection_credential"\) is True/);
  assert.match(callback, /metadata\.get\("lemmacomputer_connection_account_lookup"\) is True/);
  assert.match(callback, /metadata\.get\("lemmacomputer_connection_server"\) == MS365_SERVER_NAME/);
  assert.match(callback, /payload\.get\("toolName"\) == MS365_ACCOUNT_LOOKUP_TOOL/);
  assert.match(callback, /payload\.get\("arguments"\) == MS365_ACCOUNT_LOOKUP_ARGUMENTS/);
  assert.match(callback, /\{\s*"\$select": "displayName,mail,userPrincipalName",?\s*\}/);
  assert.match(adapter, /const accountLookup = options\.accountLookup === true && serverName === "lemmacomputer_ms365"/);
  assert.match(adapter, /lemmacomputer_connection_account_lookup: accountLookup/);
  assert.match(adapter, /mcp_tool_permissions: \{ \[serverName\]: accountLookup \? \["get-current-user"\] : \[\] \}/);
});

test("human-facing audit context is approval-bound but never forwarded to a connector", async () => {
  const callback = await source("integrations/litellm/lemmacomputer_policy_callback.py");
  const bridge = await source("docker/workspace/lemmacomputer-connectors-stdio.py");
  assert.match(callback, /AUDIT_ONLY_ARGUMENTS = \{"lemmacomputerAudit"\}/);
  assert.match(callback, /key not in AUDIT_ONLY_ARGUMENTS/);
  assert.match(callback, /POLICY_ATTEMPTS = 2/);
  assert.match(callback, /for attempt in range\(POLICY_ATTEMPTS\)/);
  assert.match(bridge, /AUDIT_CONTEXT_SCHEMA/);
  assert.match(bridge, /"recipient", "chat", "channel"/);
  assert.match(bridge, /targetType chat/);
  assert.match(bridge, /required = list\(dict\.fromkeys\(required \+ \["lemmacomputerAudit"\]\)\)/);
});

test("Claude Desktop is pinned and receives managed gateway policy rather than provider credentials", async () => {
  const dockerfile = await source("docker/Dockerfile.workspace");
  const entrypoint = await source("docker/workspace/lemmacomputer-workspace-entrypoint.sh");
  const claudeConfig = await source("docker/workspace/lemmacomputer-claude-config.py");
  const proxy = await source("docker/workspace/lemmacomputer-gateway-proxy.py");
  const desktopLauncher = await source("docker/workspace/lemmacomputer-claude-desktop");
  assert.match(dockerfile, /CLAUDE_DESKTOP_VERSION=1\.22209\.3/);
  assert.match(dockerfile, /CLAUDE_DESKTOP_SHA256=d427f46a/);
  assert.match(dockerfile, /CLAUDE_CODE_VERSION=2\.1\.215/);
  assert.match(dockerfile, /CLAUDE_CODE_SHA256=7ff9594e/);
  assert.match(dockerfile, /claude-code-releases\/\$\{CLAUDE_CODE_VERSION\}\/linux-x64\/claude\.zst/);
  assert.match(dockerfile, /claude --version/);
  assert.match(dockerfile, /qemu-system-x86/);
  assert.match(dockerfile, /\n      ovmf \\/);
  assert.match(dockerfile, /\/usr\/lib\/claude-desktop\/resources\/virtiofsd/);
  assert.match(entrypoint, /Claude-3p\/claude-code\/\$\{claude_code_version\}/);
  assert.match(entrypoint, /\.verified/);
  assert.match(entrypoint, /\/etc\/claude-desktop\/managed-settings\.json/);
  assert.match(claudeConfig, /"inferenceGatewayBaseUrl": "http:\/\/127\.0\.0\.1:4312"/);
  assert.doesNotMatch(claudeConfig, /inferenceGatewayBaseUrl[^\n]+4312\/v1/);
  assert.match(claudeConfig, /\("claude-sonnet-4-6-20260101", "Lite — organization route", "lite"\)/);
  assert.match(claudeConfig, /\("claude-sonnet-4-6-20260102", "Balanced — organization route", "balanced"\)/);
  assert.match(claudeConfig, /\("claude-sonnet-4-6-20260103", "Pro — organization route", "pro"\)/);
  assert.match(proxy, /"claude-sonnet-4-6-20260101": "lite"/);
  assert.match(proxy, /"claude-sonnet-4-6-20260102": "balanced"/);
  assert.match(proxy, /"claude-sonnet-4-6-20260103": "pro"/);
  assert.match(claudeConfig, /"isFamilyDefault": service_class == default_service_class/);
  assert.match(claudeConfig, /"disableDeploymentModeChooser": True/);
  assert.match(claudeConfig, /"coworkTabEnabled": cowork_enabled == "true"/);
  assert.match(claudeConfig, /"secureVmFeaturesEnabled": cowork_enabled == "true"/);
  assert.match(entrypoint, /claude_code_for_desktop_enabled=false/);
  assert.match(entrypoint, /agent_enabled claude-desktop && agent_enabled claude-cli/);
  assert.match(claudeConfig, /"isClaudeCodeForDesktopEnabled": code_enabled == "true"/);
  assert.match(entrypoint, /LEMMACOMPUTER_MODEL_ALIAS="\$\{!model_variable\}"/);
  assert.match(entrypoint, /LEMMACOMPUTER_TRANSPORT_MODEL_ALIAS="\$\{!transport_model_variable\}"/);
  assert.match(entrypoint, /LEMMACOMPUTER_REQUESTED_SERVICE_CLASS="\$\{!service_class_variable\}"/);
  assert.match(claudeConfig, /"allowedWorkspaceFolders": \["\/home\/kasm-user"\]/);
  assert.match(entrypoint, /grant_cowork_device_access \/dev\/kvm lemmacomputer-kvm/);
  assert.match(entrypoint, /grant_cowork_device_access \/dev\/vhost-vsock lemmacomputer-vhost-vsock/);
  assert.match(entrypoint, /socket\.socket\(40, socket\.SOCK_STREAM\)\.close\(\)/);
  assert.match(entrypoint, /Cowork cannot create an AF_VSOCK socket/);
  assert.match(entrypoint, /groupadd --system --gid "\$device_gid" "\$device_group"/);
  assert.match(entrypoint, /setpriv --reuid=1000 --regid=1000 --init-groups[\s\S]*\[\[ -r "\$1" && -w "\$1" \]\]/);
  const profileInitialization = entrypoint.indexOf("/dockerstartup/kasm_default_profile.sh /bin/true");
  const hermesGatewayStartup = entrypoint.indexOf("/opt/lemmacomputer/hermes-venv/bin/hermes gateway run");
  assert.ok(profileInitialization >= 0, "Kasm must initialize the persistent home explicitly");
  assert.ok(profileInitialization < hermesGatewayStartup, "Kasm must initialize the home before agent processes start");
  assert.doesNotMatch(entrypoint, /exec setpriv[\s\S]*kasm_default_profile\.sh/);
  assert.match(claudeConfig, /"isLocalDevMcpEnabled": False/);
  assert.match(claudeConfig, /"isDesktopExtensionEnabled": False/);
  assert.match(entrypoint, /claude-sonnet-4-5/);
  assert.match(proxy, /"\/v1\/messages"/);
  assert.match(proxy, /"\/v1\/messages\/count_tokens"/);
  assert.match(proxy, /request\["model"\] = MODEL_ALIAS/);
  assert.match(proxy, /NATIVE_MODEL_MODES = \{/);
  assert.match(proxy, /native_service_class_for_model\(requested_model\)/);
  assert.match(proxy, /path == "\/v1\/models" and self\.command == "GET"/);
  assert.match(proxy, /MAX_INFERENCE_BODY_BYTES = 64 \* 1024 \* 1024/);
  assert.match(desktopLauncher, /unset HTTP_PROXY http_proxy/);
  assert.match(desktopLauncher, /HTTPS_PROXY=http:\/\/127\.0\.0\.1:4313/);
  assert.match(desktopLauncher, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:4315/);
  assert.match(desktopLauncher, /ANTHROPIC_AUTH_TOKEN=lemmacomputer-loopback-broker/);
  assert.match(desktopLauncher, /ANTHROPIC_DEFAULT_OPUS_MODEL="\$code_model"/);
  assert.match(desktopLauncher, /ANTHROPIC_DEFAULT_SONNET_MODEL="\$code_model"/);
  assert.match(desktopLauncher, /ANTHROPIC_DEFAULT_HAIKU_MODEL="\$code_model"/);
  assert.match(proxy, /"\/mcp-rest\/tools\/call"/);
  assert.match(proxy, /UPLOAD_CHUNK_BYTES = 10 \* 1024 \* 1024/);
  assert.match(proxy, /content-range.*bytes \{offset\}-\{end\}\/\{job\['size'\]\}/s);
  assert.match(proxy, /job\["running"\] = False/);
  assert.match(proxy, /job\.pop\("uploadUrl", None\)/);
  assert.match(claudeConfig, /"managedMcpServers"/);
  assert.match(claudeConfig, /lemmacomputer-connectors-stdio/);
  assert.match(entrypoint, /lemmacomputer_connectors/);
  assert.match(entrypoint, /LEMMACOMPUTER_CONNECTORS_BROKER/);
  assert.doesNotMatch(entrypoint, /mcp_servers\.lemmacomputer_ms365|LEMMACOMPUTER_MCP_BROKER/);
  assert.doesNotMatch(`${dockerfile}\n${entrypoint}\n${claudeConfig}\n${proxy}`, /LEMMACOMPUTER_(?:OPENAI|CLAUDE|GLM)_API_KEY|LITELLM_MASTER_KEY/);
  assert.doesNotMatch(desktopLauncher, /sk-ant-|sk-proj-|LITELLM_MASTER_KEY/);
});

test("the workspace image enforces bounded native text clipboard without content logging", async () => {
  const dockerfile = await source("docker/Dockerfile.workspace");
  const entrypoint = await source("docker/workspace/lemmacomputer-workspace-entrypoint.sh");
  const client = await source("docker/workspace/lemmacomputer-kasm-clipboard.js");
  assert.match(dockerfile, /lemmacomputer-kasm-clipboard\.js/);
  assert.match(dockerfile, /COPY .* \/usr\/share\/kasmvnc\/www\/app\/lemmacomputer-kasm-clipboard\.js/);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends[\s\S]*\n      mousepad \\\n[\s\S]*\n      zstd \\/);
  assert.match(dockerfile, /chmod 0644 \/usr\/share\/kasmvnc\/www\/app\/lemmacomputer-kasm-clipboard\.js/);
  assert.match(dockerfile, /<script src="app\/lemmacomputer-kasm-clipboard\.js">/);
  assert.match(entrypoint, /LEMMACOMPUTER_CLIPBOARD_MAX_BYTES:=65536/);
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
  const entrypoint = await source("docker/workspace/lemmacomputer-workspace-entrypoint.sh");
  const policies = JSON.parse(await source("docker/workspace/firefox-policies.json"));
  assert.match(dockerfile, /FIREFOX_VERSION=140\.12\.0esr/);
  assert.match(dockerfile, /FIREFOX_SHA256=3323ee13/);
  assert.match(dockerfile, /firefox-\$\{FIREFOX_VERSION\}\.tar\.xz/);
  assert.match(dockerfile, /sha256sum -c/);
  assert.match(dockerfile, /lemmacomputer-egress-broker\.py \/usr\/local\/libexec\/lemmacomputer-egress-broker/);
  assert.match(entrypoint, /lemmacomputer-firefox\.desktop.*\/home\/kasm-user\/Desktop\/Firefox\.desktop/);
  assert.match(entrypoint, /LEMMACOMPUTER_EGRESS_UPSTREAM="\$HTTPS_PROXY"/);
  assert.match(entrypoint, /lemmacomputer-egress-broker/);
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
  const entrypoint = await source("docker/workspace/lemmacomputer-workspace-entrypoint.sh");
  const gatewayProxy = await source("docker/workspace/lemmacomputer-gateway-proxy.py");
  const mcpBridge = await source("docker/workspace/lemmacomputer-connectors-stdio.py");
  const chatAdapter = await source("docker/workspace/lemmacomputer-agent-chat.py");
  const chatRequirements = await source("docker/workspace/agent-chat-requirements.txt");
  const chromePolicies = JSON.parse(await source("docker/workspace/google-chrome-policies.json"));
  const claudeLauncher = await source("docker/workspace/lemmacomputer-claude");
  const codexLauncher = await source("docker/workspace/lemmacomputer-codex");
  const hermesDesktopLauncher = await source("docker/workspace/lemmacomputer-hermes-desktop");

  assert.match(dockerfile, /GOOGLE_CHROME_VERSION=150\.0\.7871\.186-1/);
  assert.match(dockerfile, /GOOGLE_CHROME_SHA256=4193e00b/);
  assert.match(dockerfile, /npm run pack --workspace apps\/desktop/);
  assert.match(dockerfile, /release\/linux-unpacked/);
  assert.doesNotMatch(dockerfile, /COPY .*\.desktop \/usr\/share\/applications\/lemmacomputer-/);
  assert.match(dockerfile, /\/usr\/local\/share\/lemmacomputer\/applications\/lemmacomputer-google-chrome\.desktop/);
  assert.equal(chromePolicies.ProxyMode, "fixed_servers");
  assert.equal(chromePolicies.ProxyServer, "http://127.0.0.1:4313");
  assert.match(claudeLauncher, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:4315/);
  assert.match(claudeLauncher, /--strict-mcp-config/);
  assert.match(codexLauncher, /OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:4317\/v1/);
  assert.match(codexLauncher, /--ask-for-approval never/);
  assert.match(entrypoint, /model_provider = "lemmacomputer"/);
  assert.match(entrypoint, /base_url = "http:\/\/127\.0\.0\.1:4317\/v1"/);
  assert.match(entrypoint, /supports_websockets = false/);
  assert.match(entrypoint, /default_tools_approval_mode = "approve"/);
  assert.match(chatRequirements, /claude-agent-sdk==0\.2\.128/);
  assert.match(chatAdapter, /"ANTHROPIC_CUSTOM_HEADERS": f"x-lemmacomputer-ai-task-binding: \{usage_task_binding\}"/);
  assert.doesNotMatch(chatAdapter, /"ANTHROPIC_CUSTOM_HEADERS": json\.dumps/);
  assert.match(chatRequirements, /openai-codex==0\.144\.4/);
  assert.match(dockerfile, /openai-codex"\)\)'\)" = "0\.144\.4"/);
  assert.match(chatAdapter, /approval\\s\+\(\?:is\\s\+\)\?required/);
  assert.match(chatAdapter, /"Waiting for governed approval"/);
  assert.match(chatAdapter, /approval_state in \{"approval_required", "approved", "executing"\}/);
  assert.match(chatAdapter, /"type": "image"/);
  assert.match(chatAdapter, /ImageInput\(attachment\["url"\]\)/);
  assert.match(chatAdapter, /"type": "image_url"/);
  assert.match(chatAdapter, /"instructions": system_prompt\(\)/);
  assert.match(chatAdapter, /human identifier such as a filename/);
  assert.match(chatAdapter, /Invoke an assigned MCP tool directly/);
  assert.match(chatAdapter, /never wrap.*MCP call.*terminal.*execute_code/s);
  assert.match(chatAdapter, /prompt_with_documents/);
  assert.match(chatAdapter, /pdftotext/);
  assert.match(mcpBridge, /filename visible in an attached screenshot is enough to begin discovery/);
  assert.match(mcpBridge, /call list-drives to resolve driveId, then search-onedrive-files/);
  assert.match(mcpBridge, /threading\.Thread\(/);
  assert.match(mcpBridge, /RESPONSE_LOCK = threading\.Lock\(\)/);
  assert.match(chatAdapter, /MAX_TURN_SECONDS = 15 \* 60/);
  assert.match(chatAdapter, /STREAM_HEARTBEAT_SECONDS = 15/);
  assert.match(chatAdapter, /timeout=MAX_TURN_SECONDS/);
  assert.match(chatAdapter, /asyncio\.wait\(\s*\{next_event\}, timeout=STREAM_HEARTBEAT_SECONDS/);
  assert.match(chatAdapter, /\^API call failed after \\d\+ retries:/);
  assert.match(chatAdapter, /raise RuntimeError\("Hermes could not complete the request"\)/);
  assert.match(hermesDesktopLauncher, /HERMES_DESKTOP_HERMES_ROOT=\/opt\/lemmacomputer\/hermes-agent/);
  assert.match(hermesDesktopLauncher, /Hermes --no-sandbox/);
  assert.match(entrypoint, /LemmaComputer-Agent\.desktop/);
  assert.match(entrypoint, /Hermes-Claw\.desktop/);
  assert.match(entrypoint, /lemmacomputer-hermes-agent-cli\.desktop.*Hermes-Agent-CLI\.desktop/);
  assert.doesNotMatch(entrypoint, /lemmacomputer-hermes-claw\.desktop/);
  for (const selection of ["google-chrome", "claude-cli", "codex-cli", "hermes-desktop"]) {
    assert.match(entrypoint, new RegExp(selection));
  }
  assert.match(entrypoint, /chmod 0700 \/opt\/google\/chrome\/google-chrome/);
  assert.match(entrypoint, /remove_stale_chrome_singletons/);
  for (const singleton of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    assert.match(entrypoint, new RegExp(singleton));
  }
  assert.match(entrypoint, /pgrep -u 1000/);
  assert.match(entrypoint, /chmod 0700 \/usr\/local\/bin\/lemmacomputer-claude/);
  assert.match(entrypoint, /chmod 0700 \/usr\/local\/bin\/lemmacomputer-hermes-desktop/);
  assert.match(gatewayProxy, /\{4312, 4314, 4315, 4316, 4317\}/);
  for (const port of [4312, 4314, 4315, 4316, 4317]) {
    assert.match(mcpBridge, new RegExp(`127\\.0\\.0\\.1:${port}`));
  }
  assert.match(mcpBridge, /server_label\.removeprefix\("lemmacomputer_"\)/);
  assert.match(mcpBridge, /server_label == "ms365"/);
  assert.match(mcpBridge, /visible_name = f"\{server_label\}__\{upstream_name\}"/);
});

test("the Hermes sandbox gateway includes its pinned private API runtime without a home-log ownership collision", async () => {
  const dockerfile = await source("docker/Dockerfile.workspace");
  const entrypoint = await source("docker/workspace/lemmacomputer-workspace-entrypoint.sh");
  const profileConfig = await source("docker/workspace/lemmacomputer-hermes-config.py");
  assert.match(dockerfile, /aiohttp==3\.14\.1/);
  assert.match(dockerfile, /import aiohttp/);
  assert.match(dockerfile, /uv pip install[\s\S]*mcp==1\.26\.0[\s\S]*starlette==1\.0\.1/);
  assert.match(dockerfile, /importlib\.metadata\.version\("mcp"\).*1\.26\.0/);
  assert.match(entrypoint, /hermes gateway run/);
  assert.match(profileConfig, /managed_office_toolsets = \["file", "skills", "terminal", "vision"\]/);
  assert.match(profileConfig, /cli_toolsets = managed_office_toolsets \+ \["lemmacomputer_connectors"\]/);
  assert.match(profileConfig, /api_toolsets = managed_office_toolsets \+ \["lemmacomputer_connectors"\]/);
  assert.match(profileConfig, /cli_toolsets = \["hermes-cli", "lemmacomputer_connectors"\]/);
  assert.match(profileConfig, /api_toolsets = \["hermes-api-server", "lemmacomputer_connectors"\]/);
  assert.match(profileConfig, /"reasoning_effort": False/);
  assert.match(entrypoint, /\/run\/lemmacomputer\/hermes-gateway-bootstrap\.log/);
  assert.doesNotMatch(entrypoint, />>\/home\/kasm-user\/\.hermes\/logs\/gateway\.log/);
});
