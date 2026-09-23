# Test the Microsoft 365 connector locally

**Use this only when testing Microsoft 365 or SharePoint integration.** First
set up a task worktree through the [development workflow](development-workflow.md)
and keep its `worktree` profile. For a separate, disposable operator evaluation
of `customer-managed`, initialize a dedicated checkout with
`npm run env:init -- --profile=customer-managed`; never reuse a development
worktree's `.env` or data. The root Compose stack is a local reference, not a
production deployment.

Microsoft 365 connector consent is separate from customer sign-in. The connector
uses delegated Graph access for each connected person; Microsoft social login
and company SSO are Better Auth methods described in
[authentication architecture](../architecture/authentication.md). None of
those Microsoft identities assigns a LemmaComputer organization or role.

## Before registering the application

You need a Linux x86_64 host with Node.js 22+, Docker Engine, and Docker Compose
v2.30.0+, plus an Entra tenant and an administrator who can grant consent.
Read the exact `LEMMACOMPUTER_PUBLIC_WEB_URL` in this checkout's `.env`; it may
use a different port from another worktree. The browser must reach that origin.

```bash
grep '^LEMMACOMPUTER_PUBLIC_WEB_URL=' .env
npm run env:check
```

## Configure a dedicated Microsoft 365 connector app

In [Microsoft Entra app registrations](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app),
create a confidential, single-tenant **Web** application for the connector.
Record its tenant ID and client ID, then create a client secret and keep its
**Value** in secret custody. Register these two Web redirects under the exact
public origin from `.env`:

```text
<public-origin>/oauth/mcp/callback
<public-origin>/api/v1/connections/microsoft-365/admin-consent/callback
```

Do not register a private LiteLLM or Microsoft bridge port as a browser
callback. Leave implicit/hybrid token issuance and public-client flows off.
The required delegated Microsoft Graph scopes are the list currently pinned in
[`config/litellm/config.yaml`](../../config/litellm/config.yaml):

```text
User.Read                 offline_access
Mail.ReadWrite            Mail.Send
Calendars.ReadWrite       Files.ReadWrite
Sites.Selected            Chat.Read
ChatMessage.Read          ChatMessage.Send
Team.ReadBasic.All        Channel.ReadBasic.All
ChannelMessage.Read.All   ChannelMessage.Send
```

Some scopes require tenant administrator approval; review them with the
customer. `Sites.Selected` also needs an explicit site grant before the
connector can access a site. See [Microsoft's permission reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
for current consent requirements.

Set the following three deployment values together, without printing the
secret to logs or committing `.env`:

```text
LEMMACOMPUTER_MS365_TENANT_ID
LEMMACOMPUTER_MS365_CLIENT_ID
LEMMACOMPUTER_MS365_CLIENT_SECRET
```

## Optional SharePoint site administration

To use **Connections → Microsoft 365 → SharePoint sites → Add and grant**, the
platform operator needs a **separate** confidential Entra application with
`Sites.FullControl.All` **application** permission and admin consent. The
everyday connector remains delegated and holds only `Sites.Selected` for site
access. Set its distinct `LEMMACOMPUTER_MS365_SITE_ADMIN_CLIENT_ID` and
`LEMMACOMPUTER_MS365_SITE_ADMIN_CLIENT_SECRET` together. Register this Web
redirect on that second application:

```text
<public-origin>/api/v1/connections/microsoft-365/sharepoint-admin-consent/callback
```

For hosted use, the platform application is multi-tenant and customer
directory administrators approve it through the product's **Get Microsoft
approval link** journey. In a customer-managed evaluation, the directory
administrator may grant consent directly in Entra. This application has broad
SharePoint administration authority; keep its credential only in Control's
secret custody. The everyday connector and workspace never receive it.

After approval, connect or reconnect the person's Microsoft account. Add the
exact SharePoint site URL, choose **Read only** or **Read and write**, and use
**Add and grant**. An individual still needs SharePoint membership. Use
**Revoke and remove** to withdraw the site grant. A failed provider revocation
must be resolved rather than deleting the local record alone.

## Start and verify the local test

For a task worktree, `npm run worktree:init` was already run once during setup.
After editing the Microsoft values in its existing `.env`:

```bash
npm run env:check
npm run compose:up
```

Build the desktop image only if this test includes a managed workspace:

```bash
npm run image:workspace
```

Then use the exact public origin from `.env`:

1. Sign in through Better Auth and confirm the account's organization role.
2. Open **Connections → Microsoft 365** and complete consent for the registered
   app. Confirm it reports **Connected**.
3. If testing SharePoint administration, grant one intended site and verify a
   connected user can access only an allowed site and only their own files.
4. If testing an agent, configure its model route separately in **AI control
   plane**, create a workspace, and try one read-only Microsoft 365 tool.

A healthy Compose stack does not prove Microsoft consent or a model route. If
the callback fails, compare the full scheme, host, port, and path with the
registered Web redirects; check the tenant/client/secret pairing and granted
scopes. Inspect `ms365-mcp`, LiteLLM, and Control logs without copying callback
codes or tokens. For stack health and safe shutdown, use
[local operations](operations.md#health-and-diagnostics).
