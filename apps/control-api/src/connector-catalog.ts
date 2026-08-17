import type { ConnectorRegistryRecord, SaveConnectorRegistryRecord } from "@lemmacomputer/workspace-store";

export type ConnectorDefinition = ConnectorRegistryRecord;

export type ConnectorActivationReadiness = "ready" | "setup_required" | "request_access";
export type ConnectorActivationAction = "connect" | "view_setup" | "view_requirements";

export type ConnectorActivation = {
  readiness: ConnectorActivationReadiness;
  action: ConnectorActivationAction;
  message: string;
};

// `withheld` withholds an entry unconditionally, for a provider no deployment
// can reach. The entry stays in source, so its name, branding, icon, and
// scopes survive and nothing has to be rebuilt when the blocking condition
// clears.
//
// `requiresCredentials` is different: it names the provider OAuth application
// the entry needs, which either the deployment configures for everyone or a
// tenant administrator supplies for its own organization. Such an entry is
// published either way and reports `setup_required` until one of those exists.
type CatalogConnector = Omit<SaveConnectorRegistryRecord, "tenantId"> & {
  withheld?: string;
  requiresCredentials?: StaticCredentialGroup;
  credentialSetup?: ConnectorCredentialSetup;
};

/**
 * What an administrator has to do in the provider's own console before the
 * client id and secret on this page will work. Registering an OAuth
 * application is several steps in an unfamiliar console, and getting the
 * redirect URI or the scopes wrong fails at the authorize redirect with an
 * error from the provider that says nothing about what to fix.
 *
 * `scopes` are the permissions the connector asks for. Where the catalog entry
 * declares none, the provider's own advertised set is used, so these are
 * recorded here rather than derived from `scopes` on the record.
 */
export type ConnectorCredentialSetup = {
  console: string;
  consoleUrl: string;
  clientType: string;
  steps: string[];
  scopes: string[];
  scopesNote: string;
};

const googleWorkspaceSetup = (api: string, scopes: string[]): ConnectorCredentialSetup => ({
  console: "Google Cloud console",
  consoleUrl: "https://console.cloud.google.com/auth/clients",
  clientType: "Web application",
  steps: [
    "Select or create a project in the Google Cloud console.",
    `Enable the ${api} for that project.`,
    "Open Google Auth Platform and set Audience. Choose Internal if the project belongs to your Google Workspace organization: an internal application skips Google's verification review, including the security assessment that the broader permissions below would otherwise require. External needs every person added as a test user while the application is unpublished, and its sign-ins stop working after seven days.",
    "Under Data Access, add the scopes listed below.",
    "Under Clients, create an OAuth client of type Web application and add the redirect URI shown below exactly, with no trailing slash.",
    "Copy the client ID and client secret from that client into this page.",
  ],
  scopes,
  scopesNote: "Add these under Data Access. They are the permissions this connector requests when someone connects.",
});

// Credential groups a deployment can configure. Each one is a provider OAuth
// application the operator registers, matching a coupled environment pair in
// scripts/deployment-config.mjs and a `client_id` in config/litellm/config.yaml.
export type StaticCredentialGroup = "google-workspace" | "github";
export const staticCredentialGroups: readonly StaticCredentialGroup[] = ["google-workspace", "github"];
export const isStaticCredentialGroup = (value: string): value is StaticCredentialGroup =>
  (staticCredentialGroups as readonly string[]).includes(value);

// LiteLLM keys `LiteLLM_MCPServerTable` on `server_id` alone, and the adapter
// resolves a connection by `server_name`. A tenant-owned row therefore needs a
// name that is unique across the whole gateway, not merely inside its tenant:
// two tenants each adding a connector called "Reports" would otherwise produce
// two rows named `lemmacomputer_reports` and resolve between them arbitrarily.
// The row's own `server_id` is already unique, so deriving the suffix from it
// makes the name unique by construction without putting the tenant id on the
// gateway. Keep this in step with the SQL in the connector server-name
// migration, which recomputes exactly this value.
const SERVER_NAME_LIMIT = 96;
export const tenantOwnedServerName = (connectorId: string, serverId: string) => {
  const discriminator = serverId.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
  const prefix = `lemmacomputer_${connectorId.replace(/-/g, "_")}`.slice(0, SERVER_NAME_LIMIT - discriminator.length - 1);
  return `${prefix}_${discriminator}`;
};

