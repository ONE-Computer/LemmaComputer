import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Workspace is the single multi-workspace overview without redundant reassurance or activity", async () => {
  const [app, ui] = await Promise.all([
    source("apps/web/src/App.jsx"),
    source("apps/web/src/ui.jsx"),
  ]);
  assert.match(app, /<h1>Your workspaces<\/h1>/);
  assert.match(app, /home: "Workspace"/);
  assert.match(app, /label="Workspace"/);
  assert.match(app, /workspace-overview-list/);
  assert.match(app, /WorkspaceAssignment label="Apps"/);
  assert.match(app, /WorkspaceAssignment label="Agents"/);
  assert.match(app, /WorkspaceAssignment label="Model"/);
  assert.match(app, /WorkspaceAssignment label="Policy"/);
  assert.match(app, /policyAssignment\.version/);
  assert.doesNotMatch(app, /Native copy and paste/);
  assert.doesNotMatch(app, /Controlled internet access/);
  assert.doesNotMatch(app, /Recent governed operation/);
  assert.doesNotMatch(app, /Your assigned capabilities/);
  assert.doesNotMatch(app, /sandbox: "Sandbox"/);
  assert.doesNotMatch(app, /label="Sandbox"/);
  assert.doesNotMatch(ui, /PRIVATE_KEY|SIGNING_PRIVATE|provider credential/i);
});

test("Workspace configuration is reached from its overview card instead of a duplicate Sandbox inventory", async () => {
  const app = await source("apps/web/src/App.jsx");
  assert.match(app, /function WorkspaceConfigurationScreen/);
  assert.doesNotMatch(app, /function SandboxScreen/);
  assert.match(app, /onManage=\{selectWorkspaceConfiguration\}/);
  assert.match(app, /title="Create workspace"/);
  assert.doesNotMatch(app, /title="Create a managed sandbox"/);
});

test("workspace creation collects configuration before provisioning", async () => {
  const app = await source("apps/web/src/App.jsx");
  const createNameStep = app.slice(app.indexOf("const createAdditionalWorkspace"), app.indexOf("const configureMicrosoft365"));
  const saveStep = app.slice(app.indexOf("const saveWorkspaceSettings"), app.indexOf("const selectNav"));
  assert.match(app, /confirmLabel="Continue to configuration"/);
  assert.match(app, /Choose the profile, applications, agents, and model before ONEComputer starts this workspace/);
  assert.match(createNameStep, /selectWorkspaceConfiguration\(grantId\)/);
  assert.doesNotMatch(createNameStep, /workspaceApi\.create/);
  assert.ok(saveStep.indexOf("sandboxApi.save(sandboxConfiguration)") < saveStep.indexOf("workspaceApi.create(configuration.grantId)"));
  assert.match(saveStep, /!homeWorkspaces\.some/);
  assert.match(app, /creatingWorkspace \? "Create workspace" : "Save configuration"/);
});

test("workspace setup makes disposable-open an explicit accessible choice with durable lifecycle guidance", async () => {
  const [app, styles] = await Promise.all([
    source("apps/web/src/App.jsx"),
    source("apps/web/src/styles.css"),
  ]);
  assert.match(app, /type="radio"/);
  assert.match(app, /name="workspace-profile"/);
  assert.match(app, /<h2 id="workspace-profile-heading">Workspace access<\/h2>/);
  assert.match(app, /This does not choose your AI agent/);
  assert.match(app, /Claude Desktop is only enabled when you select it there/);
  assert.match(app, /profile\.executionMode === "disposable-open"/);
  assert.match(app, /Non-sensitive work only/);
  assert.match(app, /Stop keeps this workspace and pauses schedules; restarting restores it and resumes future schedules/);
  assert.match(app, /Delete permanently removes its files, schedules, logs, and installed tools/);
  assert.match(app, /Group and rule changes apply live without restarting/);
  assert.match(app, /Public HTTP and HTTPS are allowed by default; matching Deny rules block exceptions/);
  assert.match(styles, /\.workspace-profile-option:has\(input:focus-visible\)/);
  assert.match(styles, /\.disposable-profile-warning/);
});

