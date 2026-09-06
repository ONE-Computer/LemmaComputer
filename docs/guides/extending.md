# Component extension contracts

This is a subsystem checklist, not a setup or style guide. Use it when adding a
connector, model, application, agent, sandbox provider, egress rule, external
channel, OpenVTC behavior, or database migration. The repository setup and test
command index live in `docs/guides/development-workflow.md` and
`CONTRIBUTING.md` respectively.

A connector, model, application, or agent is not enabled by discovery alone;
it becomes available only after its schema, policy identity, credential path,
runtime projection, and tests agree.

## Change contracts before transports

Start an extension in `packages/contracts` when it changes a wire value,
catalog identifier, state, error, or signed-policy field. Use strict Zod
objects for security-sensitive messages and bounded strings, arrays, and
records.

Then implement in this order:

1. pure domain decision or canonicalization;
2. persistence interface and migration, if needed;
3. provider adapter;
4. service orchestration;
5. HTTP route or process wiring;
6. Web presentation;
7. positive, negative, replay, and boundary tests;
8. Compose/configuration and documentation.

This order keeps provider payloads from becoming implicit policy.

## Add a model provider or route

A model route has two identities:

- the product contract or compatibility alias; governed service-class traffic
  uses `lemmacomputer-auto` plus requested Auto/Lite/Balanced/Pro context;
- the provider deployment configured in LiteLLM.

Do not place provider model IDs directly in employee policy. This allows an
operator to change a deployment without invalidating the meaning of existing
policy versions.

### Implementation checklist

1. Model IDs are data, not release-owned enums. Existing providers discover
   their models dynamically and accept exact IDs through the administrator
   catalog flow. Maintain protocol adapters and bounded model metadata schemas,
   not per-release model lists. Preserve existing route identities. See
   [Dynamic model discovery](cloud-model-providers.md) for discovery, metadata
   provenance, credentials, and feature validation. New provider protocols still
   require transport qualification and accurate capability/usage behavior.
2. Add or extend the strict Provider settings schemas and administrator display
   metadata in `apps/control-api/src/provider-settings.ts` and the Web provider
   inventory. Do not expose the provider model as an employee service class.
3. If an existing persisted setting has a model-alias check constraint, generate
   a forward-only migration that expands it. Do not edit an applied migration.
4. Implement a reviewed dynamic Provider settings path. Control sends the
   write-only key once to LiteLLM's private `/credentials` API, then creates or
   updates tenant-scoped database-managed models that refer only to the
   credential name. `config/litellm/config.yaml` intentionally has an empty
   managed `model_list`; do not add a static provider route.
5. Do not add a managed-provider key to `compose.yaml` or `.env.example`.
   LiteLLM's encrypted credential table is the credential store; the LiteLLM
   encryption root remains a deployment secret.
6. Project the deployment descriptor into the administrator Pricing and Model
   routes inventory. Current employee workspace policy remains on
   `lemmacomputer-auto`; do not add a provider model ID or concrete deployment to
   employee policy.
7. If a managed client validates model names locally and a compatibility route
   is required, add an explicit transport
   mapping in `packages/litellm-adapter/src/index.ts` and a matching LiteLLM
   transport alias. Preserve the policy alias in key metadata.
8. Ensure the provider deployment descriptor can be priced by an immutable
   rate card and selected in a governed Lite/Balanced/Pro mapping. Provider
   configuration, pricing, mapping publication, Team policy, and rollout remain
   separate administrator decisions.
9. Extend route, capability, signed-decision, usage-admission, pricing,
   secret-boundary, and negative tests.

Do not configure cross-provider fallback for a governed alias unless policy and
audit semantics explicitly represent every possible destination.

### Dynamic Bedrock API-key routes

Bedrock accepts exact model/inference-profile IDs and a configured region using
its API-key credential through LiteLLM Converse. The old global Sonnet profile
remains readable without changing its persisted alias or accounting identity.
Catalog metadata is sourced from LiteLLM; account access is checked at inference.
Keys remain encrypted in the gateway and selection changes reuse the saved key.
Provider configuration, pricing, model limits, and route publication are separate.

