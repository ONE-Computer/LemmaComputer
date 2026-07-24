# ONEComputer employee workspace design QA

- Source visual truth: `/home/mike/.codex/generated_images/019f7918-cc7a-7012-bb4f-d4198279dab9/exec-30c950f5-9a08-4491-81eb-86a701277af8.png`
- Implementation screenshot: `/home/mike/Documents/onecomputer/apps/web/.artifacts/home-1440x1024-final.png`
- Responsive screenshot: `/home/mike/Documents/onecomputer/apps/web/.artifacts/home-390x844-final.png`
- Viewport: `1440 × 1024` desktop, with a `390 × 844` responsive check
- State: employee Home screen; workspace ready; no panel open
- Full-view comparison evidence: `/home/mike/Documents/onecomputer/apps/web/.artifacts/comparison-final.png`
- Focused comparison evidence: `/home/mike/Documents/onecomputer/apps/web/.artifacts/comparison-focused-final.png`

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: Inter Variable closely preserves the selected mock's Segoe-like Windows familiarity, hierarchy, wrapping, and optical weight. The live wordmark is marginally heavier than the generated reference; this is acceptable P3 polish until the real brand asset exists.
- Spacing and layout rhythm: the 246px navigation rail, centered content column, workspace/readiness grouping, button proportions, support-column split, dividers, and vertical rhythm match the visual target. The implementation is slightly denser in small support text, without changing hierarchy or usability.
- Colors and visual tokens: warm-white base, pale navigation surface, navy actions, green readiness, amber pending state, and low-contrast separators align with the reference and maintain readable contrast.
- Image quality and asset fidelity: the source contains no photographic or illustrative content. Fluent System Icons supply a coherent Windows-familiar icon family; no placeholder imagery, custom SVG, CSS illustration, or raster substitution is present.
- Copy and content: all primary source copy is preserved, with additional product copy limited to interactive states and secondary panels.
- Accessibility and behavior: semantic navigation, headings, regions, dialog labeling, visible focus, Escape-to-close, dialog focus entry/restoration, reduced-motion handling, disabled restart states, and live status messages were checked.
- Responsiveness: the desktop composition collapses to a readable mobile flow at 390px with no horizontal overflow, clipped controls, or off-screen primary action.

## Interaction verification

- Open workspace changes the title, supporting copy, CTA label, and live status.
- Restart exposes an honest checking state, disables conflicting actions, and returns to ready.
- Home, Activity, and Help navigation works on desktop and through the mobile menu.
- Capability details and governed-operation details open as dismissible panels.
- The governed-operation panel reports approval status without offering browser-side approval.
- Browser console completed with no errors, warnings, or issues after the final pass.

## Comparison history

### Pass 1

- Full-view and focused comparisons found no P0/P1/P2 visual mismatch.
- One non-visual accessibility issue was found: panel focus initially remained on the triggering control.
- Fix: panels now move focus to Close on entry and restore focus to the triggering control on Escape or close.
- Post-fix evidence: browser accessibility snapshot confirmed focus on `Close panel`, then restored focus on `View all capabilities` after Escape. Final desktop and responsive captures remained visually aligned.

## Follow-up polish

- P3: replace the live text wordmark when an official ONEComputer brand asset is available.
- P3: tune the smallest support-copy weights after the real product type scale is established.

## Implementation checklist

- [x] Match the selected desktop composition and content hierarchy.
- [x] Implement primary workspace and governed-operation interactions.
- [x] Verify mobile navigation and responsive layout.
- [x] Check keyboard focus, reduced motion, and console output.
- [x] Compare source and implementation together at full and focused views.

## Issue 009 browser approval extension

- The Approval device card reuses the established Connections card, button,
  status-chip, typography, spacing, and responsive patterns.
- Live Chrome inspection covered the desktop Connections view and a 390 × 844
  mobile viewport. The card and pending-approval details stack without clipping
  or horizontal overflow.
- The enrollment, refresh, approve, deny, and removal actions expose semantic
  buttons and live status text. No private key, transport token, or unrestricted
  Microsoft payload is rendered.
