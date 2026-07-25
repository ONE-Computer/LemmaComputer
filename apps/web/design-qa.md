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

## Shared dropdown refinement — 2026-07-24

- Source visual truth: `/home/mike/.codex/attachments/6ef42811-c726-4321-8378-1ce245dba76f/codex-clipboard-82227e26-6272-45e8-87ce-193f4211254c.png`
- Implementation evidence: browser-rendered Chrome DevTools inline captures of `http://127.0.0.1:4173/?view=firewall`, including the open Security group filter and the open Security group control in the centered editor dialog. Chrome DevTools did not permit writing the capture to a durable local path.
- Source dimensions: `2166 × 1326` pixels. Implementation viewports: `1365 × 900` desktop for the open-filter comparison and `1024 × 900` for the responsive check; device scale factor 1. These are different viewport sizes because the source illustrates the native-dropdown defect, while the implementation capture verifies its replacement at usable desktop widths.
- State: tenant-wide firewall table with the Security group filter open; editor dialog opened to confirm the menu layers over the modal without clipping.
- Full-view comparison evidence: the source and browser-rendered desktop capture were opened and visually reviewed in the same QA pass. The desired difference is intentional: browser-native option chrome and its saturated blue selected row are replaced with the owned menu surface, pale selected row, checkmark, elevation, and controlled focus treatment.
- Focused comparison evidence: the firewall filter popup and security-group editor popup were inspected at native browser density. The initial custom-control pass exposed a double border from wrapper selectors, then the corrected pass verified a single control outline and a full `HTTPS` label.

### Findings

- [P1] Mid-width firewall heading and filter overflow
  Location: `FirewallScreen` at a 1024px browser width with the persistent desktop sidebar.
  Evidence: the initial browser capture compressed the heading beside its actions and caused page-level horizontal overflow.
  Impact: firewall filters and table controls became difficult to scan at a common laptop width.
  Fix: stack the page heading and make the filter row wrap below 1180px; keep the table's own horizontal scroller as the only horizontal overflow surface.

- [P2] Custom select wrapper received input styling
  Location: firewall toolbar and editor selector rules.
  Evidence: the first browser capture showed a faint double border and truncated the protocol label.
  Impact: the replacement looked less deliberate than the intended system control.
  Fix: apply visual input properties to `.select-menu-trigger` only, with width constraints on the wrapper.

### Comparison history

#### Pass 1

- Replaced all six native `<select>` controls with the shared `SelectMenu` component.
- Browser comparison found the P2 double-border regression in the editor and the P1 mid-width layout overflow.

#### Pass 2

- Corrected selector scope, added the 1180px firewall layout breakpoint, and added ids/names to the remaining search and checkbox fields.
- Rechecked the open filter, keyboard selection, centered editor menu, and 1024px layout. No P0, P1, or P2 visual issues remain.

### Fidelity surfaces

- Fonts and typography: preserves Inter, the established compact 13px control text, full protocol label, and the existing navy action hierarchy.
- Spacing and layout rhythm: uses the existing 5–8px input radius, tight menu-option spacing, controlled 6px trigger-to-menu gap, and a restrained elevation shadow; the mid-width filter row now stacks without page overflow.
- Colors and visual tokens: open controls use the existing blue focus treatment, menu selections use pale blue with navy text, and disabled controls retain muted opacity.
- Image quality and asset fidelity: this control change introduces no raster assets. It reuses the repository's Fluent chevron and checkmark icons rather than adding visual substitutes.
- Copy and content: option labels and current values are unchanged; only their presentation and interaction model changed.

### Interaction verification

- Clicked the Security group filter, verified the owned listbox opens with selected checkmark and clear open state.
- Selected `Approved agent updates` with ArrowDown then Enter; the filter applied and focus returned to the trigger.
- Opened Manage security groups and verified the centered-dialog selector is not clipped and the protocol selector displays `HTTPS` in full.
- Reloaded the page and confirmed no browser console errors, warnings, or Issues after adding ids/names to the non-select fields.
- Verified `document.documentElement.scrollWidth === clientWidth` at the 1024px browser width; table overflow remains contained to the table scroller.

### Implementation checklist

- [x] Replace all native selects in `apps/web/src/App.jsx` with the shared owned control.
- [x] Support click, outside dismissal, and Arrow/Home/End/Enter/Escape keyboard interaction.
- [x] Use menu portal positioning so menus are not clipped by dense cards or dialogs.
- [x] Match the existing ONEComputer light enterprise control system.
- [x] Fix responsive heading/filter behavior and document-level horizontal overflow.
- [x] Verify the rendered interaction path, responsive state, console, build, and focused UI tests.

