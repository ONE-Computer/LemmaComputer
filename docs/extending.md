# Extending ONEComputer

ONEComputer is intentionally explicit. A connector, model, application, or
agent is not enabled by discovery alone; it becomes available only after its
schema, policy identity, credential path, runtime projection, and tests agree.

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

- the stable policy alias, such as `onecomputer-claude`;
- the provider deployment configured in LiteLLM.

Do not place provider model IDs directly in employee policy. This allows an
operator to change a deployment without invalidating the meaning of existing
policy versions.

### Implementation checklist

1. Add the stable alias to `sandboxModelAliases` in
   `packages/contracts/src/index.ts`.
2. Add its employee-facing name and provider to the model catalog in
   `apps/control-api/src/server.ts`.
3. If an existing persisted setting has a model-alias check constraint, generate
   a forward-only migration that expands it. Do not edit an applied migration.
4. Choose one deployment path:
   - a static route in `config/litellm/config.yaml` with a LiteLLM-only
     environment credential; or
   - a reviewed dynamic API-key route. The Control service sends the key once
     to LiteLLM's private `/credentials` API, then creates or updates a
     database-managed model that refers only to the credential name.
5. Do not add a dynamic-route provider key to `compose.yaml` or
   `.env.example`. LiteLLM's encrypted credential table is the demo secret
   store; the LiteLLM encryption root remains a deployment secret.
6. Add the alias to the initial policy document in
   `packages/workspace-store/src/identity-policy.ts` if it should be assignable
   by default.
7. If a managed client validates model names locally, add an explicit transport
   mapping in `packages/litellm-adapter/src/index.ts` and a matching LiteLLM
   transport alias. Preserve the policy alias in key metadata.
8. Set accurate capability, context-limit, retry, and pricing metadata. The
   gateway callback rejects image input when the selected deployment lacks it.
9. Extend route, capability, signed-policy, secret-boundary, and negative tests.

Do not configure cross-provider fallback for a governed alias unless policy and
audit semantics explicitly represent every possible destination.

### Dynamic Bedrock API-key route

`onecomputer-bedrock` is a narrow dynamic route for the reviewed global Claude
Sonnet 4.5 Bedrock Converse inference profile. It accepts only the approved
region/profile combinations in `packages/contracts/src/index.ts`; it does not
accept AWS access-key pairs, IAM role parameters, arbitrary model IDs, or
arbitrary endpoint URLs.

The raw Bedrock API key is write-only. Control sends it only to LiteLLM's
private credential API, whose pinned implementation encrypts credential values
in its database. The LiteLLM model record stores only
`litellm_credential_name`, region, and reviewed capability/pricing metadata.
Workspace virtual keys receive only the stable public alias.

## Add an MCP connector

An MCP connector crosses identity, OAuth, tool-schema, and side-effect
boundaries. Merely adding `mcp_servers` configuration would bypass
ONEComputer's governance model.

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

### Control and chat

For a chat-capable agent:

1. add its chat catalog ID and display mapping;
2. allocate a fixed loopback runtime port;
3. implement session list/create/resume/send behavior in the agent-chat bridge;
4. project an independently scoped gateway key for that agent;
5. update channel broker selection if external channels may route to it.

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

Add a `SANDBOX_DRIVER` discriminator and validate all driver-specific
configuration at startup. A production provider should not require the Docker
socket mounted by the local reference driver.

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

External sender identifiers are not ONEComputer identities. They become
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