- Lighthouse reported 100 for accessibility and 100 for best practices on the
  mobile view. No actionable P0, P1, or P2 visual findings remain.
- The physical WebAuthn prompt and signed approve/deny path remain Issue 009
  acceptance checks because they require the user's real browser authenticator.

### Physical approval UX review

- Evidence: `/home/mike/.codex/attachments/cb9d2c6a-4f55-49fa-980c-35211a247b97/codex-clipboard-34611e4e-b623-470c-bcec-de91ebc0c6e8.png`
  and `/home/mike/.codex/attachments/96f11481-15be-4d00-8250-5742538cee86/codex-clipboard-4ebfc0e4-7161-4bf5-8f17-14fcc261277e.png`.
- Step 1, pending operation: visually clear and correctly status-only, but the
  extra navigation to Connections plus one device prompt to view and another to
  decide created avoidable high-friction approval.
- Step 2, completed operation: healthy. The final state and exactly-once result
  are clear in the recent-operation row.
- Resolution: the signed safe request now loads automatically in the governed
  operation drawer through the signed-in ONEComputer session. Approve or deny
  requires one WebAuthn signing gesture; Connections is device management only.
- Accessibility limit: screenshots establish hierarchy and visible states, not
  keyboard, screen-reader, or authenticator-dialog behavior. Those remain live
  browser checks for the revised pending state.

final result: passed

## Sandbox management refinement — 2026-07-23

- Source visual truth: `/home/mike/.codex/attachments/2a46dd26-2fd1-4dc1-8a31-a5b252c0f308/codex-clipboard-8ef18bc4-463f-499c-b073-404c8bddef2a.png`
- Implementation screenshots: `/home/mike/Documents/onecomputer/apps/web/.artifacts/sandbox-inventory.png`, `/home/mike/Documents/onecomputer/apps/web/.artifacts/sandbox-detail.png`, and `/home/mike/Documents/onecomputer/apps/web/.artifacts/sandbox-detail-mobile.png`
- Viewport and density normalization: 1440px desktop at device scale 1; 390px mobile-width check at device scale 1. The implementation uses the established ONEComputer navigation, type scale, borders, buttons, and status treatment from the source.
- State: one running, accessible sandbox; the configuration remains intentionally read-only until it is stopped.
- Full-view comparison evidence: `/home/mike/Documents/onecomputer/apps/web/.artifacts/sandbox-design-comparison.png`
- Focused comparison evidence: the Application, AI agents, AI model, Security, configuration-document, and attached-firewall controls are visible at native detail capture scale in `/home/mike/Documents/onecomputer/apps/web/.artifacts/sandbox-detail.png`.

### Findings

The requested information architecture intentionally replaces the source's stacked workspace cards with an inventory-first management console. Visual comparison confirms the same product language is retained while giving a future multi-sandbox fleet a clear default table view and a focused detail view.

- No P0, P1, or P2 visual issues remain at desktop or mobile width.
- The table preserves scanability for sandbox name, configuration summary, external network boundary, lifecycle state, and Manage action.
- Detail sections use clear headings and grouped selection controls: Applications; AI agents grouped by Claude, ChatGPT, and Hermes; AI model; and Security with an explicit firewall handoff.
- Firefox ESR, Google Chrome, Claude Desktop, Claude CLI, Hermes Agent Desktop, and Hermes Agent CLI are selectable runtime-backed options. Obsidian, Visual Studio Code, and ChatGPT clients remain explicitly unavailable, avoiding a configuration UI that promises unsupported image contents.
- The mobile layout has no horizontal overflow or clipped controls; all sections stack in a single readable column.

### Interaction verification

- Authenticated Chrome check: Sandbox opened an inventory with one row and a visible Create Sandbox control.
- Manage opened Acme Workspace with Applications, AI agents, AI model, Security, and the JSON disclosure present.
- Open Firewall navigated to the Egress firewall screen.
- Create Sandbox opened the labelled name dialog; it was cancelled without creating a sandbox.
- The running sandbox's Save configuration control was disabled and its stop-first rule remained visible.
- Browser console completed without errors.

### Follow-up polish

