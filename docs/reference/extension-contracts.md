# Extending a component

**Use this when adding a provider, connector, tool, agent, workspace adapter,
egress rule, channel, or migration.** Start with the contract and owner; do
not expose a discovered upstream capability until product policy, credential
custody, runtime projection, and tests agree. Repository setup and test
commands are in [Development workflow](../guides/development-workflow.md)
and [CONTRIBUTING](../../CONTRIBUTING.md).

## Shared change order

1. Define the stable identifier and strict contract in `packages/contracts`.
   Bound security-sensitive strings, arrays, and payloads.
2. Implement pure policy/canonicalization and tenant-scoped persistence,
   including a migration if necessary.
3. Add the provider/runtime adapter and service wiring.
4. Expose a thin Control route and browser control only after server
   authorization exists.
5. Test allowed, denied, cross-tenant, replay, expiry, dependency-failure,
   and secret-redaction paths.

## Model provider or route

Model IDs are data; they are not employee policy names. Preserve the user's
Lite/Balanced/Pro service-class contract while an administrator configures a
concrete deployment, price, mapping, Team policy, and rollout separately.
`lemmacomputer-auto` is the internal transport alias. Control sends a
write-only credential to LiteLLM's private API; LiteLLM encrypts it. Do not
put managed provider keys or a managed `model_list` in Compose or static YAML.

Add protocol-specific settings, capability and usage normalization, route
validation, immutable rate coverage, and tenant isolation. A client-facing
compatibility model name does not prove the concrete provider execution; use
the signed routing decision and usage admission. See
[Model providers](model-providers.md), [Model routing](../product/model-routing.md),
and [LiteLLM gateway](../architecture/litellm-gateway.md).

## MCP connector or governed tool

A connector needs a reviewed destination and OAuth application path before
users can connect. Verify its metadata, authorization, token, registration,
and redirect hosts through the remote-MCP egress policy. A provider without
dynamic registration needs a deployment or tenant-owned OAuth application.
If a provider rejects the deployment's actual callback, keep it unavailable;
a working `localhost` callback is insufficient. Microsoft 365 has a separate
private bridge and consent flow.

For every exposed tool, align:

- the connector's startup allowlist, LiteLLM `allowed_tools`, and the product
  catalog;
- strict canonical arguments, capability/risk class, and policy default;
- an exact server binding and Control per-call decision in the LiteLLM
  callback;
- safe employee summary, administrator control, and audit fields.

Unknown server, tool, argument, policy, or Control response denies. A
`confirm` argument in an upstream connector is defense in depth, never the
product approval. Protected tools additionally need an operation digest,
verified OpenVTC decision, one-time lease, and result receipt. Changed
arguments, schema, identity, or policy invalidate an old approval. See
[MCP networking](../architecture/mcp-networking.md) and
[Microsoft 365 tool contracts](microsoft365-tool-contracts.md).

Tenant-supplied OAuth credentials must stay in LiteLLM's encrypted store.
They cannot change catalog destinations. Changing a client invalidates its
prior user connections; deleting a tenant removes its gateway rows. Gateway
server names must remain unique across tenants and are derived from stable
server IDs, not tenant input.

## Sandbox application or agent

Add a stable catalog ID, policy assignment/default, pinned workspace-image
installation, managed launcher, and entrypoint allowlist. Disabled software
must stay absent. A user process receives only a local broker credential;
provider and Control secrets remain in root-owned brokers. Keep broker paths,
methods, models, tools, and request sizes narrow.

For an agent with model or effort controls, follow
[Reasoning adapter qualification](../agents/reasoning-adapter-qualification.md).
Native labels are intent until Control signs a task binding and the gateway
verifies the concrete route. For Chromium/Electron apps, follow
[ADR 0005's qualification contract](../adr/0005-catalog-gated-electron-sandbox.md#application-qualification-contract).

## Workspace adapter or egress rule

A new `SandboxAdapter` preserves create, status, open, destroy, and verified
purge contracts. It uses stable idempotency keys, private launch targets,
workspace/generation labels, retry-safe teardown, and persistent home
ownership. Remote Docker authority stays on the workspace node. See
[Workspace node](../architecture/workspace-node.md).

New egress semantics start in `packages/egress-policy`, then the proxy.
Normalize host/protocol/port before evaluating all DNS answers and SNI.
Test private, mixed, rebound, redirected, malformed, and IPv4/IPv6 cases.
Audit decisions without URLs, credentials, bodies, or protected arguments.

## External channel or consent protocol

An external channel keeps decrypted credentials in `apps/channel-broker`.
Control validates sender, workspace, and agent ownership before each turn;
inbound updates and outbound deliveries need idempotency and bounded content.
An external sender ID is not a LemmaComputer identity.

OpenVTC cryptography stays in `apps/openvtc-consent`; Control owns operation
state and delivery. Version documents and test signer, audience, challenge,
operation, expiry, replay, and interoperability. Push payloads contain no
approval content.

## Database migration

Read [Database migrations](../guides/database-migrations.md) first. Generate
a forward-only product migration with:

```bash
npm run db:migration:new -- <short-name>
```

Add tenant-safe constraints and indexes, keep secrets encrypted or hashed,
and run `npm run verify:db` for persistence changes. Customer-auth and
platform-auth have separate migration streams. Application startup only
checks compatibility; it does not apply schema changes.