final result: passed

## Egress firewall effective-policy table — 2026-07-24

- Source visual truth: `/home/mike/.codex/generated_images/019f943e-10af-7983-ac9b-adc05b3ac930/exec-7960ef5c-210c-48a8-84c3-2c319c4dd698.png` (selected third concept).
- Implementation screenshot: authenticated local browser capture of `http://127.0.0.1:4173/?view=firewall`, rendered through the UI fixture. The Chrome capture tool returned the screenshot inline to this task but denied its configured filesystem write, so no durable image path was emitted.
- Viewport and density: desktop browser client `1350px` wide; responsive browser client `485px` wide. Both captures used the same light ONEComputer theme and fixture state.
- State: `mike@metech.dev` administrator; two active rules in `Approved agent updates · v1`; `hello@metech.dev` present as a tenant workspace with policy required.
- Full-view comparison evidence: the selected V3 mock and the browser-rendered page were opened and inspected in the same design-QA pass. The table intentionally uses a contained horizontal scroller at narrower desktop widths so the persistent 336px navigation rail and readable 13px rule text are preserved.
- Focused comparison evidence: browser captures covered the centered group editor at desktop and responsive widths, the centered workspace-attachment dialog, administrator-scope notice, table search, and the no-policy workspace row.

### Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: the shared Inter hierarchy and `page-heading` anatomy are retained for the eyebrow, title, and descriptive subtext. The table uses a deliberately smaller, readable operational scale for dense rule data.
- Spacing and layout rhythm: the content begins at the shared top-bar gutter, the heading follows the primary-page rhythm, and the dense policy table replaces the earlier stacked editor and attachment card. The centered dialog is wide enough to preserve the rule builder's grid without horizontal page overflow.
- Colors and visual tokens: the page retains the warm white background, calm navy actions, pale blue administrator notice, neutral separators, green active state, amber policy-required state, and red default-deny state from the selected direction.
- Image quality and asset fidelity: neither the visual target nor the implementation requires raster artwork. Existing Fluent System Icons supply the product-consistent icon language; no placeholder or handcrafted visual asset was introduced.
- Copy and content: the administrator notice explains why other accounts are visible. Every active row exposes workspace, owner, immutable security-group version, destination, protocol, port, match, purpose, and state; the default-deny row exposes the behavior for all unmatched traffic.
- Accessibility and behavior: table headers, search and filter labels, status text, semantic actions, labelled modal dialogs, Escape-to-close, focus entry, and focus restoration were verified in the browser accessibility tree.
- Responsive behavior: desktop uses a scoped horizontal table scroller rather than allowing document-level overflow. On the responsive check, header actions stack, filters wrap, the table remains horizontally accessible, and the editor becomes a scrollable centered modal without clipped controls.

### Interaction verification

- Search for `anthropic` reduced the table to the matching rule while retaining the default-deny footer.
- `Add rule` opened the centered security-group editor with the existing immutable-version explanation and rule fields.
- `Change attachment` opened the centered attachment dialog, preserved the workspace owner, and showed the stop-first rule.
- Escape closed both dialogs and restored focus to their trigger.
- Browser console inspection completed with no errors or warnings.

### Comparison history

#### Pass 1

- Finding [P1]: the group editor inherited the generic 520px dialog width. Its rule-builder grid overflowed horizontally at desktop width, and the wide policy table also created document-level horizontal overflow.
- Fix: the editor now applies a higher-specificity 880px modal width, and the table scroller is paint-contained with its overflow confined to the table region.
- Post-fix evidence: desktop capture showed the full-width editor grid; browser measurements reported `documentElement.scrollWidth === clientWidth` (`1350px`) while the policy table retained its intentional internal horizontal scroll area.

### Implementation checklist

- [x] Replace the stacked firewall editor and attachment list with one effective-policy rules table.
- [x] Show workspace attachment and owner in the primary table.
- [x] Explain tenant-wide administrator scope in the UI.
- [x] Preserve immutable security-group versioning through a centered editor dialog.
- [x] Move attachment changes into a centered dialog; do not use a right-side inspector.
- [x] Verify desktop and responsive layouts, search, dialogs, and browser console.

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
