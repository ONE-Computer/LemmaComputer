# AI control plane design QA

- Overview reference: `/home/mike/.codex/generated_images/019fb309-3e6d-7f11-9a4c-0eed1cf2bee2/call_fL6iISHzpJwS5PvwCoKRWCpE.png`
- Model routes reference: `/home/mike/.codex/generated_images/019fb309-3e6d-7f11-9a4c-0eed1cf2bee2/call_ucX0rLbhBtKQUFE7izTW9Kne.png`
- Profile-menu reference: `/home/mike/.codex/attachments/95e804f1-e2d0-43ea-be7d-65478ca48b40/codex-clipboard-a82475e2-6638-4678-bfc9-ed44c76c52b2.png`
- Implementation captures: `/tmp/onecomputer-ai-control-overview-final.png`, `/tmp/onecomputer-model-routes-matched.png`, and `/tmp/onecomputer-profile-control-plane.png`.
- Comparison surface: all three source/implementation pairs were loaded together in one local browser board.
- Comparison viewport: 1900 × 1200; application captures: 1440 × 1000, light theme, administrator fixture state.
- Data-state note: illustrative reference numbers were not copied into live views; unavailable evidence stays explicitly qualified.

**Full-view comparison evidence**

The Overview and Model routes references were placed beside their matched application captures in the same browser input. The implementation preserves the selected information hierarchy, restrained LemmaComputer palette, compact tab navigation, card rhythm, and enterprise data density.

**Focused region comparison evidence**

The profile-menu reference and implementation were compared together. The implementation retains the identity block, Settings, and Log out layout, adds a clearly scoped `Organization` group above Settings, and keeps the AI control plane out of primary navigation. Model routes table typography, row alignment, price density, status colors, and primary actions were also reviewed side by side.

**Findings**

- [P1 resolved] Model routes caused document-level horizontal overflow at 1440 px.
  - Fix: removed nested page padding, contained the control-plane content, and consolidated four price dimensions into one compact pricing-coverage cell.
- [P2 resolved] The Model routes heading wrapped into a narrow column and then gained excessive height during the first correction.
  - Fix: stacked mapping actions below a stable title block and removed column flex growth.
- [P2 resolved] The first dashboard chart used an inline SVG and gradient; it now uses accessible ledger-bucket bars and a flat background.
- [P2 resolved] Pricing was a placeholder even though rate-card editing existed; Pricing is now a functional tab backed by the immutable rate-card and mapping workflow.
- No open P0, P1, or P2 visual findings remain at the reviewed desktop viewport.

**Required fidelity surfaces**

- Fonts and typography: passed; Inter and the existing LemmaComputer heading hierarchy are preserved.
- Spacing and layout rhythm: passed after the header, nested-padding, and table-density fixes.
- Colors and visual tokens: passed; existing navy, warm-white, line, and semantic status tokens are reused.
- Image quality and asset fidelity: passed; the existing brand wordmark and Fluent UI icons are used, with no fabricated image assets.
- Copy and content: passed; stable employee aliases and administrator-only provider, pricing, and rollout boundaries are explicit.

**Interaction evidence**

- Loaded Auto, Lite, Balanced, and Pro aliases with concrete provider deployments.
- Displayed input, output, cache-read, and cache-write price buckets and explicit pricing gaps.
- Created and edited a local mapping draft.
- Published an immutable mapping version without changing Team rollout state.
- Created an immutable price record, attached it to a local mapping draft, and published the priced mapping.
- Preserved Team policy, evidence review, production enablement, routing-decision inspection, and kill-switch flows.
- Final Chrome console inspection found no errors or warnings; the Playwright scenario completed without page or action failure.

**Comparison history**

- Initial same-input comparison found document overflow, cramped route-heading geometry, a placeholder Pricing tab, and a generated chart treatment.
- Second comparison verified the Overview hierarchy and profile-menu placement, then found a residual Model routes table scrollbar.
- Final comparison confirmed the compact six-column table fits the target viewport, all four token-price dimensions remain visible, and no P0/P1/P2 issue remains.

**Verification**

- Chrome accessibility snapshots confirmed one organization-level h1 and semantic child headings.
- Browser geometry confirmed the document and route table fit the reviewed desktop viewport.
- Focused Playwright covers administrator discovery, employee denial, URL/history-backed tabs, Pricing, route mapping, immutable rate cards, publication, shadow review, enablement, decision evidence, and the kill switch.

**Follow-up polish**

- Tablet and narrow-mobile visual comparison remains future polish; responsive layout and table containment are implemented but were not selected reference surfaces.

final result: passed