- P3: add the remaining catalog entries only when the hardened sandbox image actually ships Obsidian, Visual Studio Code, or ChatGPT clients.

final result: passed

## Optional sandbox software and restart notice — 2026-07-24

- Source visual truth: `/home/mike/.codex/attachments/1958796b-29f0-43f1-8df9-b3541aa664b4/codex-clipboard-9e5ec180-ecc1-47a8-94a0-88c15b4a7504.png`
- Implementation screenshots: `/home/mike/Documents/onecomputer/apps/web/.artifacts/sandbox-optional-selections.png` and `/home/mike/Documents/onecomputer/apps/web/.artifacts/sandbox-restart-required.png`
- Viewport: `2280 × 1248` CSS pixels at device scale factor 1.
- Density normalization: the source is `2280 × 1248`; the selected-state implementation is a full-page `2265 × 1986` capture, where the 15px width difference is the browser scrollbar, and the restart-dialog implementation is `2280 × 1248`. Both were inspected at native density.
- State: stopped sandbox; Chrome, Claude CLI, and Hermes Agent Desktop opted in alongside the existing Firefox, Claude Desktop, and Hermes Agent CLI selections; restart notice open after save.
- Full-view comparison evidence: the source and `/home/mike/Documents/onecomputer/apps/web/.artifacts/sandbox-optional-selections.png` were opened together at native detail in the same comparison pass.
- Focused comparison evidence: `/home/mike/Documents/onecomputer/apps/web/.artifacts/sandbox-restart-required.png` shows the saved-state confirmation, modal hierarchy, background selection state, and success toast at the source viewport.

### Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: the existing Inter-based ONEComputer type system preserves the source hierarchy, optical weights, wrapping, and compact catalog metadata. The new option names and versions fit without truncation or cramped line height.
- Spacing and layout rhythm: application cards remain a balanced two-column grid; the AI agent groups retain the source three-column anatomy. The extra full-page height is expected because the implementation also includes model, security, and save sections below the source crop.
- Colors and visual tokens: selected options reuse the source navy outline, pale-blue fill, and checked control. Unavailable options retain the quieter neutral treatment, and the restart overlay uses the established modal and success colors.
- Image quality and asset fidelity: the source contains no photographic or illustrative assets. The implementation continues to use the established Fluent icon set; no placeholder imagery, handcrafted SVG, CSS art, or text-glyph substitute was introduced.
- Copy and content: Chrome, Claude CLI, and Hermes Agent Desktop now show pinned runtime names, versions, and governed-routing descriptions. The confirmation explicitly says a restart is required and that the saved configuration becomes the source of truth for the next launch.
- Accessibility and behavior: all six runtime-backed choices are semantic checkboxes with complete accessible names. The restart notice is a labelled modal dialog, moves focus to its close control, provides a clear primary dismissal action, and leaves the rest of the app inert.
- Responsiveness and viewport resilience: the source desktop composition remains intact at `2280 × 1248`; no control overlaps, clipping, horizontal overflow, or unusable wrapping was observed.

### Interaction verification

- Opened Sandbox, opened the stopped sandbox detail, and selected Google Chrome, Claude CLI, and Hermes Agent Desktop.
- Saved the configuration and verified the `Restart required` modal and `Sandbox configuration saved` live status.
- Read the settings API again after save and confirmed all selected application and agent IDs were persisted for the next launch.
- Browser console inspection found no errors, warnings, or issues.

### Comparison history

#### Pass 1

- Direct source/implementation comparison found no P0, P1, or P2 visual mismatch.
- The differences from the source are intentional product changes: Chrome, Claude CLI, and Hermes Agent Desktop are selectable and show pinned runtime metadata; Obsidian, Visual Studio Code, and ChatGPT remain unavailable.
- No visual fix iteration was required.

### Implementation checklist

- [x] Preserve the source layout and selection styling.
- [x] Make Chrome, Claude CLI, and Hermes Agent Desktop real opt-in controls.
- [x] Keep the existing default selection unchanged.
- [x] Persist the saved configuration for the next sandbox launch.
- [x] Show an accessible restart-required confirmation after save.
- [x] Verify the interaction path and console at the source viewport.

final result: passed
