**Comparison target**

- Source visual truth: `/home/mike/.codex/attachments/d9a9999b-2604-4740-9db7-ad67bd00383b/codex-clipboard-045a0d90-6918-4f0f-ba5f-92740a96e32a.png` (4980 x 1958 px), showing the unwanted left-anchored Settings frame.
- Browser-rendered implementation:
  - `/tmp/lemmacomputer-density-correction/settings-centered-1920x900.png` (1920 x 900 px).
  - `/tmp/lemmacomputer-density-correction/credentials-centered-1920x900.png` (1920 x 900 px).
  - `/tmp/lemmacomputer-density-correction/people-centered-1920x900.png` (1920 x 1622 px full-page capture).
- Full-view source/implementation comparison: `/tmp/lemmacomputer-density-correction/settings-centered-comparison.png` (3840 x 900 px).
- Focused cross-route comparison: `/tmp/lemmacomputer-density-correction/secondary-centered-comparison.png` (3840 x 900 px), pairing the first 900px of Credentials and People and access.
- Implementation viewport: 1920 x 900 CSS px, device scale factor 1, light theme, authenticated organization administrator.
- Normalization: the 4980 x 1958 source was aspect-fit and padded to 1920 x 900 before pairing with the 1920 x 900 implementation. The source is defect evidence rather than a target for fixture copy or literal scale.

**Findings**

- No actionable P0, P1, or P2 visual differences remain after restoring centered alignment.
- Fonts and typography: the existing Inter hierarchy, compact headings, and 13–14px shell labels remain unchanged. No new wrapping or truncation was introduced.
- Spacing and layout rhythm: every secondary route uses the same 1440px maximum frame, centered within the main canvas. At 1920px, the left and right outer insets are equal; Settings, Credentials, and People and access use the same page column and Back to Settings coordinate.
- Colors and visual tokens: no color, elevation, border, radius, or semantic-state token changed.
- Image quality and assets: the screens retain the LemmaComputer wordmark and Fluent icons; no raster assets, placeholders, custom SVGs, or CSS drawings were introduced.
- Copy and content: all route copy is unchanged.
- Interaction and accessibility: the account flyout remains a 316px viewport-bounded overlay; desktop centering does not change mobile drawer behavior, keyboard operation, focus behavior, or scroll ownership. The focused Playwright pass found no document overflow or console errors.

**Accepted differences**

- The reference uses different fixture data and an ultra-wide cropped display. It is used to establish the alignment defect, while the corrected geometry is verified at a controlled 1920 x 900 viewport.
- Pages shorter than the viewport naturally leave vertical whitespace; this is unrelated to the corrected horizontal frame.

**Comparison history**

1. The earlier shell pass correctly standardized secondary pages at 1440px but incorrectly set `margin: 0`, anchoring the frame to the left edge of the main canvas. This was a P1 composition regression on wide screens.
2. Restored `margin: 0 auto` while retaining the shared 1440px width token and all route-cap removals.
3. Fresh Settings, Credentials, and People captures show a common centered frame. The full-view and focused combined comparisons show no remaining alignment mismatch.

**Implementation Checklist**

- [x] Preserve one shared, wider 1440px secondary-page width.
- [x] Center that frame within the post-sidebar main canvas.
- [x] Keep every Settings subsection on the same frame and Back to Settings coordinate.
- [x] Preserve the wider account flyout and mobile drawer behavior.
- [x] Pass static shell checks (37/37) and focused responsive Playwright checks (5/5).
- [x] Pass the complete browser suite (103/103) and repository quick gate (726 tests: 694 passed, 32 skipped).

**Follow-up Polish**

- No P3 follow-up is required for this correction.

final result: passed
