# Design QA: workspace guardrails and network access

## Comparison target

- Source visual truth: `/home/mike/.codex/generated_images/019fffd3-5f0b-78f3-9986-ab9d7c450417/exec-26a262a7-8778-4b43-9b6d-f3ab25120c60.png`
- Guardrails implementation: `/home/mike/Documents/onecomputer/.worktrees/network-access-product-model/test-results/workspace-guardrails-v1.png`
- Security-group editor: `/home/mike/Documents/onecomputer/.worktrees/network-access-product-model/test-results/firewall-security-group-editor-reviewed.png`
- Focused rule row: `/home/mike/Documents/onecomputer/.worktrees/network-access-product-model/test-results/firewall-security-group-rule-reviewed.png`
- Network-access inventory: `/home/mike/Documents/onecomputer/.worktrees/network-access-product-model/test-results/network-access-reviewed.png`
- Viewport: 1487 x 1058 CSS pixels, desktop, light theme, `deviceScaleFactor: 1`.
- Source and full implementation captures: 1487 x 1058 pixels. No density normalization was required.
- Focused rule capture: 827 x 71 pixels.
- State: organization administrator, guardrails v1 saved, one public-web block-list group created and attached to one Internet workspace.

## Findings

No actionable P0, P1, or P2 visual issues remain.

Accepted product deviations from the selected concept:

- The existing Workspace page heading remains above the tab set. This preserves the shared LemmaComputer shell instead of introducing a one-off page structure.
- Network access is not an editable guardrail row. The later approved product model makes workspace type the network baseline and keeps per-workspace exceptions in the administrator-only Network access surface.
- The product labels are `Restricted workspace` and `Internet workspace`, and the sidebar label is `Network access` instead of `Firewall`.
- Fixture counts and names differ from the concept data, but the impact-summary, state-panel, control-group, and affected-workspace hierarchy match the selected direction.

## Required fidelity surfaces

- Fonts and typography: passed. Inter is retained throughout; headings, labels, table text, metadata, and status copy preserve the existing optical hierarchy and remain readable without unexpected wrapping.
- Spacing and layout rhythm: passed. The 1487 px desktop layout retains the generous content width, clear section boundaries, right-side state panel, affected-workspace table, centered modal, and consistent row density.
- Colors and visual tokens: passed. Existing navy actions, blue links, quiet neutral borders, pale semantic badges, green current state, amber review state, and red blocked state remain consistent with the product system.
- Image quality and asset fidelity: passed. These screens contain only product UI and the existing icon library; no source image asset was replaced with CSS art, placeholder art, or a handcrafted SVG.
- Copy and content: passed. Guardrail ownership, effective network source, immutable versions, fixed type defaults, attachment impact, and outcome-based destination rules are explicit. Internal profile IDs and execution-mode names are not shown.

## Full-view comparison evidence

- The source and implementation were opened together at the same 1487 x 1058 pixel size.
- Both use the persistent left navigation, top workspace tabs, guardrail title/version/action, impact summary, effective controls, right-side state context, affected-workspace inventory, and history beneath the primary content.
- The Network access inventory was separately reviewed at the same viewport. System defaults are visibly fixed, custom groups show an outcome and attachment count, and the primary action remains prominent without overpowering the inventory.

## Focused region comparison evidence

- The focused 827 x 71 rule-row capture was inspected because the action, traffic coverage, scope, purpose, and removal affordance are too small to judge reliably in the full modal capture.
- The row communicates one blocked destination and groups standard HTTP and HTTPS traffic into one human-readable rule while retaining an explicit removal action.

## Interaction and accessibility evidence

- Playwright verified that ordinary members cannot discover guardrail or network administration.
- The administrator set guardrails, confirmed the thinking selector exposes only Low, Medium, and High, assigned and reset a Restricted-workspace exception, created a public-web block list, added a standard HTTP+HTTPS destination, assigned it to a compatible Internet workspace, and observed the live attachment count.
- The same guardrail flow passed at the covered narrow viewport.
- Full repository browser result: 104 passed.

## Comparison history

### Pass 1

- P2: the access-model helper said both destinations and workspace assignments had to be removed even for a new, unattached group.
- Fix: the helper now distinguishes a group with destinations from an attached group and gives only the relevant prerequisite.

### Pass 2

- Re-captured the guardrails page, editor top state, focused rule row, and final network inventory at 1487 x 1058.
- The prior P2 copy issue is resolved. No actionable P0, P1, or P2 findings remain.

## Follow-up polish

- None required for this scope.

final result: passed
