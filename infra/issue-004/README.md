# Issue 004 OpenVTC companion implementation

The companion is served by ONEComputer Web at `/companion`. It is a distinct
installable experience on the same authenticated origin as the owned workspace
UI. It does not depend on a Kasm session, workspace browser, or workspace
readiness.

## Browser and platform support decision

| Browser | Platform | Current decision |
| --- | --- | --- |
| Current Chrome | Windows, macOS, Linux, Android | Supported implementation; physical matrix still required |
| Current Edge | Windows, macOS | Supported implementation; physical matrix still required |
| Current Firefox | Windows, macOS, Linux | Verification required before product support |
| Safari | macOS and installed iOS web app | Verification required before product support |

The UI checks secure-context, Service Worker, Push API, Notifications API, and
WebAuthn PRF availability. It reports unsupported, denied, missing, and invalid
states without falling back to bearer approval. iOS background delivery is not
claimed outside an installed web app.

## Protocols and pins

- Companion subscription protocol:
  `onecomputer-companion-push-0.1`.
- Service worker:
  `onecomputer-companion-sw-0.1`.
- OpenVTC task consent:
  `https://trusttasks.org/spec/task-consent/request/0.1` and the existing
  decision verifier.
- Push adapter:
  `web-push@3.6.7`, MPL-2.0, pinned in `package-lock.json`.
- Browser signing profile:
  the existing WebAuthn PRF-wrapped Ed25519 approver key derived from the
  qualified OpenVTC browser agent.

Generate a stable local VAPID key pair and a separate subscription-encryption
secret with `npm run key:web-push`, then inject all four
`ONECOMPUTER_WEB_PUSH_*` values into Control. Partial configuration fails at
startup.

## Minimized notification

The encrypted Web Push body is exactly:

```json
{"version":"1","event":"approval-pending"}
```

It contains no operation or task identifier, tenant, user, resource, Microsoft
content, digest, bearer, decision, signing key, or deep-link token. The service
worker accepts only this exact two-field shape and shows generic text. Clicking
the notification opens `/companion`; normal authentication and exact
recipient-bound signed-task retrieval happen afterward.

Push endpoint and subscription key material are encrypted with AES-256-GCM
before persistence. Only a SHA-256 endpoint digest is indexed. Control logs
redact request bodies and authorization headers.

## Delivery and authority

Each active companion has its own enrolled approver DID, installation ID,
transport token hash, encrypted push subscription, and recipient-bound consent
task. A durable `(task, subscription)` outbox deduplicates delivery and records
bounded exponential retry state. Control retries due or interrupted deliveries
on a timer and after restart.

Multiple companion tasks still point to one governed operation. The first
valid device-signed decision atomically changes that operation and invalidates
the remaining live tasks. A late, duplicate, conflicting, bearer-only, expired,
revoked, or cross-user decision issues no lease.

The service worker has no fetch handler and caches no page, authentication
response, task, or decision material. Activation clears any cache belonging to
its origin. Notification actions cannot approve or deny.

## Activity history

The companion has separate `Approvals` and `Activity` views. Activity is a
read-only projection of Control's existing governed-operation truth; it is not
a second audit store and exposes no decision endpoint.

`GET /v1/openvtc/companion/activity` uses a stable, bounded cursor and filters
by the authenticated tenant and subject in storage. The projection contains
the action, human-facing target, lifecycle state, timestamps, humanized
requester, decision, and terminal outcome. The detail endpoint adds a
tool-specific allowlisted projection of user-visible request content (for
example, Teams destination and message text) plus a human-readable timeline.
It never returns the raw argument object or opaque target IDs, operation
digests, nonces, policy hashes, workspace IDs, correlation IDs,
approver/device identifiers, subscription data, tokens, or keys.

Historical rows never contain approval controls. A live
`approval_required` row can only navigate back to the Approvals view, where the
normal recipient-bound signed-task retrieval and physical signing gesture still
apply.

## Local verification

Automated coverage includes:

- identity-scoped enrollment and subscription;
- encrypted subscription persistence and public response redaction;
- generic payload inspection;
- task/subscription delivery deduplication;
- stable companion Activity pagination, identity isolation, and projection
  redaction;
- multiple recipient-bound device tasks converging on one legal terminal path;
- late second-device decisions issuing no second execution;
- wrong subscription-encryption key failure;
- the existing issuer, key, audience, tenant, subject, digest, nonce, expiry,
  mutation, replay, and requester-exclusion matrix.

Physical Web Push, install, permission recovery, authenticator, provider
outage, restart, and browser/platform evidence is still required before Issue
004 can be marked complete.
