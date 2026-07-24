# Issue 006 UI and accessibility refinement record

Date: 2026-07-23

The established light Calm Launchpad remains the visual source of truth. This
pass refined the complete V2 journey without moving authority into the browser
or hiding security states.

## Route and journey inventory

- Home: workspace lifecycle/readiness, selected agents, native clipboard,
  controlled connectivity, signed policy integrity, capabilities, governed
  operation, and model/tool availability.
- Activity: safe operation history and governed-operation detail.
- Sandbox: scalable, accessible sandbox inventory with explicit creation, then
  a per-sandbox configuration view for applications, agents, model route, and
  security. The configuration is a schema-versioned JSON document so the same
  state can be created programmatically later.
- Firewall: reusable domain/protocol/port egress groups and stopped-workspace
  assignment.
- Connections: Microsoft 365 status, approval device, and administrator tool
  effects.
- Admin: policy versions and user assignments.
- Companion: browser enrollment, notification health, signed approval,
  read-only protected activity, and removal.
- Help/Gateway: product help and the explicit local-only administrative exit.

## Component and token changes

`ui.jsx` and `ui.css` now own dialog focus/keyboard behavior, confirmations,
text prompts, status badges, signed-policy integrity, fatal error fallback, and
the additional spacing/color/radius/shadow tokens. Native `confirm` and
`prompt` calls were removed from critical paths.

The signed-policy card presents assigned, in-workspace, and externally
enforced version/digest plus signing key. It distinguishes verified, drift,
invalid, expired, and unavailable states with text and iconography, not color
alone. Home also explains normal copy/paste privacy and that internet access is
enforced by the external firewall.

## Accessibility and responsive target

- Modern Chromium/Firefox desktop and mobile-width web views.
- 320 CSS-pixel minimum width, 200% text zoom/reflow target.
- Keyboard-only operation with visible focus, skip links, Escape handling,
  contained Tab order in drawers/dialogs/mobile navigation, and focus
  restoration.
- Semantic navigation, main, dialog, heading, list, definition-list, status,
  and alert regions.
- Background content becomes inert while an owned modal/drawer or mobile
  navigation overlay is active.
- Closed off-canvas navigation uses `visibility: hidden`, preventing hidden
  controls from remaining in the accessibility tree.
- Reduced-motion rules remain in both primary and companion styles.
- Destructive actions require an owned, labelled confirmation and server
  confirmation before success is announced.

## Verification

- Automated suite: 128/128 passed, including owned UI contract checks.
- Full production Vite and workspace TypeScript build passed.
- Authenticated visual fixture reviewed at 1440×1024 and 390×844 with dual
  agents, all readiness states, policy integrity, firewall/clipboard
  explanations, capabilities, and governed operation.
- Companion setup reviewed at 390×844.
- Accessibility snapshots verified semantic names/order, closed-menu removal,
  focus entry into mobile navigation, background inertness, drawer focus
  entry, and focus return to the selected page.
- Desktop and mobile captures showed no horizontal overflow, clipping, hidden
  primary action, or off-screen policy detail.
- The production web container was rebuilt and `http://127.0.0.1:4174`
  returned successfully.
- Sandbox management was reviewed with one accessible sandbox at desktop and
  390px mobile widths. The inventory table, Manage path, Application, AI
  agent, AI model, Security sections, configuration JSON disclosure, Firewall
  navigation, and non-submitting Create Sandbox dialog all worked with no
  console errors. Save is correctly disabled until a running sandbox stops.
- The deployed image currently supplies Firefox ESR only. Chrome, Obsidian,
  VS Code, ChatGPT clients, and Hermes Desktop are visibly marked coming soon,
  rather than being represented as selectable configuration that the runtime
  cannot honor.

## Residual human checks

Physical Web Push delivery and WebAuthn prompts remain Issue 004 verification,
not an Issue 006 visual claim. A final product-owner visual review of the
deployed authenticated page is still requested before V2 acceptance is closed.
