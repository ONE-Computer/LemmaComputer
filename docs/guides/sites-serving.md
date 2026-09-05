# Authenticated static-site assets

The stable `/s/{handle}` URL is an identifier, not a public sharing credential.
The owned viewer authenticates with the normal Lemma login and authorizes the
site before opening generated content in an `allow-scripts` sandbox. Do not add
`allow-same-origin`: generated content shares the application's delivery origin
and must not gain access to its DOM, cookies or storage.

An opaque sandbox cannot reliably send the app's session cookie with module,
stylesheet or JSON requests. After checking access, Control issues a signed,
15-minute bundle-read grant bound to the owning tenant, site handle, immutable
version, account and authentication-session ID. Relative paths stay inside its
version-specific asset URL. The grant contains no login bearer token, cookie,
provider secret or artifact locator; it is accepted only by the read-only Sites
asset route, behind the trusted Web proxy.

Every asset request verifies the signature and scope, reads the live Better Auth
session by its non-secret ID, resolves current account/membership state, and
checks the current site ACL. Logout, session expiry, account disablement, grant
revocation and site deletion therefore deny subsequent reads even when the
bundle is cached. Loaded bytes cannot be recalled from a viewer. Both deployment
profiles use this same path; no schema migration or separate Sites service is
required. Shared Control replicas use the existing Web proxy secret with a
domain-separated signature.

The document CSP permits resources only from this exact bundle URL subtree.
Opaque-origin CORS accepts ordinary fetches and explicit `credentials:include`
requests from existing bundles, but cookies provide no authority on this route.
Responses are private,
`no-store`, `nosniff` and `no-referrer`; the frame cannot read the parent or call
general Control APIs. The stable URL remains the only link intended for sharing.

Asset grants expire after 15 minutes. Already loaded static dashboards continue
working; reload the stable viewer to authorize later lazy-loaded resources.
Treat grant-bearing asset URLs as sensitive in reverse-proxy/access logs.
Control redacts the grant segment in its request serializer. Never copy an asset
URL into chat, email, a public link, or diagnostic output.

Verification: `tests/e2e/site-assets.spec.ts` exercises the real Control handler
with a cookie-authenticated parent and cookie-less sandboxed module imports,
CSS and JSON. It checks isolation, live session revocation, foreign-tenant denial,
explicit cross-organization sharing/revocation and deletion. The database gate
also tests the credential-free session lookup against the owned auth schema.

## Per-site sharing roles

Roles belong to the site, not the user's organization role:

| Role | Read | Share, invite, revoke access, change visibility, restore versions | Delete |
| --- | --- | --- | --- |
| Owner (creator) | Yes | Yes | Yes |
| Can view (organization visibility or invitation/grant) | Yes | No | No |

Organization owners/admins no longer get implicit access to private sites or
management rights over another creator's sites. Invitations and grants provide
view-only access. There is no promotion or delegated site management. Owner
is not a grant and cannot be reassigned or downgraded through this UI/API.
Removing an individual grant does not remove read access supplied by organization
visibility. Revoking access takes effect on subsequent requests.

Site sharing is account-scoped and does not admit external recipients to the
organization. Only the owner sees the Share button, and the API independently
enforces ownership for every management operation. Generated iframe content has
no access to this management authority. Source
editing/publishing still requires the creator's bound workspace and agent bridge;
site roles do not share workspace files or introduce collaborative source editing.

This release deliberately excludes collaborative editing, shared workspaces,
delegated agent execution and source checkout/push workflows. Recipients can
interact with the published dashboard, but amendments go through the owner's
existing workspace agent.

No schema change is required. Historical migrations remain immutable; the
earlier database constraint still permits stored `admin` values, but all grants
are exposed and authorized as view-only. New grants and invitation acceptance
write only `viewer`, and the API rejects `admin`, `editor` and `owner` grants.
Existing sites, invitations and viewing access are preserved. Deploy this code
to every Control API instance in either profile; do not roll back to code that
interprets old grants as management authority.

## Invitation delivery

An invitation's `pending` status means **awaiting acceptance**, not delivered.
The Share dialog shows the installation's configured delivery mode:

- `LEMMACOMPUTER_INVITATION_DELIVERY_MODE=copy-link`: no email is sent. Create
  the recipient-bound link and deliver it yourself. New link replaces the old one.
- `email` with `LEMMACOMPUTER_AUTH_EMAIL_TRANSPORT=capture`: test messages are
  captured locally, not sent to an inbox.
- `email` with `LEMMACOMPUTER_AUTH_EMAIL_TRANSPORT=postmark`: the existing
  transactional adapter submits the invitation. A successful submission is not
  proof of inbox delivery; use the provider's delivery/bounce information.

Real email requires the existing Postmark server token and verified sender
configuration. Never commit credentials. External recipients also need a
reachable `LEMMACOMPUTER_PUBLIC_WEB_URL` with the corresponding sign-in callback
configuration: localhost points to the recipient's own computer. Do not expose
a local test stack publicly just to send an invitation.

If submission fails, the API returns `SITE_INVITATION_EMAIL_FAILED` (503), not a
success response. The invitation remains pending and can be retried; retries
rotate its hashed token. The UI clears obsolete copy links and does not claim
delivery. Persistent provider delivery receipts/webhooks are not implemented.