test("workspace channels are compact, optional, and do not participate in configuration validation", async () => {
  const app = await source("apps/web/src/App.jsx");
  const channels = app.slice(app.indexOf("function TelegramChannelSection"), app.indexOf("function ConnectionsScreen"));
  assert.match(channels, /<details className="sandbox-management-section workspace-channels-section/);
  assert.match(channels, /<h2 id="workspace-channels-heading">Channels<\/h2><em>Optional<\/em>/);
  assert.match(channels, /<strong>Telegram<\/strong>/);
  assert.match(channels, /<strong>Slack<\/strong>/);
  assert.match(channels, /Coming soon/);
  assert.match(channels, /Create this workspace without a channel/);
  assert.doesNotMatch(channels, /telegram-allowed-user-ids"[^>]+required/);
  const footer = app.slice(app.indexOf('<div className="sandbox-management-footer">'), app.indexOf("<details className=\"sandbox-json\""));
  assert.doesNotMatch(footer, /telegram|credential|channel/i);
});

test("Telegram is workspace-scoped while typed credentials live under Settings", async () => {
  const app = await source("apps/web/src/App.jsx");
  const connections = app.slice(app.indexOf("function ConnectionsScreen"), app.indexOf("function ChatPart"));
  assert.match(app, /function TelegramChannelSection/);
  assert.match(app, /id="workspace-channels-heading">Channels/);
  assert.match(app, /function CredentialsScreen/);
  assert.match(app, /Settings → Credentials/);
  assert.doesNotMatch(connections, /TelegramDetail|telegram-title|onSaveTelegram/);
});

test("critical UI paths use owned accessible dialogs, skip targets, live state, and current dates", async () => {
  const [app, companion, ui] = await Promise.all([
    source("apps/web/src/App.jsx"),
    source("apps/web/src/CompanionApp.jsx"),
    source("apps/web/src/ui.jsx"),
  ]);
  assert.doesNotMatch(`${app}\n${companion}`, /window\.(confirm|prompt)/);
  assert.match(app, /href="#main-content"/);
  assert.match(companion, /href="#companion-main"/);
  assert.match(app, /aria-controls="primary-navigation"/);
  assert.match(ui, /aria-modal="true"/);
  assert.match(ui, /event\.key !== "Tab"/);
  assert.match(app, /new Intl\.DateTimeFormat/);
  assert.doesNotMatch(app, /dateTime="2026-/);
});

test("Companion exposes Chat and approvals through the compact top-bar switch", async () => {
  const [app, companion, companionStyles, styles, manifest] = await Promise.all([
    source("apps/web/src/App.jsx"),
    source("apps/web/src/CompanionApp.jsx"),
    source("apps/web/src/companion.css"),
    source("apps/web/src/styles.css"),
    source("apps/web/public/companion.webmanifest"),
  ]);
  assert.match(app, /export function ChatScreen/);
  assert.match(companion, /import \{ ChatScreen \} from "\.\/App\.jsx"/);
  assert.match(companion, /className="companion-mode-switch"/);
  assert.match(companion, /aria-label="Primary navigation"/);
  assert.match(companion, /aria-label="Companion"/);
  assert.match(companion, /Sign out \$\{session\.user\.displayName\}/);
  assert.match(companion, /activeView === "chat"/);
  assert.match(companion, /<ChatScreen/);
  assert.match(companion, /companionComposer/);
  assert.match(companion, /className="companion-tabs"/);
  assert.match(companion, /Approvals\{request/);
  assert.match(companion, /Activity/);
  assert.doesNotMatch(companion, /companion-destinations/);
  assert.match(app, /companion-chat-composer/);
  assert.match(app, /className="companion-chat-context-button"/);
  assert.match(app, /<span>\{contextSummary\}<\/span>/);
  assert.match(app, /New conversation/);
  assert.match(app, /Recent conversations/);
  assert.match(app, /ariaLabel="Choose workspace"/);
  assert.match(app, /sessions=\{chatSessions\}[\s\S]*companionComposer[\s\S]*historyHasMore=\{chatHistoryHasMore\}/);
  assert.match(app, /className="chat-error-retry"[\s\S]*setHistoryReload/);
  assert.match(app, /className="companion-chat-composer-control actions-control"[\s\S]*\{messageField\}[\s\S]*className="companion-chat-composer-control context-control"/);
  assert.doesNotMatch(app, /companion-chat-composer-spacer/);
  assert.match(styles, /\.chat-composer\.companion-chat-composer\s*\{[\s\S]*max-width:\s*768px/);
  assert.match(styles, /\.companion-chat-composer-row\s*\{[\s\S]*grid-template-columns:\s*36px minmax\(0, 1fr\) minmax\(0, auto\) 36px/);
  assert.match(companionStyles, /\.companion-mode-switch\s*\{/);
  assert.doesNotMatch(companionStyles, /\.companion-destinations/);
  assert.match(manifest, /Chat with workspace agents and review protected ONEComputer actions/);
});

test("workspace options are editable, opt-in, and explain the required restart after save", async () => {
  const [app, ui] = await Promise.all([
    source("apps/web/src/App.jsx"),
    source("apps/web/src/ui.jsx"),
  ]);
  assert.match(app, /catalogId: "claude-cli"/);
  assert.match(app, /catalogId: "hermes-desktop"/);
  assert.doesNotMatch(app, /name: "Google Chrome"[\s\S]+Coming soon/);
  assert.match(app, /setRestartNoticeOpen\(true\)/);
  assert.match(app, /title="Restart required"/);
  assert.match(app, /next launch will expose the selected applications and AI agent clients/);
  assert.match(ui, /export function NoticeDialog/);
  assert.match(ui, /source of truth for the next workspace launch/);
});

test("top-level navigation is URL-backed and follows browser history", async () => {
  const app = await source("apps/web/src/App.jsx");
  assert.match(app, /navFromLocation/);
  assert.match(app, /useState\(navFromLocation\)/);
  assert.match(app, /window\.history\.pushState/);
  assert.match(app, /addEventListener\("popstate"/);
  assert.match(app, /searchParams\.set\("view", viewByNav\[name\]\)/);
});

test("Trail owns approval-device management while Connections stays focused on service setup", async () => {
  const app = await source("apps/web/src/App.jsx");
  const activityScreen = app.slice(app.indexOf("function ActivityScreen"), app.indexOf("const pendingApplications"));
  const connectionsScreen = app.slice(app.indexOf("function ConnectionsScreen"), app.indexOf("function ChatScreen"));
  assert.match(app, /getBrowserApproverIdentity,/);
  assert.match(app, /getApprovalDeviceContext/);
  assert.match(app, /trail: "Trail"/);
  assert.match(app, /label="Trail"/);
  assert.doesNotMatch(app, /view === "activity"/);
  assert.match(activityScreen, /<h1>Trail<\/h1>/);
  assert.match(activityScreen, /<ApprovalDeviceCard displayName=\{displayName\}/);
  assert.doesNotMatch(connectionsScreen, /ApprovalDeviceCard/);
  assert.match(app, /Ready on another device/);
  assert.match(app, /Open the Approval Companion there to approve or deny this request/);
  assert.doesNotMatch(app, /Replace with this browser|Each account uses one active approval device/);
});

test("Connections stays employee-facing and uses spacing instead of decorative rules", async () => {
  const [app, styles] = await Promise.all([
    source("apps/web/src/App.jsx"),
    source("apps/web/src/styles.css"),
  ]);
  const connections = app.slice(app.indexOf("function Microsoft365Detail"), app.indexOf("function ChatPart"));
  const addConnector = app.slice(app.indexOf("const emptyConnectorDraft"), app.indexOf("function ConnectionsScreen"));
  assert.match(connections, /Your services/);
  assert.match(connections, /Connect the work services you want to use/);
  assert.doesNotMatch(connections, /LiteLLM|OAuth credentials|refresh tokens|MCP catalog|MCP connector/);
  assert.match(styles, /\.connections-page-intro > \.page-heading\s*\{[\s\S]*?border-bottom: 0/);
  assert.match(styles, /\.connector-category-heading\s*\{[\s\S]*?border-bottom: 0/);
  assert.match(styles, /\.connector-mark\.microsoft\s*\{[\s\S]*?place-content: center/);
  assert.match(connections, /const \[showCredentials, setShowCredentials\] = useState\(false\)/);
  assert.match(connections, /\{showCredentials && <section className="add-connector-app-credentials"/);
  assert.match(connections, /Connection setup is automatic\. No provider credentials are needed\./);
  assert.doesNotMatch(connections, /<details className="add-connector-app-credentials"/);
  assert.doesNotMatch(addConnector, /connector-services|connector-scopes|Requested scopes/);
  assert.match(connections, /Tools &amp; approvals/);
  assert.match(connections, /connector-\$\{selected\.id\}-tools/);
});

test("connector checks explain invalid input instead of appearing permanently busy", async () => {
  const connections = await source("apps/web/src/App.jsx");
  const styles = await source("apps/web/src/styles.css");
  assert.match(connections, /description: description\.length >= 3 \? description : draft\.shortDescription\.trim\(\)/);
  assert.match(connections, /Connection description <em>Optional<\/em>/);
  assert.match(connections, /onClick=\{discover\} disabled=\{Boolean\(busy\)\} aria-busy=\{busy === "checking"\}/);
  assert.match(connections, /if \(validationError\) \{\s+setError\(validationError\);/);
  assert.match(styles, /\.primary-button:disabled,[\s\S]*?cursor: not-allowed;/);
  assert.match(styles, /\.primary-button\[aria-busy="true"\],[\s\S]*?cursor: progress;/);
});

test("custom connectors use their own initial and support bounded icon uploads", async () => {
  const [app, api, styles] = await Promise.all([
    source("apps/web/src/App.jsx"),
    source("apps/web/src/workspace-api.js"),
    source("apps/web/src/styles.css"),
  ]);
  assert.match(app, /connector\?\.name\?\.trim\(\)\.match\(\/\[\\p\{L\}\\p\{N\}\]\//);
  assert.doesNotMatch(app, /\[brand\] \?\? "M"/);
  assert.match(app, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(app, /Connector icons must be 256 KB or smaller/);
  assert.match(app, /<ConnectorIconEditor connector=\{connector\}/);
  assert.match(app, /connector\.source === "custom" && !connected/);
  assert.match(api, /saveConnectorIcon:/);
  assert.match(styles, /\.connector-mark\.uploaded img/);
});

test("remote-only approvals notify desktop without opening its decision drawer", async () => {
  const app = await source("apps/web/src/App.jsx");
  assert.match(app, /approvalContext\.localReady \|\| !approvalContext\.accountStatus\.connected/);
  assert.match(app, /setDrawer\("request"\)/);
  assert.match(app, /Approval sent to \$\{approvalContext\.accountStatus\.approver\.displayName\}/);
});

test("the consent-task schema is repaired additively for existing installations", async () => {
  const [store, migration] = await Promise.all([
    source("packages/workspace-store/src/index.ts"),
    source("packages/workspace-store/migrations/017_openvtc_request_proof_hash.sql"),
  ]);
  assert.match(store, /017_openvtc_request_proof_hash\.sql/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS request_proof_hash/);
  assert.match(migration, /request_proof_hash IS NULL OR length\(request_proof_hash\) = 64/);
  assert.doesNotMatch(migration, /UPDATE[\s\S]+request_proof_hash/i);
});

test("desktop pages share the wider workspace content cap", async () => {
  const styles = await source("apps/web/src/styles.css");
  assert.match(styles, /\.home-screen,\s*\.secondary-screen\s*\{\s*width: min\(100%, 1440px\)/);
  assert.doesNotMatch(styles, /\.secondary-screen\s*\{\s*max-width: 1000px/);
  assert.doesNotMatch(styles, /\.connections-screen\s*\{\s*max-width: 1000px/);
});

test("desktop navigation has a wider persistent sidebar without widening the mobile drawer", async () => {
  const styles = await source("apps/web/src/styles.css");
  assert.match(styles, /--desktop-sidebar-width: 336px/);
  assert.match(styles, /\.sidebar\s*\{[\s\S]*?width: var\(--desktop-sidebar-width\)/);
  assert.match(styles, /\.main-content\s*\{[\s\S]*?margin-left: var\(--desktop-sidebar-width\)/);
  assert.match(styles, /@media \(max-width: 880px\) \{\s*\.sidebar\s*\{\s*width: 292px/);
});

test("desktop pages begin at one shared top-bar offset without compact-page padding", async () => {
  const styles = await source("apps/web/src/styles.css");
  assert.match(styles, /\.topbar\s*\{\s*display: flex;\s*min-height: 48px/);
  assert.match(styles, /\.home-screen,\s*\.secondary-screen\s*\{[\s\S]*?margin: 0 auto/);
  assert.doesNotMatch(styles, /\.page-heading\.compact\s*\{\s*padding-top:/);
  assert.match(styles, /@media \(max-width: 880px\) \{[\s\S]*?\.home-screen,\s*\.secondary-screen\s*\{\s*margin-top: 32px/);
});

test("the account menu owns Settings, with Gateway and Administration out of primary navigation", async () => {
  const app = await source("apps/web/src/App.jsx");
  const primaryNav = app.slice(app.indexOf('<nav aria-label="Primary navigation">'), app.indexOf("</nav>", app.indexOf('<nav aria-label="Primary navigation">')));
  const accountMenu = app.slice(app.indexOf('id="sidebar-account-menu"'), app.indexOf("</aside>", app.indexOf('id="sidebar-account-menu"')));
  assert.match(app, /settings: "Settings"/);
  assert.match(app, /function SettingsScreen/);
  assert.match(app, /<strong>Gateway<\/strong>/);
  assert.match(app, /<strong>Administration<\/strong>/);
  assert.doesNotMatch(primaryNav, /label="Admin"|label="Gateway"/);
  assert.match(accountMenu, /selectNav\("Settings"\)/);
  assert.match(accountMenu, /Log out/);
  assert.doesNotMatch(app, /admin: "Admin"/);
});

test("administration exposes member lifecycle, workspace management, and organization connector locks", async () => {
  const app = await readFile(new URL("../apps/web/src/App.jsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../apps/web/src/workspace-api.js", import.meta.url), "utf8");
  assert.match(app, /Suspend user/);
  assert.match(app, /Reactivate/);
  assert.match(app, /Sign out sessions/);
  assert.match(app, /Manage \{workspaceName\(workspace\)\}/);
  assert.match(app, /Members can manage connections/);
  assert.match(app, /Connector enabled/);
  assert.match(api, /admin\/users\/.*\/status/);
  assert.match(api, /admin\/users\/.*\/sandbox-settings/);
  assert.match(api, /connectors\/.*\/access-policy/);
});

test("Help is retired from navigation and routing", async () => {
  const app = await source("apps/web/src/App.jsx");
  assert.doesNotMatch(app, /help: "Help"/);
  assert.doesNotMatch(app, /function HelpScreen/);
  assert.doesNotMatch(app, /label="Help"/);
});

test("Chat is last in navigation, with recent threads in the sidebar and a focused composer", async () => {
  const [app, styles] = await Promise.all([
    source("apps/web/src/App.jsx"),
    source("apps/web/src/styles.css"),
  ]);
  const primaryNav = app.slice(app.indexOf('<nav aria-label="Primary navigation">'), app.indexOf("</nav>", app.indexOf('<nav aria-label="Primary navigation">')));
  const chatScreen = app.slice(app.indexOf("function ChatConversation"), app.indexOf("export function App"));
  assert.ok(primaryNav.indexOf('label="Chat"') > primaryNav.indexOf('label="Connections"'));
  assert.match(primaryNav, /sidebar-chat-history/);
  assert.match(primaryNav, /Recent chat threads/);
  assert.doesNotMatch(chatScreen, /chat-sessions/);
  assert.match(chatScreen, /<h1>How can \{agentName\} help\?<\/h1>/);
  assert.match(chatScreen, /ariaLabel="Choose chat agent"/);
  assert.match(chatScreen, /className="chat-send-button"/);
  assert.match(chatScreen, /useChat\(\{/);
  assert.match(chatScreen, /DefaultChatTransport/);
  assert.doesNotMatch(chatScreen, /"content-type": "application\/json"/);
  assert.match(chatScreen, /className="chat-stop-button"/);
  assert.match(chatScreen, /className="chat-attach-button"/);
  assert.match(chatScreen, /type="file"/);
  assert.match(chatScreen, /multiple/);
  assert.match(chatScreen, /onPaste=/);
  assert.match(chatScreen, /item\.type\.startsWith\("image\/"\)/);
  assert.match(chatScreen, /workspace\.modelRoute\?\.capabilities\?\.vision === true/);
  assert.match(chatScreen, /selected workspace model does not support image input/);
  assert.match(app, /part\.type === "file"/);
  assert.match(app, /part\.type === "data-approval"/);
  assert.match(app, /ReactMarkdown/);
  assert.match(app, /remarkGfm/);
  assert.match(chatScreen, /status === "submitted"/);
  assert.match(chatScreen, /Got it — I’m starting on that\./);
  assert.doesNotMatch(chatScreen, /chatApi\.send/);
  assert.match(styles, /\.chat-composer\s*\{[\s\S]*?border-radius: 26px/);
  assert.match(styles, /\.chat-message\s*\{\s*width: 100%;\s*max-width: 860px/);
  assert.match(styles, /\.chat-send-button:not\(:disabled\)\s*\{\s*background: var\(--navy\)/);
  assert.match(styles, /\.chat-attachment-preview\s*\{/);
  assert.match(styles, /\.chat-file-part\.image img\s*\{/);
  assert.match(styles, /\.chat-markdown\s*\{/);
});

test("Chat automatically recovers when a selected agent becomes healthy after the workspace reports ready", async () => {
  const app = await source("apps/web/src/App.jsx");
  assert.match(app, /status !== "offline"/);
  assert.match(app, /reasonCode !== "CHAT_RUNTIME_UNAVAILABLE"/);
  assert.match(app, /setTimeout\(\(\) => setReload\(\(value\) => value \+ 1\), 2000\)/);
  assert.match(app, /clearTimeout\(timeout\)/);
});

test("Chat keeps the selected conversation across a page refresh", async () => {
  const app = await source("apps/web/src/App.jsx");
  assert.match(app, /const chatSessionFromLocation/);
  assert.match(app, /useState\(chatSessionFromLocation\)/);
  assert.match(app, /setActiveChatSessionId\(chatSessionFromLocation\(\)\)/);
  assert.match(app, /const selectChatSession = \(sessionId, historyMode = "push"\)/);
  assert.match(app, /url\.searchParams\.set\("chat", sessionId\)/);
  assert.match(app, /activeNav !== "Chat" \|\| !activeChatSessionId/);
  assert.match(app, /onSessionChange=\{\(sessionId\) => selectChatSession\(sessionId, "replace"\)\}/);
  assert.doesNotMatch(app.slice(app.indexOf("function ChatScreen"), app.indexOf("export function App")), /onSessionChange\(""\);\s*setAgents/);
});

test("Chat selects a workspace before an agent, preserves both choices, and pages its history", async () => {
  const [app, api, styles] = await Promise.all([
    source("apps/web/src/App.jsx"),
    source("apps/web/src/workspace-api.js"),
    source("apps/web/src/styles.css"),
  ]);
  const chatScreen = app.slice(app.indexOf("function ChatScreen"), app.indexOf("export function App"));
  assert.match(chatScreen, /ariaLabel="Choose workspace"/);
  assert.match(chatScreen, /const workspaceOptions = workspaces\?\.length \? workspaces : workspace \? \[workspace\] : \[\];/);
  assert.doesNotMatch(chatScreen, /workspaces\?\.length > 1 && <div className="chat-agent-selector">/);
  assert.match(chatScreen, /preferredAgentId/);
  assert.match(chatScreen, /onAgentChange\?\.\(workspace\.id, preferred\.catalogId\)/);
  assert.match(app, /onecomputer\.active-workspace-id/);
  assert.match(app, /onecomputer\.active-chat-agent:/);
  assert.match(app, /sidebar-chat-load-more/);
  assert.match(api, /sessions: \(workspaceId, catalogId, \{ cursor, limit = 20 \} = \{\}\)/);
  assert.match(api, /query\.set\("cursor", cursor\)/);
  assert.match(styles, /\.sidebar-chat-history\s*\{[\s\S]*?flex: 1;/);
  assert.match(styles, /\.sidebar-chat-history\s*\{[\s\S]*?flex-direction: column;/);
  assert.match(styles, /\.sidebar-chat-history > button\s*\{[\s\S]*?min-height: 38px;/);
  assert.doesNotMatch(styles, /\.sidebar-chat-history\s*\{[\s\S]*?max-height: clamp/);
});

test("Firewall is a security-group library and workspace attachment stays in Workspace", async () => {
  const [app, styles] = await Promise.all([
    source("apps/web/src/App.jsx"),
    source("apps/web/src/styles.css"),
  ]);
  const firewallScreen = app.slice(app.indexOf("function FirewallScreen"), app.indexOf("function ActivityScreen"));
  assert.doesNotMatch(firewallScreen, /Workspace attachments/);
  assert.match(firewallScreen, /Create security group<\/button>/);
  assert.match(firewallScreen, /<h2 id="firewall-security-groups-heading">Security groups<\/h2>/);
  assert.match(firewallScreen, /Default applies to new workspaces/);
  assert.doesNotMatch(firewallScreen, /Effective workspace policies/);
  assert.doesNotMatch(firewallScreen, /<table>/);
  assert.match(app, /assignWorkspaceEgressSecurityGroup/);
  assert.match(app, /Security-group changes apply live/);
  assert.match(app, /function FirewallEditorDialog/);
  assert.doesNotMatch(app, /function FirewallAddRuleDialog/);
  assert.doesNotMatch(app, /setAddRuleContext/);
  assert.match(app, /Saved changes apply live to every workspace using the group/);
  assert.match(app, /id="firewall-add-rule-heading">Add rule/);
  assert.match(app, /value: "deny", label: "Deny"/);
  assert.match(firewallScreen, /firewall-default-badge/);
  assert.match(firewallScreen, /Built-in default/);
  assert.match(app, /Default security group behavior/);
  assert.match(firewallScreen, /Manage group/);
  assert.doesNotMatch(firewallScreen, /Add deny rule/);
  assert.doesNotMatch(firewallScreen, /onClick=\{\(\) => setEditor\(\{ securityGroupId: latestVersions\[0\]/);
  assert.match(app, /<ModalDialog/);
  assert.doesNotMatch(firewallScreen, /drawer/);
  assert.match(styles, /\.firewall-security-groups\s*\{/);
  assert.match(styles, /\.firewall-group-toolbar/);
  assert.match(styles, /\.modal-card\.firewall-editor-modal\s*\{\s*width: min\(100%, 880px\)/);
});

test("Select controls use the shared accessible menu instead of browser-native dropdowns", async () => {
  const [app, ui, uiStyles] = await Promise.all([
    source("apps/web/src/App.jsx"),
    source("apps/web/src/ui.jsx"),
    source("apps/web/src/ui.css"),
  ]);
  assert.match(app, /import \{ ConfirmDialog, ModalDialog, NoticeDialog, SelectMenu, TextPromptDialog \}/);
  assert.ok((app.match(/<SelectMenu/g) ?? []).length >= 9);
  assert.doesNotMatch(app, /<select/);
  assert.match(ui, /export function SelectMenu/);
  assert.match(ui, /role="combobox"/);
  assert.match(ui, /role="listbox"/);
  assert.match(ui, /event\.key === "ArrowDown"/);
  assert.match(ui, /createPortal/);
  assert.match(uiStyles, /\.select-menu-popup/);
  assert.match(uiStyles, /\.select-menu-trigger\[data-state="open"\]/);
  assert.match(app, /id="firewall-security-group-search" name="firewall-security-group-search"/);
  assert.match(app, /ariaLabel="Security group"/);
  assert.match(await source("apps/web/src/styles.css"), /@media \(max-width: 1180px\)[\s\S]*?\.firewall-page-heading[\s\S]*?flex-direction: column/);
});
