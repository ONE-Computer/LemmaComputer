# Firewall evolution design QA

## Evidence

- Source visual truth:
  - `/home/mike/.codex/attachments/18a2dfa8-5270-461f-9669-42eadb6c804a/codex-clipboard-9a96717a-5938-423f-90d9-a8e001019d16.png`
  - `/home/mike/.codex/attachments/f929d2eb-5f6d-418a-92ee-cff358088fbc/codex-clipboard-e556e029-b1c3-4d39-8930-4a68bc6b4963.png`
- Browser-rendered implementation:
  - `design-qa-assets/firewall-table-v1.png`
  - `design-qa-assets/firewall-deny-modal-v1.png`
  - `design-qa-assets/firewall-deny-saved-v1.png`
  - `design-qa-assets/firewall-manage-modal-v1.png`
- Combined comparison evidence:
  - `design-qa-assets/firewall-table-comparison-v1.png`
  - `design-qa-assets/firewall-manage-modal-comparison-v1.png`

## Viewport and normalization

- Table source: 3000 × 1600 px.
- Table implementation: 1920 × 1024 px at a 1920 × 1024 CSS viewport and device scale factor 1.
- The table images have the same 1.875 aspect ratio and were both normalized to 1500 × 800 px before being placed in the combined comparison.
- Modal source: 2048 × 1536 px.
- Modal implementation: 2048 × 1536 px at a 1024 × 768 CSS viewport and device scale factor 2.
- The modal comparison uses equal pixel dimensions without density resampling.
- Theme: light.
- State: tenant administrator firewall table; open-workspace default allow visible; explicit deny visible; security-group editor open.

## Full-view comparison

The implementation preserves the source hierarchy, typography, white canvas, navy actions, blue administrator notice, table density, borders, semantic colors, and centered modal treatment. The persistent product sidebar is intentionally present in the implementation because it is part of the current application shell; the supplied table reference is cropped to the page content.

The new open-workspace default is shown as an effective row with all public destinations, HTTP/HTTPS, ports 80/443, and an Allow result. Explicit deny rows use the same table anatomy and a red semantic result. Managed workspaces retain their default-deny row.

## Focused comparison

The modal comparison was captured at the source's apparent 1024 × 768 CSS viewport and 2× density. Field heights, group selector, two-column metadata row, rule card, light rule-builder panel, footer notice, and primary/secondary actions align with the source. The new Action control adds one compact grid track without overflowing or obscuring any input.

## Required fidelity surfaces

- Fonts and typography: Inter, weights, sizes, line heights, letter spacing, and hierarchy remain consistent with the source and existing product.
- Spacing and layout rhythm: page and modal spacing, field heights, section gaps, radii, and borders remain consistent. The table continues to use intentional horizontal overflow for dense columns.
- Colors and visual tokens: navy primary actions, pale-blue notice, green Allow, red Deny, gray defaults, and warm policy-required status retain sufficient contrast and match the existing token language.
- Image quality and assets: no raster imagery is required. Existing Fluent UI icons remain sharp at both densities; no placeholder or handcrafted graphic was introduced.
- Copy and content: managed default-deny and open default-allow behavior are explicit. The deny action, attachment scope, stopped-workspace requirement, and protected destination classes are stated in the relevant flow.

## Primary interactions tested

- Opened the open-workspace `Add deny rule` action.
- Verified the rule action defaults to Deny.
- Entered a new security-group name, description, destination, and purpose.
- Saved and attached the immutable group version.
- Verified the dialog closed and the deny destination appeared in both affected managed and open effective-policy rows.
- Opened the saved group editor and verified the deny rule and Action selector.
- Checked browser console and runtime exceptions: no errors or warnings.

## Findings

- No actionable P0, P1, or P2 findings remain.
- P3: programmatic initial focus gives the modal close button a visible focus ring. This is an intentional accessibility affordance and does not block fidelity or use.

## Comparison history

- Pass 1: no P0/P1/P2 visual or interaction issues found. No corrective visual iteration was required.

## Implementation checklist

- [x] Show the effective open-workspace all-public HTTP/HTTPS rule.
- [x] Show managed and open defaults per workspace.
- [x] Create explicit allow or deny rules.
- [x] Give explicit deny rules precedence at runtime.
- [x] Attach a saved deny group from the open-workspace row.
- [x] Preserve the centered immutable-version editor.
- [x] Verify responsive overflow, modal fit, core interaction, and console state.

final result: passed