### Azure AI Foundry and Google Vertex AI

The `foundry` and `vertex` managed providers use the same tenant-scoped dynamic
credential/model lifecycle. See [Cloud model providers](cloud-model-providers.md)
for supported models, configuration fields, current API formats, and the boundary
between mocked compatibility checks and live cloud qualification.

## Add an MCP connector

An MCP connector crosses identity, OAuth, tool-schema, and side-effect
boundaries. Merely adding `mcp_servers` configuration would bypass
LemmaComputer's governance model.

### What a remote connector needs before it can work

A catalog entry is not enough. Every remote connector reaches its provider
through the strict remote-MCP egress proxy and completes an OAuth
authorization-code flow, so three conditions must hold before Connect can
succeed:

1. **Every OAuth host is in the entry's allowlist.** Control authorizes gateway
   egress from `endpointUrl` plus `authorizationOrigins` and nothing else. Read
   the provider's `/.well-known/oauth-protected-resource` and then its
   authorization-server metadata, and confirm that the metadata, authorization,
   token, *and* registration endpoints all resolve to hosts in that list. Several
   providers delegate to a separate host, such as Stripe to `access.stripe.com`
   and Supabase to `api.supabase.com`.
2. **The provider offers a registration endpoint, or the operator supplies
   static credentials.** With a `registration_endpoint`, LemmaComputer registers
   itself when the first person connects and no deployment setup is required.
   Without one, the deployment needs an OAuth application created in the
   provider's developer portal, declared in `config/litellm/config.yaml` and
   wired to environment variables, the way GitHub and Google Workspace are.
   Servers declared there are owned by the gateway; keep them listed in
   `GATEWAY_CONFIGURED_SERVER_NAMES` so connector administration does not try to
   reconcile a row LiteLLM already owns under a hashed server id.
3. **The registration endpoint accepts this deployment's callback.** Some
   providers run dynamic registration behind a hostname allowlist covering only
   well-known MCP clients. They reject every self-hosted callback, so no
   LemmaComputer installation can complete the flow. Verify against the real
   deployment origin, not `localhost`, which is frequently allowlisted when a
   production hostname is not.

An entry is published only when it can actually complete a connection.
`apps/control-api/src/connector-catalog.ts` expresses that two ways.

`withheld` is unconditional, for an entry no deployment can rescue: the
provider allowlists registration callbacks, or the connector has no gateway row
and no way to supply one. The entry stays in source, so its name, branding,
icon, and scopes survive and nothing has to be rebuilt when the blocking
condition clears. It is unseeded, unlisted, unconnectable, and ineligible for
gateway egress.

`requiresCredentials` names the provider OAuth application the entry needs. Such
an entry is always published, and reports `setup_required` until an application
exists, so nobody is sent to an authorize redirect that fails on an empty client
id. Two things can satisfy it:

- **The deployment configures the credential group.** `scripts/deployment-config.mjs`
  checks whether both halves of the coupled environment pair carry a value and
  passes the group names, never the secrets, to Control as
  `CONFIGURED_STATIC_MCP_CLIENTS`. This is the shared client declared in
  `config/litellm/config.yaml`, used by every tenant in the installation.
- **A tenant administrator supplies its own application.** See below.

### Tenant-supplied provider applications

A catalog connector marked `requiresCredentials` can take an OAuth application
registered by one organization, for that organization alone. This is what makes
a connector usable in a multi-tenant installation without the operator holding a
client on every customer's behalf, and it is what an enterprise customer usually
wants: their mail never passes through a vendor's OAuth client, and they can
revoke access unilaterally.

Saving credentials creates a LiteLLM row owned by that tenant, named by
`tenantOwnedServerName`, carrying that tenant's client. The connector's
`credential_mode` moves to `tenant`, and catalog reseeding is careful not to
point the row back at the shared server.

Custody rules that must not regress:

- **Control never persists the client secret.** It goes straight to the
  gateway, which encrypts both halves under `LITELLM_SALT_KEY` and refreshes
  tokens with them. Only the client id is stored, and only so the screen can
  show which application is configured. Rotating `LITELLM_SALT_KEY` re-encrypts
  every tenant's credentials at once.
