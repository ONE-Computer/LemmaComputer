# Design QA — Chat workspace selector and recent-chat sidebar

## Comparison target

- Source visual truth: `/home/mike/.codex/attachments/e11d9010-501c-4d17-bc4c-ac9fe7e3102f/codex-clipboard-795c6e12-970e-43bc-8ceb-9a36f000c9b8.png` (the existing ONEComputer Chat screen, 2048 × 1248) and `/home/mike/.codex/attachments/1f6c03a9-4063-496b-b4b1-ad85fed1d456/codex-clipboard-ade667bc-8d8e-4954-aeac-dee53791ea70.png` (the supplied ChatGPT Recents reference, 1306 × 1740).
- Implementation screenshot: Chrome DevTools in-chat capture of `http://127.0.0.1:4174/?view=chat&mock=3` (file export is disallowed by the browser tool); 1440 × 1000 CSS px at device scale factor 1.
- State: desktop Chat welcome screen, one visible workspace, one configured agent, and enough realistic recent sessions to exercise sidebar scrolling. The browser mock supplies this rendering state because the normal local route requires a Microsoft session.
- Density normalization: source screenshots use different crops and display scale, so the comparison is structural: one desktop sidebar, compact single-line recents, and a fixed right-aligned context picker. Typography and native controls were assessed at their rendered CSS size rather than pixel-for-pixel against the differently scaled captures.

## Comparison history

### Iteration 1 — corrected

**Findings**

- [P1] Recent chats were distributed through the remaining sidebar height.
  Location: `.sidebar-chat-history` and `.sidebar-chat-history button`.
  Evidence: the supplied ONEComputer screen leaves very large vertical gaps between successive titles; the supplied ChatGPT reference instead forms a compact, scrollable recents list.
  Impact: only a few conversations are visible and the chat sidebar feels unfinished.
  Fix: replaced the stretched grid with a flexible, overflow-scrolling column; gave rows a compact 38 px minimum height and stable horizontal padding.

### Iteration 2 — post-fix comparison

Full-view evidence: the browser-rendered implementation and both supplied screenshots were opened in one visual comparison input. The new desktop screen shows the workspace picker at the top right and eleven compact recent rows before the viewport boundary, with the remaining rows reachable by the sidebar scroll bar.

Focused-region evidence: the header selector and recent-chat column are both legible in the full comparison, so no separate crop was needed.

**Findings**

- No actionable P0, P1, or P2 visual differences remain for this requested change.

### Iteration 3 — composer text alignment

Source visual truth: `/home/mike/.codex/attachments/f06d1192-8b0e-4990-977f-1b136c2799b0/codex-clipboard-0ccc4c59-54f8-4bdf-b0c1-0a0ef944caf8.png` (2048 × 288). Implementation evidence: Chrome DevTools in-chat capture of `http://127.0.0.1:4174/?view=chat&mock=4` (1440 × 1000 CSS px at device scale factor 1; file export is disallowed by the browser tool).

**Findings**

- [P1] The composer placeholder was not constrained to the same vertical track as its attachment and send controls.
  Location: `.chat-composer textarea`.
  Evidence: the supplied composer crop shows the placeholder sitting optically above the two circular controls.
  Fix: made the textarea a 36 px, center-aligned element with a 24 px line-height and balanced 6 px vertical padding.

Post-fix evidence: the browser capture shows the composer, textarea, attachment control, and send control all centered on the same y-coordinate (943 px); the textarea and both controls share the exact `top: 925 px` / `height: 36 px` track. No console errors were present. `npm run build --workspace web` passed.

## Fidelity surfaces

- **Fonts and typography:** retains ONEComputer's Inter-based visual system; chat titles remain single-line, readable, and truncated only when necessary.
- **Spacing and layout rhythm:** recents use compact, consistent rows rather than vertical distribution; the sidebar remains independently scrollable; the workspace picker occupies the existing top-right context-control area.
- **Colors and visual tokens:** existing neutral sidebar, selected Chat treatment, and primary-text contrast are unchanged.
- **Image quality and assets:** no raster imagery changed; existing Fluent UI icon assets remain in use.
- **Copy and content:** the selector is explicitly labelled “Workspace”; the existing “RECENT” label and conversation titles are preserved.

## Interaction and runtime checks

- Opened the accessible **Choose workspace** selector; it reports an expanded listbox.
- Activated **Start a new chat**; it remains keyboard focusable and preserves the welcome composition.
- Confirmed current-page console errors: none.
- `npm test`: 154 passing, 0 failing.
- `npm run build`: passed (only existing Vite dependency/chunk-size warnings).

## Implementation checklist

- [x] Always render the workspace picker when a Chat workspace is available.
- [x] Preserve the selected workspace and agent across refresh.
- [x] Page and lazily extend chat history instead of bounding the sidebar visually.
- [x] Use a compact, scrollable recent-chat list.

## Follow-up polish

- [P3] If a future desktop layout calls for a wider navigation rail, revisit it across every primary page rather than widening only Chat.

final result: passed
