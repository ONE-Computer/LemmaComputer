# Responsive UX and accessibility audit

Issue: [#70](https://github.com/ONE-Computer/LemmaComputer/issues/70)

Audit branch source commit: `57de7c90d1e3b0215a8a02602b26b4ab32505494`

Capture generated: 2026-08-13 13:53 UTC

Evidence: [`docs/assets/responsive-ux-audit/`](assets/responsive-ux-audit/)

Measurements: [`measurements.json`](assets/responsive-ux-audit/measurements.json)

## Status and decision summary

This is the completed non-overlapping audit increment for the stabilized product surfaces. It found no P0 issue, five P1 defects, and two P2 defects. All seven are route/component-local; the sampled shared shell did not produce a product-wide clipping or navigation-overlap failure.

This is not the final #70 register. Workspace member home and Chat, Activity, and composer evidence are intentionally absent because #77 is actively changing those surfaces. They require fresh captures after #77 stabilizes. #70 must remain open until those captures are reviewed and the product owner approves the full register.

| ID | Severity | Route/component | Impact | Confidence |
| --- | --- | --- | --- | --- |
| RUX-01 | P1 | Organization workspaces runtime table | Runtime actions are clipped at 1366 × 650 without a scroll affordance. | High |
| RUX-02 | P1 | People and access member rows | Member actions exceed the 720 px viewport; keyboard focus exposes an action only by clipping its member identity. | High |
| RUX-03 | P1 | AI control plane Model routes table | At 390 × 844 the route creates 569 px of document overflow and hides later table columns/actions beyond the initial view. | High |
| RUX-04 | P1 | Firewall security-group rows | Both Manage group actions are clipped by their card at 1366 × 650. | High |
| RUX-05 | P1 | Workspace policy member status | Both Assign policy actions are clipped at 720 × 900. | High |
| RUX-06 | P2 | Workspace section tabs | A keyboard-focused inactive tab has no visible focus indicator at 1366 × 650. | High |
| RUX-07 | P2 | AI control-plane mobile tabs | Three destinations are offscreen at 390 × 844 with no visible overflow cue. | High |

No WCAG compliance claim is made from this screenshot-led audit.

## Audited scope

- Authentication: email/password, account recovery/creation links, company SSO, passkey, Google, and Microsoft entry points.
- Shared navigation and shell: desktop sidebar, compact/mobile top bar, keyboard-opened navigation drawer, skip link, focus treatment, and route gutter behavior.
- Workspace administration unaffected by #77: organization workspace runtime operations and workspace-policy administration.
- Connections and policy administration: connectors, egress firewall security groups, policy baseline, and associated dialogs.
- People and access: organization identity, invitations, member roles/actions, protected lifecycle operations, and lower-page connection/custom-role actions through keyboard traversal.
- Other stabilized member/admin flows: Schedules, Sites, Settings.
- AI control and usage: overview, providers, spend details, and model routing, including dense table behavior.
- Dialogs: policy baseline at 720 × 900; invitation and restart confirmation at 390 × 844.

## Method and limitations

The audit used the deterministic local UI fixture and a Playwright CLI harness. Only screenshots generated during this run were accepted. Every accepted image was opened and visually inspected. The harness starts each default route in a fresh browser context and records document bounds, action bounds, dialogs, scroll containers and ownership, active focus, and keyboard traversal.

| Required viewport | Stabilized evidence sampled |
| --- | --- |
| 1366 × 650 | Organization workspaces, policies, Schedules, Sites, Connectors, Firewall, Settings, People and access, AI overview/providers/spend/routes, sign-in |
| 1470 × 730 | Organization workspaces |
| 1440 × 800 | People and access |
| 1920 × 900 | Model routes |
| 720 × 900 | Organization workspaces, policies, Connectors, People and access, AI spend, policy dialog |
| 390 × 844 | People and access, Model routes, Connectors, navigation drawer, invitation/restart dialogs, sign-in |
| 200% zoom equivalent | Organization workspaces at a 683 × 325 effective CSS viewport, rendered at device scale factor 2 |

The 200% sample is a headless CSS-pixel-equivalent emulation, not a native browser-zoom claim. It showed no horizontal overflow; actions below the fold remained reachable through document vertical scrolling. No screen reader, high-contrast mode, reduced-motion audit, real tenant data, or native OS/browser zoom was used.

## Findings

### RUX-01 — Organization workspace runtime actions are clipped

Severity: **P1**

Impact: An administrator at the required compact desktop viewport cannot see complete Stop, Start, or Terminate runtime controls. This blocks or obscures critical runtime operations.

Cause scope: **route-local dense-row breakpoint**, not the shared shell.

Owner: `WorkspaceScreen`, `.member-workspace-table`, `.member-workspace-row`, and `.member-workspace-actions` in `apps/web/src/App.jsx` and `apps/web/src/styles.css`.

State: `/?view=home&section=organization`, 1366 × 650, fixture organization with three workspaces.

![Organization workspace actions clipped at 1366 by 650](assets/responsive-ux-audit/02-organization-workspaces-1366x650.png)

Evidence: the row extends to `x=1419.30` and the Stop/action region extends to `x=1401.30`, while the viewport ends at `x=1366`. The table ends at `x=1297.70`, applies hidden overflow, and has no horizontal scroll owner. At 1470 × 730 the actions fit within the viewport but still extend 7 px beyond their hidden table ancestor; at 720 × 900 the route correctly switches to cards.

Required fix/test for #71:

- Switch to the compact card layout based on available content width, or move the breakpoint high enough to include the fixed 336 px sidebar and route gutters.
- Keep Start, Restart, Stop, and Terminate runtime within the content box; do not hide or truncate actions.
- Assert all runtime-action rectangles are inside the viewport at 1366 × 650 and 1470 × 730, with no clipped ancestor overflow, then exercise each action.

### RUX-02 — People and access clips member actions at 720 px

Severity: **P1**

Impact: Organization owners cannot see complete session, ownership, suspension, and removal actions. Keyboard traversal focuses actions outside the visible viewport and removes the associated member identity from view.

Cause scope: **route-local member-row breakpoint**, not the shared shell.

Owner: People and access `.admin-member-section`, `.admin-user-list`, `.admin-user-actions`, and `.admin-row-action`.

State: `/?view=settings&section=people`, 720 × 900, Organization members section, before and during keyboard traversal.

![People member actions clipped at 720 by 900](assets/responsive-ux-audit/35-people-actions-clipped-720x900.png)

![Focused Sign out sessions action remains beyond the viewport](assets/responsive-ux-audit/36-people-sign-out-sessions-focus-720x900.png)

Evidence: action buttons occupy `x=585..765`, 45 px past the viewport. The focused Sign out sessions control retains a visible 3 px focus outline, but its right edge remains at 765 px and the member identity is clipped on the left. There is no explicit horizontal scroll owner. The rows correctly stack at 390 × 844; the broken responsive band sits above the current 700 px breakpoint.

Required fix/test for #71:

- Stack the member row and make actions fluid before the columns exceed the available route width, preferably from a container query.
- Keep the focused action and its associated member identity visible together.
- At 720 × 900, assert every member-action rectangle is within the viewport throughout the complete Tab sequence and that neither document nor member section acquires horizontal pan.

### RUX-03 — Model routes escapes its mobile scroll owner

Severity: **P1**

Impact: At 390 × 844, later route-table columns and management actions are not visible in the initial view, and the page exposes document-level horizontal overflow despite an intended table scroller. This makes pricing and mapping actions difficult to discover and unreliable to reach.

Cause scope: **AI Model routes containment**, not the shared shell.

Owner: `.routing-admin-screen`, `.route-table-card`, `.route-table-scroll`, and `.route-table` in `apps/web/src/RoutingAdmin.css`.

State: `/?view=ai-control-plane&section=model-routes`, 390 × 844, route table at `scrollLeft=0`.

![Mobile Model routes table clipped to its initial columns](assets/responsive-ux-audit/38-ai-routing-table-overflow-390x844.png)

Evidence: `document.scrollWidth=959` for a 390 px viewport. The intended `.route-table-scroll` is 350 px wide with `scrollWidth=1040`, while the table itself reaches `x=1060`. The screenshot shows only Alias and Provider deployment plus a sliver of the next column; no visual cue communicates the remaining horizontal content. At 1366 × 650, the table owns an internal 891/1040 px horizontal scroll region without document overflow; at 1920 × 900 it fits without a scroller.

Required fix/test for #71:

- Add `min-width: 0`/`max-width: 100%` containment through the route-card and scroll-owner chain so table width never contributes to document width.
- Preserve one internal horizontal scroll owner and make remaining columns/actions discoverable with a cue or sticky Actions column.
- Assert `document.documentElement.scrollWidth === document.documentElement.clientWidth` at 390 × 844 and 1366 × 650; assert only `.route-table-scroll` changes `scrollLeft`, and its final actions are reachable.

### RUX-04 — Firewall security-group actions are clipped

Severity: **P1**

Impact: Administrators see only a truncated Manage group label for both security groups at the compact desktop viewport, obscuring the control used to inspect and change egress policy.

Cause scope: **Firewall dense-row layout**, not the shared shell.

Owner: `.firewall-security-groups` and `.firewall-security-group-list article` in `apps/web/src/styles.css`.

State: `/?view=firewall`, 1366 × 650, two fixture security groups.

![Firewall Manage group actions clipped at the card edge](assets/responsive-ux-audit/08-firewall-1366x650.png)

Evidence: each Manage group button occupies `x=1180.30..1334.30`; its hidden-overflow security-group section ends at `x=1297.70`, clipping 36.59 px. The route has no horizontal scroll owner.

Required fix/test for #71:

- Reflow the security-group row before its five grid columns exceed the available content width.
- Keep both Manage group controls fully visible and associated with their security-group names.
- At 1366 × 650, assert each control is contained by the card, has an untruncated accessible and visible label, and remains keyboard reachable.

### RUX-05 — Policy assignment actions are clipped at 720 px

Severity: **P1**

Impact: An administrator reviewing member policy status cannot see the complete Assign policy controls, blocking a core policy-administration task.

Cause scope: **Workspace-policy member table**, not the shared shell.

Owner: `.workspace-policy-member-table` and `.workspace-policy-member-row` in `apps/web/src/styles.css`.

State: `/?view=home&section=policies`, 720 × 900, Member policy status, keyboard focus on the first Assign policy control.

![Focused Assign policy control clipped at 720 by 900](assets/responsive-ux-audit/41-policy-assign-focus-720x900.png)

Evidence: each action occupies `x=631..715`, while its hidden-overflow table ancestor ends at `x=692`. No horizontal scroll owner exposes the remaining 23 px; the visible focus indicator is clipped with the control.

Required fix/test for #71:

- Switch the member-status rows to a compact card/stacked layout before the five-column minimum exceeds the route container.
- Keep member identity, assignment status, pending action, and Assign policy control together.
- At 720 × 900, assert both Assign policy controls and their focus indicators are fully contained and keyboard operable without horizontal pan.

### RUX-06 — Workspace tabs lose visible keyboard focus

Severity: **P2**

Impact: A keyboard user cannot tell which inactive Workspace section tab will activate, even though the control is in the Tab sequence.

Cause scope: **Workspace tab component focus styling**, not the shared shell.

Owner: `.workspace-page-tabs button:focus-visible` in `apps/web/src/styles.css`.

State: `/?view=home&section=policies`, 1366 × 650, keyboard focus on inactive Organization workspaces.

![Inactive Organization workspaces tab has no visible focus ring](assets/responsive-ux-audit/39-workspace-tab-focus-1366x650.png)

Evidence: the active element is the Organization workspaces button, but the captured computed style is `outline-style: none` and the screenshot shows no distinct focus treatment. The active Workspace policies underline indicates selection, not the keyboard focus position.

Required fix/test for #71:

- Give every focused tab a visible, non-clipped focus indicator independent of selected state.
- Tab across My workspaces, Organization workspaces, and Workspace policies and assert a visible focus style for each inactive and active state.

### RUX-07 — Mobile AI navigation hides destinations without a cue

Severity: **P2**

Impact: Pricing, Teams & budgets, and Data health are absent from the initial 390 px view. The hidden scrollbar and lack of an edge cue make these destinations easy to miss for touch and pointer users.

Cause scope: **AI tab-navigation component**, not the shared shell.

Owner: `.ai-control-plane-tabs` in `apps/web/src/AiControlPlane.css`.

State: any AI control-plane section at 390 × 844; captured on Model routes.

![Only the first three AI tabs are visible at 390 by 844](assets/responsive-ux-audit/24-ai-routing-390x844.png)

Evidence: the tab scroller is 372 px wide with `scrollWidth=709`; its scrollbar is explicitly hidden. Overview, Models & providers, and Model routes are visible, while the remaining three destinations have no persistent visual affordance.

Required fix/test for #71:

- Add a perceivable overflow treatment such as an edge fade with directional affordance, a visible compact scrollbar, or a mobile overflow menu.
- Verify every destination is reachable by touch, pointer, and keyboard and that focus automatically reveals the focused tab without moving the document horizontally.

## Shared contracts for #71

1. **Shell:** the sampled desktop sidebar, mobile top bar, skip link, and keyboard-opened drawer pass. Preserve those shared-shell behaviors; fix the seven defects in their route/component owners.
2. **Overflow:** the document must never scroll horizontally. Dense data may own one discoverable horizontal scroller; `overflow: hidden` must not conceal task actions.
3. **Actions:** primary, destructive, and row actions remain visible, reachable, and associated with their row identity at every required viewport.
4. **Focus:** skip link remains first; meaningful controls show a visible focus indicator; focus must not pan hidden containers away from related context.
5. **Dialogs:** cap dialogs to the dynamic viewport, own internal vertical scrolling when needed, and retain visible close and primary/cancel controls.
6. **Tenant/deployment:** remediation must remain tenant-scoped and deployment-profile-neutral; this audit proposes no profile-specific UI fork.

## Passing observations

- The shared shell changes cleanly from the fixed sidebar to the mobile top bar and inert, scrim-backed navigation drawer. The mobile menu button and first drawer item show visible focus.
- The skip link is first in sampled desktop/narrow keyboard sequences. Connectors, member actions, AI date fields, and standard shell controls expose the shared focus treatment when visible.
- Organization workspace cards fit at 720 × 900, and People/member cards fit at 390 × 844.
- Connectors adapt from a two-column desktop grid to readable single-column cards at 720 and 390 without document overflow.
- Policy baseline, mobile invitation, and mobile restart dialogs fit with visible close and action controls; each dialog owns `overflow-y:auto` and had `scrollHeight === clientHeight` in the captured state.
- Sign-in has no horizontal overflow at 1366 × 650 or 390 × 844; the mobile document scrolls vertically to remaining sign-in methods.
- Schedules, Sites, Settings, policies, AI overview/providers/spend, and the sampled mobile drawer showed no navigation overlap or document horizontal overflow.
- AI Spend Details stacks date and export controls at 720 × 900; focused date input is visibly outlined.

## Explicitly pending behind #77

Do not use earlier screenshots for the following conclusions:

- Workspace member home, workspace card ordering/state, and its 1470 × 730, 1440 × 800, 1920 × 900, 720 × 900, and 390 × 844 qualification.
- Chat transcript, Activity panel/drawer, composer docking and actions, attachment input, compact-height behavior, scroll ownership, and keyboard traversal.

Fresh captures at all applicable required viewports, including 200% reflow where applicable, must be added after #77 stabilizes. The full register then requires product-owner approval before #70 can close.

## Evidence manifest

### Compact sweep — 1366 × 650

1. [`02-organization-workspaces-1366x650.png`](assets/responsive-ux-audit/02-organization-workspaces-1366x650.png)
2. [`03-workspace-policies-1366x650.png`](assets/responsive-ux-audit/03-workspace-policies-1366x650.png)
3. [`04-schedules-1366x650.png`](assets/responsive-ux-audit/04-schedules-1366x650.png)
4. [`05-sites-1366x650.png`](assets/responsive-ux-audit/05-sites-1366x650.png)
5. [`06-connectors-1366x650.png`](assets/responsive-ux-audit/06-connectors-1366x650.png)
6. [`08-firewall-1366x650.png`](assets/responsive-ux-audit/08-firewall-1366x650.png)
7. [`09-settings-1366x650.png`](assets/responsive-ux-audit/09-settings-1366x650.png)
8. [`10-people-access-1366x650.png`](assets/responsive-ux-audit/10-people-access-1366x650.png)
9. [`11-ai-overview-1366x650.png`](assets/responsive-ux-audit/11-ai-overview-1366x650.png)
10. [`12-ai-models-providers-1366x650.png`](assets/responsive-ux-audit/12-ai-models-providers-1366x650.png)
11. [`13-ai-spend-1366x650.png`](assets/responsive-ux-audit/13-ai-spend-1366x650.png)
12. [`14-ai-routing-1366x650.png`](assets/responsive-ux-audit/14-ai-routing-1366x650.png)

### Required larger and narrow/mobile samples

13. [`15-organization-workspaces-1470x730.png`](assets/responsive-ux-audit/15-organization-workspaces-1470x730.png)
14. [`16-people-access-1440x800.png`](assets/responsive-ux-audit/16-people-access-1440x800.png)
15. [`17-ai-routing-1920x900.png`](assets/responsive-ux-audit/17-ai-routing-1920x900.png)
16. [`18-organization-workspaces-720x900.png`](assets/responsive-ux-audit/18-organization-workspaces-720x900.png)
17. [`19-workspace-policies-720x900.png`](assets/responsive-ux-audit/19-workspace-policies-720x900.png)
18. [`20-connectors-720x900.png`](assets/responsive-ux-audit/20-connectors-720x900.png)
19. [`21-people-access-720x900.png`](assets/responsive-ux-audit/21-people-access-720x900.png)
20. [`22-ai-spend-720x900.png`](assets/responsive-ux-audit/22-ai-spend-720x900.png)
21. [`23-people-access-390x844.png`](assets/responsive-ux-audit/23-people-access-390x844.png)
22. [`24-ai-routing-390x844.png`](assets/responsive-ux-audit/24-ai-routing-390x844.png)
23. [`25-connectors-390x844.png`](assets/responsive-ux-audit/25-connectors-390x844.png)

### Drawer, dialogs, zoom, authentication, and focused states

24. [`28-mobile-navigation-390x844.png`](assets/responsive-ux-audit/28-mobile-navigation-390x844.png)
25. [`29-policy-baseline-dialog-720x900.png`](assets/responsive-ux-audit/29-policy-baseline-dialog-720x900.png)
26. [`30-invite-dialog-390x844.png`](assets/responsive-ux-audit/30-invite-dialog-390x844.png)
27. [`31-restart-dialog-390x844.png`](assets/responsive-ux-audit/31-restart-dialog-390x844.png)
28. [`32-organization-workspaces-200-percent-zoom.png`](assets/responsive-ux-audit/32-organization-workspaces-200-percent-zoom.png)
29. [`33-sign-in-1366x650.png`](assets/responsive-ux-audit/33-sign-in-1366x650.png)
30. [`34-sign-in-390x844.png`](assets/responsive-ux-audit/34-sign-in-390x844.png)
31. [`35-people-actions-clipped-720x900.png`](assets/responsive-ux-audit/35-people-actions-clipped-720x900.png)
32. [`36-people-sign-out-sessions-focus-720x900.png`](assets/responsive-ux-audit/36-people-sign-out-sessions-focus-720x900.png)
33. [`37-connections-navigation-focus-390x844.png`](assets/responsive-ux-audit/37-connections-navigation-focus-390x844.png)
34. [`38-ai-routing-table-overflow-390x844.png`](assets/responsive-ux-audit/38-ai-routing-table-overflow-390x844.png)
35. [`39-workspace-tab-focus-1366x650.png`](assets/responsive-ux-audit/39-workspace-tab-focus-1366x650.png)
36. [`40-ai-spend-date-focus-720x900.png`](assets/responsive-ux-audit/40-ai-spend-date-focus-720x900.png)
37. [`41-policy-assign-focus-720x900.png`](assets/responsive-ux-audit/41-policy-assign-focus-720x900.png)

## Reproduction

The audit-only Vite configuration deduplicates React and permits font assets from the parent checkout; it does not alter production behavior.

```bash
UI_FIXTURE_PORT=24370 npm run dev:ui-fixture
LEMMACOMPUTER_CONTROL_URL=http://127.0.0.1:24370 npm run dev -w web -- --config ../../scripts/vite-responsive-audit.config.mjs --host 127.0.0.1 --port 24371 --force
node scripts/capture-responsive-ux-audit.mjs
```

The capture harness is audit evidence, not the #71 release gate. #71 should promote the finite assertions above into focused Playwright regression specs.