- **The endpoint and authorization origins stay the catalog's.** A tenant
  supplies a credential, never a destination, so this path cannot introduce a
  new gateway egress target. Catalog endpoints are approved per origin and
  deliberately not tenant-scoped, so they are allowed whether or not any
  particular tenant has finished setup.
- **Changing the client invalidates existing authorizations.** The gateway
  purges its stored per-user tokens whenever the OAuth client changes, so
  Control drops that connector's durable connection markers for the tenant at
  the same time; otherwise a connector would be reported as connected when it
  is not.
- **Removing credentials deletes the tenant's gateway row**, so a tenant's
  encrypted credentials do not linger in a shared gateway. Deleting a tenant
  must do the same, or orphaned rows accumulate.
- **Reconciliation never recreates a tenant-credentialed row.** Only the
  credentials path holds the client secret, so `ensureManagedConnectorServers`
  skips these rows; recreating one would write back a credential-less record
  and quietly turn a working connector into a dynamic-registration attempt
  against a provider that offers none. A genuinely missing row surfaces as an
  unresolved connection until an administrator re-enters the application.

Microsoft 365 is deliberately outside this path. It is a separate container
configured by environment variables, not a gateway row carrying credentials, so
none of the above applies to it.

### Connectors that need a directory administrator

Some providers ask for permissions that are tenant-wide by construction, which
no ordinary user can grant for themselves. Microsoft 365 is the current case:
`Team.ReadBasic.All`, `Channel.ReadBasic.All`, and `ChannelMessage.Read.All`
force administrator consent onto every connection, including one from a person
who only wants their own calendar.

`catalogAdminConsentProvider` names the connectors in that position. For those,
`publicConnector` reports an `adminConsent` summary, and Connections offers a
link the member can hand to whoever administers their directory. Three
properties of that flow are deliberate:

- **The link is signed, not stored against a session.** The administrator who
  opens it is usually not the person who requested it and often has no
  LemmaComputer account, so the state in the query is the only thing binding
  the response to an organization. It is HMAC-signed with
  `CONNECTOR_CONSENT_SECRET`, carries an expiry, and is bound to one connector.
- **The landing route is exempt from the session check and nothing else.** It
  still sits behind the ingress proxy token. It renders a self-contained page
  rather than redirecting into the application, because the reader cannot sign
  in, and that page names no organization and echoes nothing from the query.
- **Connect is not gated on a recorded grant.** An installation whose
  administrator consented in the Entra portal has no record here and must keep
  working. The record is what LemmaComputer knows, not what Microsoft enforces,
  and clearing it revokes nothing: only a directory administrator can revoke
  consent, in their own portal.

A consent failure returning from the provider is mapped to
`MCP_ADMIN_CONSENT_REQUIRED` rather than the generic denial. Microsoft reports
"this needs an administrator" through an AADSTS code inside `error_description`,
and calling that a refusal tells the person to try again, which can never
succeed.

### Gateway server names

`connector_registry.server_name` is the name Control uses to address a
connector in LiteLLM. `LiteLLM_MCPServerTable` keys only on `server_id`, and
the adapter resolves a connection by name, so any name a tenant can influence
must be unique across every tenant rather than only within one. A shared
gateway would otherwise hold two rows called `lemmacomputer_reports` and
resolve between them arbitrarily.

Tenant-owned rows therefore take their name from `tenantOwnedServerName`, which
appends the row's own `server_id` to the connector id. Never build one by
formatting a tenant-supplied string. `connector_registry_custom_server_name_key`
enforces the same rule in the database, and `MemoryConnectorRegistryStore`
mirrors it so the constraint is provable without PostgreSQL.

Built-in rows are the deliberate exception: every tenant's built-in entry names
the same shared gateway server, so the constraint covers `source='custom'` only.

Renaming is safe to reconcile. `ensureOAuthMcpServers` matches on `server_id`,
so a row whose stored name has drifted is renamed in place through
`PUT /v1/mcp/server`; the gateway purges stored per-user OAuth tokens only when
a mint-relevant field changes, and the name is not one of them. A differing
`url` for the same `server_id` is still catalog drift and remains a conflict.