const remote = (connector: Omit<CatalogConnector, "policySupport" | "source" | "createdBy">): CatalogConnector => ({
  ...connector,
  policySupport: "automatic",
  source: "built-in",
  createdBy: "lemmacomputer",
});

// A provider that operates an allowlisted registration endpoint accepts only
// the OAuth clients it has approved by hostname, so no LemmaComputer
// installation can complete the flow. Withholding these is not a deployment
// gap; restoring one requires the provider to admit the deployment's callback
// origin or to issue static client credentials.
const REGISTRATION_ALLOWLISTED =
  "The provider restricts dynamic client registration to its own approved callback hosts";
// A provider that publishes no registration endpoint needs an operator-created
// OAuth application. Unlike Google Workspace and GitHub, these have no gateway
// row or environment pair yet, so no deployment can configure them. Restoring
// one means adding its `mcp_servers` entry to config/litellm/config.yaml, its
// coupled environment pair and credential group to
// scripts/deployment-config.mjs, then replacing this line with
// `requiresCredentials`.
const STATIC_CREDENTIALS_UNWIRED =
  "The provider publishes no registration endpoint and has no deployment credential group yet";

const readyActivation: ConnectorActivation = { readiness: "ready", action: "connect", message: "This approved service is ready to connect." };
// Catalog entries are approved remote MCP endpoints. Discovery and any
// provider-specific OAuth requirements are intentionally attempted only after
// the user selects Connect. A failed attempt remains disconnected, so no tools
// are projected into the workspace until authorization succeeds.
//
// The exception is a connector whose provider publishes no registration
// endpoint. Nobody can complete that flow until an OAuth application exists,
// so the card says so up front rather than sending someone to an authorize
// redirect that fails on an empty client id. Either the deployment configured
// the credential group, or this tenant supplied its own application.
export const connectorActivation = (
  connector: Pick<ConnectorDefinition, "id" | "source" | "credentialMode">,
  configuredCredentials: ReadonlySet<StaticCredentialGroup> = new Set(),
): ConnectorActivation => {
  if (connector.credentialMode === "tenant") return { ...readyActivation };
  const required = catalogCredentialRequirement(connector.id);
  if (!required || configuredCredentials.has(required)) return { ...readyActivation };
  return {
    readiness: "setup_required",
    action: "view_setup",
    message: "This service needs an OAuth application from your organization before anyone can connect it.",
  };
};

// A provider whose catalog entry asks for tenant-wide permissions that no
// ordinary user can consent to. Microsoft 365 requests Team.ReadBasic.All,
// Channel.ReadBasic.All, and ChannelMessage.Read.All, so a directory
// administrator must approve the application for the whole organization before
// anyone in it can finish connecting. Without that, an employee reaches a
// terminal "Need admin approval" page and never returns, and the Connections
// screen shows nothing but a connector that stayed disconnected.
export type AdminConsentProvider = "microsoft";
export const catalogAdminConsentProvider = (connectorId: string): AdminConsentProvider | undefined =>
  connectorId === "microsoft-365" ? "microsoft" : undefined;

// The credential group a catalog entry depends on, if any. Custom connectors
// carry their credentials from the moment they are added, so they are never
// listed here.
export const catalogCredentialRequirement = (connectorId: string): StaticCredentialGroup | undefined =>
  remoteCatalog.find((connector) => connector.id === connectorId)?.requiresCredentials;

// What an administrator has to do in the provider's own console before the
// credentials they enter will work. Display-only, and safe to show to anyone
// who may enter credentials.
export const catalogCredentialSetup = (connectorId: string): ConnectorCredentialSetup | undefined =>
  remoteCatalog.find((connector) => connector.id === connectorId)?.credentialSetup;

