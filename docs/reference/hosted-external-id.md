# Hosted Microsoft Entra External ID

> **Transitional adapter.** The embedded Better Auth runtime is the current
> customer-authentication path for both deployment profiles. This runbook is
> retained only for deployments that explicitly enable the legacy hosted
> External ID adapter. It is not a prerequisite for hosted operation and does
> not describe company SSO or Microsoft social login.

When explicitly enabled, the `hosted` deployment profile may use
browser-delegated OpenID Connect against a Microsoft Entra External ID external
tenant. Microsoft hosts the password and
multifactor-authentication screens. LemmaComputer receives verified identity
claims and never receives or stores the person's password or email one-time
passcode (OTP).

This is an operator runbook. It does not apply to `customer-managed`
installations, which continue to use the customer's workforce Entra tenant.

## Keep the three access decisions separate

| Decision | Authority | What it does not grant |
| --- | --- | --- |
| External ID account and authentication | Microsoft Entra External ID | No LemmaComputer organization, role, workspace, or Microsoft 365 data access |
| LemmaComputer invitation and membership | LemmaComputer organization owner or administrator | No provider account, password, MFA method, or Microsoft 365 consent |
| Microsoft 365 connector consent | The person's Microsoft 365 directory and the connector's delegated scopes | No LemmaComputer role or membership |

An External ID account proves who authenticated. A pending LemmaComputer
invitation carries the predetermined organization and role. Provider groups,
directory-administrator status, email domain, and token claims cannot select an
organization or elevate that role. The authenticated email must match the
invitation exactly after normalization before the membership is activated.

Product sign-in requests only OIDC identity scopes. Microsoft Graph consent for
the Microsoft 365 connector is a later, independent action. In many deployments
the External ID tenant and the person's Microsoft 365 workforce tenant are
different directories.

## Configure the external tenant

1. Create or select a Microsoft Entra **external tenant**. Do not use the
   workforce tenant configured for a customer-managed installation.
2. Register a confidential Web application and add this exact redirect URI:

   ```text
   https://YOUR-PRODUCT-HOST/api/v1/auth/external-id/callback
   ```

3. Create a sign-up and sign-in user flow, associate the Web application, and
   select **Email with password** as the local-account primary method.
4. Disable public self-service sign-up on that flow. Microsoft documents this
   as an Update authenticationEventsFlow operation that sets
   `onInteractiveAuthFlowStart.isSignUpAllowed` to `false`. This setting still
   permits existing external-tenant accounts to sign in. Record the change in
   the deployment evidence and repeat it for every flow associated with the
   application. See Microsoft's
   [disable sign-up procedure](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-disable-sign-up-user-flow).