### Connector checklist

1. Pin the connector artifact and dependency lock. Review its authentication,
   logging, confirmation, pagination, and dynamic-registration defaults.
2. Run it on a private gateway network with a dedicated egress network and the
   smallest required OAuth scopes.
3. Add a fixed LiteLLM server definition and `allowed_tools`.
4. Define a deterministic server identifier from the canonical server
   properties. The LiteLLM callback and Control must calculate the same value.
5. Add connector and tool definitions to `packages/contracts`. Tool names and
   canonical argument schemas are versioned security identifiers.
6. Add capability definitions to the Control MCP policy service. Each
   capability needs:

   - stable capability and schema identifiers;
   - a canonical parser;
   - a risk classification;
   - safe employee-facing summaries;
   - a default decision of `allow`, `approval_required`, or `deny`.

7. Extend the LiteLLM callback to require the exact server binding and call
   Control before dispatch. Unknown servers, tools, or context must fail closed.
8. Add OAuth connection orchestration without returning refresh/access tokens
   to Control, Web, or the workspace.
9. Add administrator policy controls and an audit-safe UI.
10. Test identity mismatch, server mismatch, malformed arguments, missing
    policy, Control outage, OAuth isolation, approval replay, and tool-schema
    drift.

If the connector has its own `confirm` argument, treat that as defense in depth.
It must not replace the governed-operation decision.

## Add a governed tool

For an existing connector, add the tool to all allowlists in one change:

- connector startup allowlist in `compose.yaml`;
- LiteLLM `allowed_tools`;
- the contract tool catalog;
- Control capability definitions and canonical schema;
- the initial policy document, if applicable;
- administrator policy UI;
- tests.

For `approval_required`:

1. canonicalize only user-controlled arguments;
2. derive the request fingerprint from tenant, subject, workspace, agent,
   effective policy, tool, and arguments;
3. store the exact execution arguments and their operation digest;
4. create an OpenVTC task with a safe effect summary;
5. execute only with a complete one-time lease binding;
6. hash and persist the result receipt.

Never reuse an approval after its exact arguments, tool schema, policy hash,
workspace, agent, or identity changes.

## Add a sandbox application or agent

Application and agent support spans both build-time software and runtime policy.

### Catalog and policy

1. Add a stable ID to the application or agent catalog in
   `packages/contracts/src/index.ts`.
2. Add the ID to workspace-manifest mappings when external names differ from
   internal catalog IDs.
3. Add assignment/default behavior to the initial identity-policy document.
4. Ensure settings validation rejects selections not assigned by effective
   policy.

### Workspace image

1. Add a version- and checksum-pinned installation to the workspace Dockerfile.
2. Add a launcher or desktop entry under the managed application directory,
   not the default user desktop.
3. Update the root entrypoint allowlist to materialize only selected software.
4. Put gateway or Control credentials in a root-owned loopback broker. The user
   process should receive only a local placeholder credential.
5. Restrict the broker to the minimum paths, methods, models, tools, and
   request sizes required by the application.
6. Write immutable managed policy to an administrator-owned path.
7. Remove self-update, telemetry, credential storage, and extension paths that
   would escape organizational policy.