// These are provider-hosted remote MCP endpoints, not a tool allowlist. The
// Connections screen may display the full catalog without registering every
// server. Control registers one only after its owner selects Connect, and the
// runtime projection still requires that person's successful connection.
const remoteCatalog: CatalogConnector[] = [
  remote({
    id: "gmail",
    requiresCredentials: "google-workspace",
    credentialSetup: googleWorkspaceSetup("Gmail API", [
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.metadata",
    ]),
    serverId: "lemmacomputer_gmail",
    serverName: "lemmacomputer_gmail",
    name: "Gmail",
    shortDescription: "Search mail and prepare follow-ups",
    description: "Use the Gmail messages, drafts, and mailbox context your Google Workspace account authorizes.",
    category: "Productivity",
    services: ["Mail", "Drafts", "Search"],
    endpointUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    authorizationOrigins: ["https://accounts.google.com", "https://oauth2.googleapis.com"],
    scopes: [],
    brand: "gmail",
  }),
  remote({
    id: "google-drive",
    requiresCredentials: "google-workspace",
    credentialSetup: googleWorkspaceSetup("Google Drive API", [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ]),
    serverId: "lemmacomputer_google_drive",
    serverName: "lemmacomputer_google_drive",
    name: "Google Drive",
    shortDescription: "Find and work with shared files",
    description: "Use the Google Drive files and folders your Google Workspace account authorizes.",
    category: "Productivity",
    services: ["Files", "Folders", "Search"],
    endpointUrl: "https://drivemcp.googleapis.com/mcp/v1",
    authorizationOrigins: ["https://accounts.google.com", "https://oauth2.googleapis.com"],
    scopes: [],
    brand: "google-drive",
  }),
  remote({
    id: "google-calendar",
    requiresCredentials: "google-workspace",
    credentialSetup: googleWorkspaceSetup("Google Calendar API", [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.acls",
      "https://www.googleapis.com/auth/calendar.calendarlist",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.calendars",
      "https://www.googleapis.com/auth/calendar.calendars.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.freebusy",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.settings.readonly",
    ]),
    serverId: "lemmacomputer_google_calendar",
    serverName: "lemmacomputer_google_calendar",
    name: "Google Calendar",
    shortDescription: "Review availability and manage events",
    description: "Use the Google Calendar events and availability your Google Workspace account authorizes.",
    category: "Productivity",
    services: ["Events", "Availability", "Scheduling"],
    endpointUrl: "https://calendarmcp.googleapis.com/mcp/v1",
    authorizationOrigins: ["https://accounts.google.com", "https://oauth2.googleapis.com"],
    scopes: [],
    brand: "google-calendar",
  }),
  remote({
    id: "notion",
    serverId: "lemmacomputer_notion",
    serverName: "lemmacomputer_notion",
    name: "Notion",
    shortDescription: "Search and update workspace knowledge",
    description: "Search and update the pages, databases, and knowledge your Notion account can access.",
    category: "Productivity",
    services: ["Pages", "Databases", "Search"],
    endpointUrl: "https://mcp.notion.com/mcp",
    authorizationOrigins: ["https://mcp.notion.com"],
    scopes: ["default"],
    brand: "notion",
  }),
  remote({
    id: "linear",
    serverId: "lemmacomputer_linear",
    serverName: "lemmacomputer_linear",
    name: "Linear",
    shortDescription: "Plan projects, issues, and product work",
    description: "Plan and follow product work across the issues, projects, and comments your account can access.",
    category: "Productivity",
    services: ["Issues", "Projects", "Comments"],
    endpointUrl: "https://mcp.linear.app/mcp",
    authorizationOrigins: ["https://mcp.linear.app"],
    scopes: ["read"],
    brand: "linear",
  }),
  remote({
    id: "atlassian",
    serverId: "lemmacomputer_atlassian",
    serverName: "lemmacomputer_atlassian",
    name: "Atlassian",
    shortDescription: "Work across Jira and Confluence",
    description: "Bring approved Jira work and Confluence knowledge into your workspace.",
    category: "Productivity",
    services: ["Jira", "Confluence", "Teamwork Graph"],
    endpointUrl: "https://mcp.atlassian.com/v1/mcp/authv2",
    authorizationOrigins: ["https://auth.atlassian.com"],
    scopes: [
      "read:me",
      "read:account",
      "offline_access",
      "email",
      "read:jira-work",
      "search:confluence",
      "read:confluence-user",
      "read:page:confluence",
      "read:comment:confluence",
      "read:space:confluence",
    ],
    brand: "atlassian",
  }),
  remote({
    id: "asana",
    withheld: STATIC_CREDENTIALS_UNWIRED,
    serverId: "lemmacomputer_asana",
    serverName: "lemmacomputer_asana",
    name: "Asana",
    shortDescription: "Manage tasks, projects, and reports",
    description: "Work with the tasks and projects your Asana account is authorized to access.",
    category: "Productivity",
    services: ["Tasks", "Projects", "Reports"],
    endpointUrl: "https://mcp.asana.com/v2/mcp",
    authorizationOrigins: ["https://mcp.asana.com", "https://app.asana.com"],
    scopes: [],
    brand: "asana",
  }),
  remote({
    id: "figma",
    withheld: REGISTRATION_ALLOWLISTED,
    serverId: "lemmacomputer_figma",
    serverName: "lemmacomputer_figma",
    name: "Figma",
    shortDescription: "Use design context from Figma files",
    description: "Retrieve the design context, variables, and components your Figma account can access.",
    category: "Productivity",
    services: ["Design context", "Components", "Variables"],
    endpointUrl: "https://mcp.figma.com/mcp",
    authorizationOrigins: ["https://mcp.figma.com", "https://www.figma.com"],
    scopes: [],
    brand: "figma",
  }),
  remote({
    id: "canva",
    serverId: "lemmacomputer_canva",
    serverName: "lemmacomputer_canva",
    name: "Canva",
    shortDescription: "Create and update designs with approved assets",
    description: "Create, edit, search, and export the Canva designs, assets, and brand content your account authorizes.",
    category: "Productivity",
    services: ["Designs", "Assets", "Brand kits"],
    endpointUrl: "https://mcp.canva.com/mcp",
    authorizationOrigins: ["https://mcp.canva.com"],
    scopes: [],
    brand: "canva",
  }),
  remote({
    id: "monday",
    serverId: "lemmacomputer_monday",
    serverName: "lemmacomputer_monday",
    name: "monday.com",
    shortDescription: "Manage boards, items, and workflows",
    description: "Use the monday.com boards, items, and workflows your account authorizes.",
    category: "Productivity",
    services: ["Boards", "Items", "Workflows"],
    endpointUrl: "https://mcp.monday.com/mcp",
    // Monday delegates authorization, token, and registration to auth.monday.com.
    authorizationOrigins: ["https://mcp.monday.com", "https://auth.monday.com"],
    scopes: [],
    brand: "monday",
  }),
  remote({
    id: "clickup",
    serverId: "lemmacomputer_clickup",
    serverName: "lemmacomputer_clickup",
    name: "ClickUp",
    shortDescription: "Work with tasks, docs, and workspace work",
    description: "Use the ClickUp tasks, documents, and workspace context your account authorizes.",
    category: "Productivity",
    services: ["Tasks", "Docs", "Workspace search"],
    endpointUrl: "https://mcp.clickup.com/mcp",
    authorizationOrigins: ["https://mcp.clickup.com", "https://app.clickup.com"],
    scopes: [],
    brand: "clickup",
  }),
  remote({
    id: "calendly",
    serverId: "lemmacomputer_calendly",
    serverName: "lemmacomputer_calendly",
    name: "Calendly",
    shortDescription: "Manage scheduling and availability",
    description: "Use the Calendly scheduling links, event types, availability, and meetings your account authorizes.",
    category: "Productivity",
    services: ["Availability", "Event types", "Scheduling"],
    endpointUrl: "https://mcp.calendly.com",
    authorizationOrigins: ["https://calendly.com"],
    scopes: ["mcp:scheduling:read", "mcp:scheduling:write"],
    brand: "calendly",
  }),
  remote({
    id: "fireflies",
    serverId: "lemmacomputer_fireflies",
    serverName: "lemmacomputer_fireflies",
    name: "Fireflies.ai",
    shortDescription: "Search meeting transcripts and action items",
    description: "Use the Fireflies meeting transcripts, summaries, action items, and insights your account authorizes.",
    category: "Productivity",
    services: ["Transcripts", "Summaries", "Action items"],
    endpointUrl: "https://api.fireflies.ai/mcp",
    authorizationOrigins: ["https://api.fireflies.ai"],
    scopes: [],
    brand: "fireflies",
  }),
  remote({
    id: "box",
    withheld: STATIC_CREDENTIALS_UNWIRED,
    serverId: "lemmacomputer_box",
    serverName: "lemmacomputer_box",
    name: "Box",
    shortDescription: "Search, organize, and use Box content",
    description: "Use files, folders, and Box AI features allowed by your Box account.",
    category: "Productivity",
    services: ["Files", "Folders", "Search"],
    endpointUrl: "https://mcp.box.com",
    authorizationOrigins: ["https://mcp.box.com", "https://account.box.com"],
    scopes: [],
    brand: "box",
  }),
  remote({
    id: "exa",
    serverId: "lemmacomputer_exa",
    serverName: "lemmacomputer_exa",
    name: "Exa",
    shortDescription: "Search the web",
    description: "Find current web information and read page content through Exa search.",
    category: "Search",
    services: ["Web search", "Page content", "Research"],
    endpointUrl: "https://mcp.exa.ai/mcp",
    authorizationOrigins: ["https://auth.exa.ai"],
    scopes: ["mcp:tools"],
    brand: "exa",
  }),
  remote({
    id: "github",
    requiresCredentials: "github",
    credentialSetup: {
      console: "GitHub developer settings",
      consoleUrl: "https://github.com/settings/developers",
      clientType: "OAuth app",
      steps: [
        "Open your organization's Settings, then Developer settings, then OAuth Apps.",
        "Create a new OAuth app owned by the organization rather than by one person, so it survives that person leaving.",
        "Set the Authorization callback URL to the redirect URI shown below exactly, with no trailing slash.",
        "Generate a client secret on the app you just created.",
        "Copy the client ID and client secret into this page.",
      ],
      scopes: ["repo", "read:org", "read:user", "user:email"],
      scopesNote: "GitHub asks for these when each person connects, so there is nothing to configure for them on the OAuth app itself.",
    },
    serverId: "lemmacomputer_github",
    serverName: "lemmacomputer_github",
    name: "GitHub",
    shortDescription: "Repositories, issues, and pull requests",
    description: "Work with repositories, issues, and pull requests allowed by your GitHub organization.",
    category: "Developer tools",
    services: ["Repositories", "Issues", "Pull requests"],
    endpointUrl: "https://api.githubcopilot.com/mcp/",
    authorizationOrigins: ["https://github.com"],
    scopes: ["repo", "read:org", "read:user", "user:email"],
    brand: "github",
  }),
  remote({
    id: "vercel",
    withheld: REGISTRATION_ALLOWLISTED,
    serverId: "lemmacomputer_vercel",
    serverName: "lemmacomputer_vercel",
    name: "Vercel",
    shortDescription: "Manage projects, deployments, and logs",
    description: "Use the Vercel projects and deployments your account authorizes.",
    category: "Developer tools",
    services: ["Projects", "Deployments", "Logs"],
    endpointUrl: "https://mcp.vercel.com",
    authorizationOrigins: ["https://mcp.vercel.com", "https://vercel.com"],
    scopes: [],
    brand: "vercel",
  }),
  remote({
    id: "supabase",
    serverId: "lemmacomputer_supabase",
    serverName: "lemmacomputer_supabase",
    name: "Supabase",
    shortDescription: "Work with Supabase projects and data",
    description: "Use the Supabase projects, database, and development tools your account authorizes.",
    category: "Developer tools",
    services: ["Projects", "Database", "Functions"],
    endpointUrl: "https://mcp.supabase.com/mcp",
    // Supabase serves OAuth metadata and all three endpoints from api.supabase.com.
    authorizationOrigins: ["https://mcp.supabase.com", "https://supabase.com", "https://api.supabase.com"],
    scopes: [],
    brand: "supabase",
  }),
  remote({
    id: "neon",
    serverId: "lemmacomputer_neon",
    serverName: "lemmacomputer_neon",
    name: "Neon",
    shortDescription: "Manage Neon projects, branches, and databases",
    description: "Use the Neon projects, branches, databases, and development tools your account authorizes.",
    category: "Developer tools",
    services: ["Projects", "Branches", "Databases"],
    endpointUrl: "https://mcp.neon.tech/mcp",
    authorizationOrigins: ["https://mcp.neon.tech"],
    scopes: [],
    brand: "neon",
  }),
  remote({
    id: "cloudflare-api",
    serverId: "lemmacomputer_cloudflare_api",
    serverName: "lemmacomputer_cloudflare_api",
    name: "Cloudflare",
    shortDescription: "Manage Cloudflare services through approved tools",
    description: "Use the Cloudflare account permissions you grant through its official API MCP server.",
    category: "Developer tools",
    services: ["DNS", "Workers", "Zero Trust"],
    endpointUrl: "https://mcp.cloudflare.com/mcp",
    authorizationOrigins: ["https://mcp.cloudflare.com", "https://dash.cloudflare.com"],
    scopes: [],
    brand: "cloudflare",
  }),
  remote({
    id: "cloudflare-workers-builds",
    serverId: "lemmacomputer_cloudflare_workers_builds",
    serverName: "lemmacomputer_cloudflare_workers_builds",
    name: "Cloudflare Workers Builds",
    shortDescription: "Inspect and manage Workers builds",
    description: "Use the Cloudflare Workers Builds information your account authorizes.",
    category: "Developer tools",
    services: ["Builds", "Deployments", "Diagnostics"],
    endpointUrl: "https://builds.mcp.cloudflare.com/mcp",
    authorizationOrigins: ["https://builds.mcp.cloudflare.com", "https://dash.cloudflare.com"],
    scopes: [],
    brand: "cloudflare",
  }),
  remote({
    id: "hubspot",
    withheld: STATIC_CREDENTIALS_UNWIRED,
    serverId: "lemmacomputer_hubspot",
    serverName: "lemmacomputer_hubspot",
    name: "HubSpot",
    shortDescription: "Search CRM records and customer work",
    description: "Use the CRM records and permissions your HubSpot account authorizes.",
    category: "Business",
    services: ["Contacts", "Companies", "Deals"],
    endpointUrl: "https://mcp.hubspot.com",
    authorizationOrigins: ["https://mcp.hubspot.com", "https://app.hubspot.com"],
    scopes: [],
    brand: "hubspot",
  }),
  remote({
    id: "intercom",
    withheld: REGISTRATION_ALLOWLISTED,
    serverId: "lemmacomputer_intercom",
    serverName: "lemmacomputer_intercom",
    name: "Intercom",
    shortDescription: "Use customer conversations and contacts",
    description: "Use Intercom conversations and data available to your authorized account.",
    category: "Business",
    services: ["Conversations", "Contacts", "Help Center"],
    endpointUrl: "https://mcp.intercom.com/mcp",
    authorizationOrigins: ["https://mcp.intercom.com", "https://app.intercom.com"],
    scopes: [],
    brand: "intercom",
  }),
  remote({
    id: "slack",
    withheld: STATIC_CREDENTIALS_UNWIRED,
    serverId: "lemmacomputer_slack",
    serverName: "lemmacomputer_slack",
    name: "Slack",
    shortDescription: "Search channels and work with approved Slack context",
    description: "Use messages, channels, and canvases from a Slack workspace after your organization registers and approves the required Slack MCP app.",
    category: "Communication",
    services: ["Messages", "Channels", "Canvases"],
    endpointUrl: "https://mcp.slack.com/mcp",
    authorizationOrigins: ["https://mcp.slack.com", "https://slack.com"],
    scopes: [],
    brand: "slack",
  }),
  remote({
    id: "alpha-vantage",
    withheld: REGISTRATION_ALLOWLISTED,
    serverId: "lemmacomputer_alpha_vantage",
    serverName: "lemmacomputer_alpha_vantage",
    name: "Alpha Vantage",
    shortDescription: "Research market prices, fundamentals, and macro data",
    description: "Use Alpha Vantage market prices, fundamentals, technical indicators, foreign exchange, crypto, and macroeconomic data.",
    category: "Data and analytics",
    services: ["Prices", "Fundamentals", "Macro data"],
    endpointUrl: "https://mcp.alphavantage.co/mcp",
    authorizationOrigins: ["https://mcp.alphavantage.co"],
    scopes: [],
    brand: "alpha-vantage",
  }),
  remote({
    id: "massive",
    serverId: "lemmacomputer_massive",
    serverName: "lemmacomputer_massive",
    name: "Massive",
    shortDescription: "Research market prices, trades, quotes, and options",
    description: "Use the Massive market prices, trades, quotes, options chains, and historical data your account authorizes.",
    category: "Data and analytics",
    services: ["Prices", "Trades and quotes", "Options"],
    endpointUrl: "https://mcp.massive.com/",
    // Massive delegates its whole OAuth flow to auth.massive.com.
    authorizationOrigins: ["https://mcp.massive.com", "https://massive.com", "https://auth.massive.com"],
    scopes: [],
    brand: "massive",
  }),
  remote({
    id: "intrinio",
    withheld: REGISTRATION_ALLOWLISTED,
    serverId: "lemmacomputer_intrinio",
    serverName: "lemmacomputer_intrinio",
    name: "Intrinio",
    shortDescription: "Research institutional financial data",
    description: "Use the Intrinio prices, fundamentals, estimates, ETFs, options, filings, and events your account authorizes.",
    category: "Data and analytics",
    services: ["Fundamentals", "Estimates", "Market data"],
    endpointUrl: "https://intrinio-mcp.intrinio.com/mcp",
    authorizationOrigins: ["https://intrinio-mcp.intrinio.com", "https://intrinio.com"],
    scopes: [],
    brand: "intrinio",
  }),
  remote({
    id: "cloudflare-observability",
    serverId: "lemmacomputer_cloudflare_observability",
    serverName: "lemmacomputer_cloudflare_observability",
    name: "Cloudflare Observability",
    shortDescription: "Inspect application logs and analytics",
    description: "Use Cloudflare observability data that your account authorizes.",
    category: "Data and analytics",
    services: ["Logs", "Analytics", "Diagnostics"],
    endpointUrl: "https://observability.mcp.cloudflare.com/mcp",
    authorizationOrigins: ["https://observability.mcp.cloudflare.com", "https://dash.cloudflare.com"],
    scopes: [],
    brand: "cloudflare",
  }),
  remote({
    id: "cloudflare-radar",
    serverId: "lemmacomputer_cloudflare_radar",
    serverName: "lemmacomputer_cloudflare_radar",
    name: "Cloudflare Radar",
    shortDescription: "Explore Internet trends and URL scans",
    description: "Use Cloudflare Radar data and utilities through the official remote MCP server.",
    category: "Data and analytics",
    services: ["Traffic trends", "URL scans", "Internet insights"],
    endpointUrl: "https://radar.mcp.cloudflare.com/mcp",
    authorizationOrigins: ["https://radar.mcp.cloudflare.com", "https://dash.cloudflare.com"],
    scopes: [],
    brand: "cloudflare",
  }),
  remote({
    id: "cloudflare-graphql",
    serverId: "lemmacomputer_cloudflare_graphql",
    serverName: "lemmacomputer_cloudflare_graphql",
    name: "Cloudflare GraphQL",
    shortDescription: "Query Cloudflare analytics data",
    description: "Use the Cloudflare GraphQL analytics data your account authorizes.",
    category: "Data and analytics",
    services: ["Analytics", "Metrics", "Queries"],
    endpointUrl: "https://graphql.mcp.cloudflare.com/mcp",
    authorizationOrigins: ["https://graphql.mcp.cloudflare.com", "https://dash.cloudflare.com"],
    scopes: [],
    brand: "cloudflare",
  }),
  remote({
    id: "stripe",
    serverId: "lemmacomputer_stripe",
    serverName: "lemmacomputer_stripe",
    name: "Stripe",
    shortDescription: "Work with payments and billing data",
    description: "Use the Stripe account permissions you grant through Stripe's official MCP server.",
    category: "Business",
    services: ["Payments", "Customers", "Subscriptions"],
    endpointUrl: "https://mcp.stripe.com",
    // Stripe serves OAuth metadata and all three endpoints from access.stripe.com.
    authorizationOrigins: ["https://mcp.stripe.com", "https://dashboard.stripe.com", "https://access.stripe.com"],
    scopes: [],
    brand: "stripe",
  }),
  remote({
    id: "cloudflare-audit-logs",
    serverId: "lemmacomputer_cloudflare_audit_logs",
    serverName: "lemmacomputer_cloudflare_audit_logs",
    name: "Cloudflare Audit Logs",
    shortDescription: "Review Cloudflare audit activity",
    description: "Query the Cloudflare audit logs that your account authorizes.",
    category: "Other",
    services: ["Audit logs", "Reports", "Review"],
    endpointUrl: "https://auditlogs.mcp.cloudflare.com/mcp",
    authorizationOrigins: ["https://auditlogs.mcp.cloudflare.com", "https://dash.cloudflare.com"],
    scopes: [],
    brand: "cloudflare",
  }),
  remote({
    id: "cloudflare-one-casb",
    serverId: "lemmacomputer_cloudflare_one_casb",
    serverName: "lemmacomputer_cloudflare_one_casb",
    name: "Cloudflare One CASB",
    shortDescription: "Review SaaS security configuration",
    description: "Use Cloudflare One CASB findings that your account authorizes.",
    category: "Other",
    services: ["SaaS posture", "Findings", "Review"],
    endpointUrl: "https://casb.mcp.cloudflare.com/mcp",
    authorizationOrigins: ["https://casb.mcp.cloudflare.com", "https://dash.cloudflare.com"],
    scopes: [],
    brand: "cloudflare",
  }),
];

