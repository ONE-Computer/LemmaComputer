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
