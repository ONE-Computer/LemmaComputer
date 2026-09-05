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
Opaque-origin CORS does not enable cookie credentials. Responses are private,
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