5. Under **Entra ID → Authentication methods**, enable **Email one-time
   passcode** as an MFA method for the intended users. Add a Conditional Access
   policy for the application that requires MFA. Keep **Email with password**
   as the primary local-account method: an account that uses email OTP as its
   first factor cannot reuse email OTP as its second factor. See Microsoft's
   [external-tenant MFA guidance](https://learn.microsoft.com/en-us/entra/external-id/customers/concept-multifactor-authentication-customers).
6. Create each intended person's external-tenant account administratively,
   either with **Entra ID → Users → New user → Create new external user** and
   the **Email** sign-in method, or the corresponding Microsoft Graph
   administration path. A LemmaComputer invitation does not create a Microsoft
   account or choose or deliver its initial password. Follow Microsoft's
   [customer-account administration procedure](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-manage-customer-accounts).

The operator who creates provider accounts must use a separate, audited
administration process. Never put an initial password in a LemmaComputer
invitation, issue body, chat, or application log.

## Configure LemmaComputer

Set all four External ID values together in the hosted deployment secret store:

```dotenv
LEMMACOMPUTER_EXTERNAL_ID_TENANT_ID=00000000-0000-0000-0000-000000000000
LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN=your-external-tenant-label
LEMMACOMPUTER_EXTERNAL_ID_CLIENT_ID=00000000-0000-0000-0000-000000000000
LEMMACOMPUTER_EXTERNAL_ID_CLIENT_SECRET=store-in-the-deployment-secret-manager
```

`LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN` is the label before
`.ciamlogin.com`, not a full URL. The tenant and client IDs are identifiers, not
secrets. The client secret is a deployment credential and must be rotated with
an overlap window. Do not expose it to Web, workspaces, invitation delivery, or
operator qualification output.

Then validate and render the hosted profile:

```bash
npm run env:check -- --profile=hosted
npm run env:render -- --profile=hosted
```

The deployment contract requires all four values in `hosted`. It rejects them
in `customer-managed`; that profile's External ID routes remain disabled and
its External ID values must be empty.

## Invitation acceptance

1. An organization owner or administrator creates an invitation with one
   normalized email address and one role. The application returns a one-time
   acceptance URL.
2. Deliver the URL over an approved private channel. Treat its token as a
   short-lived access capability: do not paste it into tickets, analytics,
   screenshots, logs, or chat.
3. The person opens the URL and continues to Microsoft's hosted sign-in page.
   Microsoft verifies the email and password, then enforces the configured
   email OTP MFA policy.
4. Control verifies OIDC state, nonce, PKCE, issuer, audience, and immutable
   subject. It accepts the invitation only when the authenticated email and
   invitation match and the invitation is still pending and unexpired.
5. Control creates the organization-local membership with the invitation's
   predetermined role. It stores only the invitation token hash and session
   token hash; the raw invitation token, password, OTP, authorization code,
   provider tokens, and client secret are not stored in product tables or sent
   to the browser after the callback.

Expired, revoked, already-consumed, wrong-email, wrong-issuer, and cross-
organization attempts use the same generic browser error. Operational logs may
carry a bounded reason code but must not reveal whether an email or account
exists.

## Real-tenant qualification

The non-interactive qualification command reads the selected environment file,
requires the hosted profile, downloads the tenant's OIDC discovery document and
signing keys, and performs a PKCE `prompt=none` authorization probe against the
configured client and callback. It does not call the token endpoint, send the
client secret, authenticate a person, or print response locations, claims,
tokens, codes, passwords, OTPs, or environment values.

Run it from the exact clean release candidate that will be deployed:

```bash
npm run qualify:external-id -- --file=/absolute/path/to/hosted.env
```

A passing preflight proves that the real tenant publishes the expected issuer
and signing keys and recognizes the configured callback for a silent OIDC
attempt. It does not prove the client secret, invitation binding, or interactive
MFA journey. Complete this manual smoke in a private browser session:

For local development only, the same real-tenant preflight and invitation
acceptance path may be exercised from the `worktree` profile with a loopback
HTTP origin:

```bash
npm run qualify:external-id -- --file=/absolute/path/to/worktree.env --development
```

The `--development` exception accepts only the `worktree` profile and only
`http://localhost` or `http://127.0.0.1`. It does not relax hosted deployment
validation, enable External ID in `customer-managed`, or make a local worktree
a production-ready hosted deployment.

1. Confirm the target user flow has `isSignUpAllowed=false` and is associated
   with the configured application.
2. Administratively create a disposable external-tenant email-and-password
   account and require email OTP MFA for the application.
3. In LemmaComputer, invite that exact email to a disposable organization with
   the `member` role. Record only the invitation ID, never its raw token or URL.
4. Open the acceptance URL, authenticate on the Microsoft-hosted page, complete
   email OTP, and confirm the resulting session has only the invited
   organization and `member` permissions.
5. Attempt a new, uncreated email through the provider flow and confirm it
   cannot self-register. Attempt an expired or revoked invitation and a valid
   invitation with a different authenticated email; each must end in the same
   generic product error.
6. Confirm the organization audit records invitation creation and acceptance,
   successful and failed sign-in/link events, logout, and later session
   revocation without raw tokens or credentials.
7. Inspect the browser URL/storage, application logs, and product database for
   the disposable run. They must not contain the password, OTP, authorization
   code, provider access/refresh/ID token, client secret, or raw invitation
   token.

Record the release SHA, external tenant ID, application client ID, user-flow ID,
Conditional Access policy name, test invitation ID, timestamps, outcomes, and
auditor. Do not record the disposable password, OTP, client secret, raw
invitation URL, authorization response, or provider token.
