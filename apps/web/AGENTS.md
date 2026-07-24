# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable product direction

- The user selected the light Calm Launchpad direction because its layout feels familiar to Windows users.
- Preserve the calm, practical, employee-first experience and visible readiness without exposing infrastructure or turning the home screen into an admin dashboard.
- During the prototype, ONEComputer Web also serves as the local administrator/control surface. The user accepted a temporary loopback-only Gateway link while the owned workspace journey remains the primary screen.
- Keep connector-specific tool permissions with the connector detail flow (Connections → connector → Tools & approvals), following the familiar integration-management pattern. Reserve Admin for organization policy versions, assignments, and cross-connector administration rather than duplicating each connector's tool matrix there.
- On desktop, favor a generous, low-density workspace: use a wider persistent sidebar and let shared page content expand on large screens instead of holding it in a narrow centered column. Keep account details and sign-out in the sidebar profile control; do not add a redundant top-right account/date area.
- Sandbox software is an explicit per-sandbox choice: Firefox, Claude Desktop, and Hermes Agent CLI remain the initial defaults; Google Chrome, Claude CLI, and Hermes Agent Desktop are real opt-in image capabilities. Saving changes must explain that the next sandbox launch applies them and a restart is required.
- The OpenVTC Companion is a phone-first PWA: preserve thumb-sized actions, safe-area spacing, a compact authenticated shell, and immediate access to any live approval decision on narrow touch screens.
