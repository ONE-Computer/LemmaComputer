# Responsive UX review evidence (2026-08-13)

**Point-in-time evidence for [issue #70](https://github.com/ONE-Computer/LemmaComputer/issues/70), not a current UI specification or WCAG claim.** The review found nine route-level responsive or focus defects. The remediation branch reported all nine resolved, but its record still calls for product-owner approval before issue closure. Keep the [capture set](assets/responsive-ux-audit/) and [measurements](assets/responsive-ux-audit/measurements.json) until that approval and evidence retention decision are complete.

| ID | Defect reviewed | Reported result |
| --- | --- | --- |
| RUX-01 | Organization workspace actions clipped at compact desktop size | Resolved in remediation capture |
| RUX-02 | People actions clipped at 720 px | Resolved in remediation capture |
| RUX-03 | Mobile model-route table overflow | Resolved in remediation capture |
| RUX-04 | Firewall action clipping | Resolved in remediation capture |
| RUX-05 | Workspace-policy assignment clipping | Resolved in remediation capture |
| RUX-06 | Invisible focus on workspace tabs | Resolved in remediation capture |
| RUX-07 | Hidden mobile AI navigation destinations | Resolved in remediation capture |
| RUX-08 | Compact-height sign-in and sign-up reachability | Resolved in remediation capture |
| RUX-09 | Chat composer below the 720 px viewport | Resolved in remediation capture |

The fixture-based review sampled desktop, narrow, and mobile viewports,
including Chat, Activity, sign-in, and sign-up. It inspected fresh screenshots,
document overflow, clipped controls, focus, and dialog scroll ownership. It did
not test screen readers, native zoom, high-contrast mode, reduced motion, real
tenant data, or live backend behavior. The observations describe the tested
branch and date only. Current behavior needs a fresh browser run.

The lasting UI contracts are: no document-wide horizontal overflow; visible
and row-associated actions; visible keyboard focus; dialogs with reachable
close and primary controls; and independent scroll ownership for dense tables,
Chat, and Activity. The current automated gate is
`tests/e2e/responsive-remediation.spec.ts` with compact-auth coverage in
`tests/e2e/customer-authentication.spec.ts`.

For a new capture, run the fixture and Vite audit configuration in separate
terminals, then the capture script. New output goes to ignored
`.artifacts/responsive-ux-audit/`; it does not overwrite this historical
review set.

```bash
UI_FIXTURE_PORT=24370 npm run dev:ui-fixture
LEMMACOMPUTER_CONTROL_URL=http://127.0.0.1:24370 npm run dev -w web -- --config ../../scripts/vite-responsive-audit.config.mjs --host 127.0.0.1 --port 24371 --force
node scripts/capture-responsive-ux-audit.mjs
```
