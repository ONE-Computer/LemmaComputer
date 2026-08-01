# E2B preflight evidence — 2026-08-01

This is a read-only account preflight for the live ONEComputer Cowork E2B
qualification gate. The temporary API credential was supplied out-of-band and
was not written to this repository, an environment file, or this evidence.

## Result

Command:

```text
E2B_API_KEY=… npm run preflight:e2b
```

Observed response:

```json
{
  "e2bApi": "reachable",
  "templateCount": 0,
  "configuredTemplate": null,
  "configuredTemplateState": null,
  "ready": false
}
```

The preflight also reported all seven governed qualification routes as
unconfigured:

- `ONECOMPUTER_CONTROL_URL`
- `ONECOMPUTER_PROXY_TOKEN`
- `ONECOMPUTER_SESSION_COOKIE`
- `ONECOMPUTER_CONTROLLER_URL`
- `ONECOMPUTER_CONTROLLER_INTERNAL_TOKEN`
- `ONECOMPUTER_E2B_DENY_HOST`
- `MANAGED_SANDBOX_EGRESS_PROXY_URL_TEMPLATE`

No sandbox or template build was created. A minimal public image would not be
valid evidence for the ONEComputer goal because it would omit the pinned ACP,
browser/document VCR, gateway, policy, and artifact runtime. The next
authorized provisioning step is therefore to publish the actual immutable
workspace image and set the governed routes before running
`npm run qualify:e2b:cowork`.

This result is an infrastructure prerequisite failure, not an application
test failure. It does not authorize bypassing the live gate with fixtures.
