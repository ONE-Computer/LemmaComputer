**Comparison target**

- Source defect evidence:
  - Account flyout: `/home/mike/.codex/attachments/ceb9dabc-39da-4a2a-af03-b91bb8dfebf4/codex-clipboard-e1d1bd04-e4cd-49e3-9467-c07e51c69146.png` (2004 x 2208 px).
  - People and access: `/home/mike/.codex/attachments/f17e7fd0-92eb-4ca7-97a3-8ab2bc4e25ae/codex-clipboard-ae5e4715-1fd7-461a-b818-415bce06e1f6.png` (4712 x 1878 px).
  - Credentials: `/home/mike/.codex/attachments/5bb2c63b-140f-4f7e-8b4a-2a63d4390ac9/codex-clipboard-f0424e14-2f79-4ea4-8c04-312f31b0dfcb.png` (5038 x 1934 px).
- Browser-rendered implementation:
  - `/tmp/lemmacomputer-density-followup/account-menu-1470x730.png`.
  - `/tmp/lemmacomputer-density-followup/people-1470x730.png`.
  - `/tmp/lemmacomputer-density-followup/credentials-1470x730.png`.
- Full-view comparison evidence:
  - `/tmp/lemmacomputer-density-followup/account-menu-comparison.png`.
  - `/tmp/lemmacomputer-density-followup/people-comparison.png`.
  - `/tmp/lemmacomputer-density-followup/credentials-comparison.png`.
- Focused alignment evidence: `/tmp/lemmacomputer-density-followup/secondary-alignment-comparison.png`.
- Implementation viewport: 1470 x 730 CSS px, device scale factor 1, light theme, authenticated organization administrator.
- Normalization: the supplied screenshots are defect captures from different display crops rather than one pixel-fidelity mock. Each source was aspect-fit and padded to 1470 x 730 before being paired with the corresponding implementation. Exact geometry was therefore judged from the two implementation routes captured at the same viewport; source comparisons were used to confirm that the reported defects were removed.

**Findings**

- No actionable P0, P1, or P2 visual differences remain after the shell correction.
- Fonts and typography: the existing Inter hierarchy and compact 13–14px shell labels are preserved. The 316px account flyout keeps “My AI usage” and “AI control plane” on one line and leaves the profile name and email readable without the source capture's aggressive truncation.
- Spacing and layout rhythm: the sidebar is now 216px—slightly wider while retaining 36px navigation rows. The flyout extends 100px beyond the sidebar over the main canvas. Credentials and People and access both begin at x=254px at 1470 x 730, including the “Back to Settings” control, heading, divider, and card column.
- Colors and visual tokens: the warm shell, navy actions, pale blue surfaces, neutral borders, and account-card elevation remain unchanged. The higher stacking order is functional rather than decorative.
- Image quality and assets: these screens use the existing LemmaComputer wordmark and Fluent icons; no raster imagery, generated assets, placeholder graphics, custom SVGs, or CSS drawings were introduced.
- Copy and content: navigation, profile, Settings, Credentials, and People and access copy is unchanged. The improvement comes from available width and shared alignment rather than rewriting labels to fit.
- Interaction and accessibility: the account trigger still exposes `aria-expanded` and `aria-controls`; the flyout remains keyboard focusable, fits the viewport with owned vertical scrolling, and stays within the mobile drawer at the mobile breakpoint. Browser checks found no console errors or document overflow in the revised desktop states.

**Accepted differences**

- The source captures use different viewport sizes and organization fixture data, so literal pixel scale and content values are not comparable. The implementation was evaluated against the requested shell behavior and against itself at one controlled viewport.
- Home and Workspace retain a centered wide overview frame. The new left-anchored 1440px frame is specific to secondary pages, where cross-route alignment matters most.

**Comparison history**

1. The source account capture showed a P1 usability defect: the menu inherited the 196px sidebar width, wrapping action labels and truncating identity text.
2. The source Settings captures showed a P2 consistency defect: People and access used a 1240px centered route cap while Credentials used 1040px, shifting their back controls and headings to different x-coordinates.
3. Fixed the shell by widening the sidebar to 216px, giving the account flyout an independent 316px width and z-index 60, and allowing it to overflow over the main canvas.
4. Fixed secondary-page alignment with one left-anchored 1440px frame and removed route-local width caps from Credentials, provider settings, and People and access.
5. Post-fix screenshots and `secondary-alignment-comparison.png` show one stable left anchor, readable flyout labels, no clipping, and no horizontal overflow.

**Implementation Checklist**

- [x] Slightly widen the compact desktop sidebar.
- [x] Let the account flyout escape the sidebar width and stack above page content.
- [x] Constrain the flyout to the viewport and retain the mobile drawer behavior.
- [x] Standardize secondary-page width and left alignment.
- [x] Remove conflicting route-local page caps.
- [x] Verify account interaction, Settings route alignment, overflow, and browser console output at 1470 x 730.
- [x] Pass the full browser suite (103/103) and the repository quick gate (726 tests: 694 passed, 32 skipped).

**Follow-up Polish**

- No P3 follow-up is required for this increment.

final result: passed
