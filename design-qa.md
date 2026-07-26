# Firewall security-group revamp QA

## Evidence

- Problem-state screenshots:
  - `/home/mike/.codex/attachments/95c83c5d-ef4d-4c6b-b8d1-8a5f6ae65f92/codex-clipboard-da0a38d6-e19e-429f-991e-4df102bf59d4.png`
  - `/home/mike/.codex/attachments/0666bc23-9c8b-465d-819b-dc3b0e1ff690/codex-clipboard-1c255930-ce54-4005-ae01-ac6254e44beb.png`
- Browser-rendered revamp:
  - `design-qa-assets/firewall-security-groups-only.png`
  - `design-qa-assets/workspace-security-group-attachment.png`
  - `design-qa-assets/firewall-manage-group-revamp.png`
  - `design-qa-assets/firewall-create-group-revamp.png`

## Mental-model acceptance

- The page-level primary action is `Create security group`.
- The Firewall screen contains only the security-group library; it has no workspace-policy or attachment table.
- The built-in Default security group is visible in the same inventory as custom groups.
- Each group exposes its Allow and Deny rule counts and latest audit revision.
- `Manage group` opens one group directly; the editor no longer contains a second group switcher.
- `Add rule` exists only inside the security-group editor.
- The editor supports both Allow and Deny actions.
- Saving an existing group records a new audit revision and updates workspaces using that group.
- A workspace’s Security section displays and changes its attached security group.
- Rule edits and group changes refresh the egress proxy live without restarting the workspace.

## Interaction and visual checks

- Captured the full firewall page at a 1440 × 1000 viewport.
- Opened `Manage group` and verified the selected group, its rules, the Add rule builder, and two rule selectors.
- Opened `Create security group` and verified blank name and description fields, an empty rule list, and a disabled create action until required metadata is entered.
- Confirmed no browser console errors during the tested flows.
- Captured the workspace Security section with its attached Default group selector.
- Confirmed the security-group inventory remains readable within the existing desktop shell.
- Confirmed group cards collapse to a single-column mobile layout.

## Findings

- No P0, P1, or P2 issues remain.
- P3: programmatic initial focus gives the modal close button a visible focus ring. This is an intentional accessibility affordance.

## Verification

- Production web build: passed.
- Full automated suite: 184 passed, 0 failed.
- Diff whitespace check: passed.

final result: passed

---

# Chat composer design QA

- Source visual truth: `/home/mike/.codex/attachments/2378e46c-eb79-4210-b57f-0b5deef66ec7/codex-clipboard-e95b1b4b-362a-402f-b059-c5b2e9a8e27d.png`
- Original broken implementation: `/home/mike/.codex/attachments/580a0aba-0fc6-4f66-a310-12f29f7fdd5f/codex-clipboard-6486da78-086c-4b8d-8a38-110ae6608158.png`
- Final implementation screenshot: `/home/mike/Documents/onecomputer/.artifacts/chat-composer-desktop-final.png`
- Final focused comparison: `/home/mike/Documents/onecomputer/.artifacts/chat-composer-comparison-final.png`
- Browser viewport: 1440 × 900 CSS px
- Browser density: device scale factor 1
- Source pixels: 2034 × 220, normalized from the supplied @2x capture to 1017 × 110
- Implementation pixels: 1440 × 900; focused crop 1017 × 110
- State: desktop Chat, empty conversation, disabled send button

## Full-view comparison evidence

The final desktop capture retains ONEComputer navigation and the centered empty-chat state while using the ChatGPT reference for the composer only. The composer is a single horizontal pill at the bottom of the conversation, centered at a 768px content width. It contains the actions button, flexible text input, contextual agent/workspace control, and send button in that order.

## Focused comparison evidence

The final comparison places the normalized ChatGPT source above the implementation crop. Both use the same 768px pill width, approximately 54px pill height, circular edge controls, single-line input, subtle neutral border, white surface, and low elevation. A focused comparison is necessary because the composer controls are too small to judge accurately from the full application view.

## Required fidelity surfaces

- Fonts and typography: Inter remains the product font. Placeholder and context labels use 16px and 14px text respectively, with neutral gray values and single-line truncation.
- Spacing and layout rhythm: the pill uses 36px controls, 7px inset padding, 2px internal grid gaps, a 26px radius, and a 768px maximum width. The relative left and right control insets match the normalized source.
- Colors and visual tokens: the implementation uses a white surface, `#dedede` border, neutral gray placeholder/context text, a gray disabled send state, and restrained shadow comparable to the source.
- Image quality and asset fidelity: no raster imagery is present in the source component. Fluent UI icons are retained for product-supported actions; no improvised CSS or text-glyph icons were introduced.
- Copy and content: ChatGPT-specific `Ask ChatGPT` and `Medium` text is intentionally replaced with ONEComputer’s agent placeholder and `Agent · Workspace` context. Voice controls are omitted because ONEComputer does not currently provide voice input/output.

## Interaction and responsive verification

- Opened the actions menu and verified Attach files, New conversation, and recent sessions.
- Opened the context menu and verified Workspace and Agent selectors.
- Submitted a fixture chat message and received the streamed assistant response.
- Selected an existing thread and verified its transcript loaded.
- Checked the 393 × 852 mobile breakpoint; the composer preserves the established two-row companion layout.
- Checked browser console after the interactions; no warnings or errors were present.

## Comparison history

1. Initial implementation — blocked.
   - P0: desktop composer inherited the wrong grid structure and CSS precedence. The textarea, actions, context, and send controls clipped and overlapped.
   - Fix: moved the textarea into the same semantic control row as the actions, context, and send controls; established desktop and mobile layouts explicitly.
2. Iteration 1 — blocked.
   - P2: the horizontal composition was correct, but the implementation pill was about 60px high versus the normalized source’s roughly 54px, with excessive left inset.
   - Fix: reduced desktop controls from 40px to 36px, tightened horizontal padding and gaps, and reduced the radius from 28px to 26px.
3. Iteration 2 — passed.
   - The normalized focused comparison shows no remaining actionable P0, P1, or P2 fidelity mismatch. Product-specific context text and the absence of unsupported voice controls are intentional.

## Findings

No actionable P0, P1, or P2 findings remain.

## Follow-up polish

- P3: if voice support is added later, microphone and voice-mode affordances can occupy the same right-side control group as ChatGPT without changing the composer layout.

final result: passed
