# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable product direction

- ONEComputer is a single-organization, multi-user product for ME TECH: every user in the configured Entra tenant may sign in and receives the default employee policy on first sign-in; `mike@metech.dev` is the bootstrap administrator who manages the organization.
- Connector availability and member connection rights are organization policy. Administrators may enable or disable a connector and lock personal connection changes; members can connect or disconnect only when the organization policy permits it, and never edit that policy.
- The user selected the light Calm Launchpad direction because its layout feels familiar to Windows users.
- Preserve the calm, practical, employee-first experience and visible readiness without exposing infrastructure or turning the home screen into an admin dashboard.
- During the prototype, ONEComputer Web also serves as the local administrator/control surface. The user accepted a temporary loopback-only Gateway link while the owned workspace journey remains the primary screen.
- Keep connector-specific tool permissions with the connector detail flow (Connections → connector → Tools & approvals), following the familiar integration-management pattern. Reserve Admin for organization policy versions, assignments, and cross-connector administration rather than duplicating each connector's tool matrix there.
- Keep Connections employee-facing: do not mention LiteLLM, MCP registration, OAuth tokens, refresh tokens, or other gateway implementation details in page copy. Avoid full-width technical reassurance banners and decorative horizontal rules when spacing and card grouping already provide structure.
- A service connected by a user must be projected automatically into that user's live workspace grants and advertised by the shared MCP bridge to every assigned workspace agent. Disconnect must remove that projection and fail closed if a grant refresh cannot complete.
- Trail owns protected-action history and one-account approval-device management. Connections remains focused on third-party service setup; a newly enrolled browser replaces the single active approval device. The production navigation uses only `?view=trail`; do not retain an `activity` route alias.
- On desktop, favor a generous, low-density workspace: use a 336px persistent sidebar and let every shared page use the 1440px content cap instead of holding it in a narrow centered column. Keep account details and sign-out in the sidebar profile control; do not add a redundant top-right account/date area.
- The sidebar account control opens a compact profile menu with Settings and Log out. Keep Gateway and Administration out of primary navigation; surface both through Settings instead.
- Help is intentionally not part of the production navigation or routing.
- Chat is the final primary tab. When active, it exposes recent thread titles directly beneath the tab in the sidebar; the main chat area stays focused on the conversation and its single, ChatGPT-style composer.
- Schedules is a primary employee tab for Control-owned recurring prompts. Each schedule selects an owned workspace and one of its chat-capable agents; it is separate from workspace-local cron, shows run history, and states that stopped workspaces skip runs.
- Standard dialogs use the shared 720px desktop cap and equal-width, right-aligned actions. The schedule editor gives Repeat, Time, and Timezone their own spaced columns within that common dialog system.
- Chat must acknowledge a submitted message immediately, before the agent's first streamed content arrives, so the employee is never left with only an unexplained working state.
- Render assistant text as safe GitHub-flavored Markdown. Keep employee-authored message text literal, and preserve structured progress, tool, approval, and attachment parts as owned UI.
- Every protected-action approval and Trail entry must identify the human-facing target when it is known (for example, a filename rather than only an opaque OneDrive item ID).
- Start every desktop primary page immediately below the shared 48px top-bar gutter; do not add per-page or compact-heading top padding. Mobile retains its own navigation and responsive page spacing.
- Workspace is the single user-facing workspace hub, not a readiness/assurance screen. Give each workspace a clear live state and its assigned apps, agents, model, and policy; omit generic protections, capability catalogs, and recent governed activity. Do not expose a duplicate Sandbox tab or creation flow—open configuration from its workspace card instead.
- Sandbox software is an explicit per-sandbox choice: Firefox, Claude Desktop, and Hermes Agent CLI remain the initial defaults; Google Chrome, Claude CLI, and Hermes Agent Desktop are real opt-in image capabilities. Saving changes must explain that the next sandbox launch applies them and a restart is required.
- The OpenVTC Companion is a phone-first PWA: preserve thumb-sized actions, safe-area spacing, a compact authenticated shell, and immediate access to any live approval decision on narrow touch screens.
- Companion Chat and protected approvals are parallel destinations, not mutually exclusive modes. Use persistent bottom navigation on mobile, keep approvals active while chatting, and preserve Approvals / Activity as local tabs within Companion.
- Firewall is a tenant-wide administrator surface. Use one dense, effective-policy rules table with workspace and owner as first-class columns; retain the shared page heading/subtext treatment. Keep detailed rule and attachment changes in centered modals rather than a right-side inspector.
- Use the owned `SelectMenu` component for every application dropdown. Preserve its compact enterprise trigger, pale-blue selected option, checkmark, and keyboard behavior; do not introduce browser-native selects or a second component library just for menus.
- The firewall header’s Add rule action opens a focused creation modal. It defaults to creating a new security group; adding to an existing group must be an explicit choice. It never exposes existing rules for edit or removal; group management remains contextual through the security-group link in the table.