export const connectorCatalog = (
  tenantId: string,
  microsoftAuthorizationOrigin: string,
): SaveConnectorRegistryRecord[] => [
  {
    tenantId,
    id: "microsoft-365",
    serverId: "lemmacomputer_ms365",
    serverName: "lemmacomputer_ms365",
    name: "Microsoft 365",
    shortDescription: "Mail, calendar, files, and Teams",
    description: "Use approved Microsoft 365 tools through the LemmaComputer AI gateway. Protected actions require approval.",
    category: "Productivity",
    services: ["Outlook Mail", "Calendar", "OneDrive", "Teams"],
    endpointUrl: "http://ms365-mcp:3000/mcp",
    authorizationOrigins: [new URL(microsoftAuthorizationOrigin).origin],
    scopes: ["User.Read", "offline_access", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite", "Files.ReadWrite", "Chat.Read", "ChatMessage.Read", "ChatMessage.Send", "Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Read.All", "ChannelMessage.Send"],
    policySupport: "governed",
    brand: "microsoft",
    source: "built-in",
    createdBy: "lemmacomputer",
  },
  ...remoteCatalog
    .filter((connector) => isPublishable(connector))
    .map(({
      withheld: _withheld,
      requiresCredentials: _requiresCredentials,
      credentialSetup: _credentialSetup,
      ...connector
    }) => ({ tenantId, ...connector })),
];

const isPublishable = (connector: CatalogConnector) => !connector.withheld;

// Entries this deployment does not publish, and why. Drives operator
// documentation and the tests that keep each exclusion deliberate.
export const withheldConnectors = (): Array<{ id: string; name: string; reason: string }> =>
  remoteCatalog
    .filter((connector) => !isPublishable(connector))
    .map((connector) => ({ id: connector.id, name: connector.name, reason: connector.withheld! }));