For an Electron or Chromium application, follow the qualification contract in
[ADR 0005](../adr/0005-catalog-gated-electron-sandbox.md#application-qualification-contract).
Do not make an arbitrary downloaded binary eligible for the Electron profile,
and do not widen AppArmor, seccomp, capabilities, or device access merely to
make an unqualified build start.

### Control and chat

For a chat-capable agent:

1. add its chat catalog ID and display mapping;
2. allocate a fixed loopback runtime port;
3. implement session list/create/resume/send behavior in the agent-chat bridge;
4. project an independently scoped gateway key for that agent;
5. update channel broker selection if external channels may route to it.

If the agent exposes native model or thinking controls, follow the
[Agent model and reasoning adapter playbook](../agents/agent-reasoning-adapter-playbook.md)
before promoting it. Native labels are product intent only: the exact runtime
adapter, provider route, signed task binding, LiteLLM translation, tool and
stream transport, and completion evidence must each qualify independently.

Test that disabled software is absent, local credentials cannot be used outside
the broker, provider keys are absent from the user environment and home volume,
and policy changes require a restart.

## Add a sandbox provider

Implement the `SandboxAdapter` contract used by
`apps/workspace-controller/src/server.ts`:

- `create`
- `status`
- `open`
- `destroy`
- `purgeWorkspace`

The controller already verifies signed policy and grant projection before
calling an adapter. A new adapter must additionally:

- use stable provider idempotency keys;
- tag remote resources with workspace and policy identities;
- return normalized states and safe failure codes;
- preserve persistent storage across stop/start;
- separate its private ingress target from any public URL;
- make destroy retry-safe;
- avoid returning provider credentials in launch data or errors.

Add a runtime discriminator only for a genuinely different runtime contract;
placement belongs in `LEMMACOMPUTER_WORKSPACE_NODE_TOPOLOGY`. Validate all
runtime-specific configuration at startup and keep Docker authority on the
workspace node.

## Add an egress rule type

Rule semantics belong in `packages/egress-policy`, not in the Web UI or proxy
transport.

1. Version the contract if rule shape or interpretation changes.
2. Normalize input into an unambiguous canonical representation.
3. Compile rules before request processing.
4. Apply policy after DNS resolution and before connection.
5. Ensure HTTP targets, HTTPS `CONNECT`, SNI, and resolved addresses cannot
   disagree.
6. Emit only safe decision metadata to audit logs.

Every new allow mechanism needs tests for wildcard confusion, Unicode and
trailing-dot names, IP literals, private ranges, IPv4-mapped IPv6, multiple DNS
answers, redirects, and malformed TLS client hellos.

## Add an external channel

External-channel credentials belong in `apps/channel-broker`, never Control or
the workspace.

1. Add strict owned credential and connection schemas.
2. Encrypt credentials with a provider-independent envelope and stable key.
3. Add migrations for connection, update-deduplication, route, and delivery
   state.
4. Verify webhook signatures or authenticate polling responses.
5. Ask Control to validate the owned sender/workspace/agent route before every
   turn.
6. Make inbound updates and outbound deliveries idempotent.
7. Enforce bounded content and safe error messages.
8. Give the provider its own explicit egress route if its destination set
   differs.

External sender identifiers are not LemmaComputer identities. They become
authorized only through an owned connection persisted by Control.

## Change OpenVTC behavior

Keep cryptographic protocol work inside `apps/openvtc-consent`; keep product
state and delivery inside Control.

Protocol extensions require:

- a versioned OpenVTC document/profile;
- strict serialization and canonical digest behavior;
- signer, verification-method, challenge, recipient, audience, operation, and
  time validation;
- interop tests with independently produced documents;
- replay and excluded-requester tests;
- migration behavior for already queued tasks.

Web Push payloads must remain content-free hints. The companion retrieves the
signed request over its authenticated inbox channel.

## Add a database migration

Generate a dependency-declared ULID migration with:

```bash
npm run db:migration:new -- <short-name>
```

The one-shot migration job applies it before Control starts. Application startup only
checks schema compatibility. Read [Database migrations](database-migrations.md) before editing SQL.

Guidelines:

- use transactional DDL where PostgreSQL supports it;
- make constraints express tenant ownership and state invariants;
- add indexes for every polling, lease-claim, expiry, or idempotency query;
- do not store plaintext tokens when a hash is sufficient;
- encrypt credentials before persistence;
- keep operation and audit history append-oriented;
- update the in-memory store used by tests;
- run `npm run verify:db` to prove fresh, no-op, concurrent, legacy, mismatch, and checksum behavior.

## Verification expectations

Run the full baseline:

```bash
npm run build
npm test
npm run compose:config
```

For boundary changes, include tests that demonstrate at least:

- the allowed path works;
- missing authentication is denied;
- cross-tenant and cross-workspace access is denied;
- altered signed data is denied;
- expired data is denied;
- replay is denied;
- dependency failure is a closed failure;
- logs and public errors do not contain secrets or protected arguments.
