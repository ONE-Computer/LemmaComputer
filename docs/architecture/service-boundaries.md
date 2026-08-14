# Why LemmaComputer runs as many processes

A first look at `compose.yaml` shows sixteen entries, and the reasonable
reaction is that the system is over-decomposed. This page answers that
directly: what each boundary buys, which ones are load-bearing, which ones are
merely deployment units, and the rule for adding a new one.

## LemmaComputer is not sixteen microservices

It is one modular backend surrounded by separately isolated security,
infrastructure, worker, integration, and workspace-runtime processes.

Almost all first-party code lives in a single service. Measured in source lines,
`control-api` is roughly 17,000 while every other Lemma-owned process is between
100 and 1,600. Most of them are built from the same `control-runtime` image,
released together on one tag, and several share one PostgreSQL instance. There
are no independently owned services, no per-service release trains, and no
independent availability — Control has hard startup dependencies on most of the
others.

By the usual definition of microservices — independent deployment, independent
ownership, independent failure — this is not one, and it does not aim to be.
Counting containers and inferring architectural fragmentation gets the wrong
answer.

## The unit of isolation is the container

The reason for the process count is that in this deployment model, the container
is the smallest thing that can hold a network attachment and a hardening
profile. Compose expresses reachability per container: eleven networks, nearly
all `internal: true`, each scoped so a given process can reach exactly the peers
it needs. `cap_drop`, `read_only`, and `no-new-privileges` also apply per
container.

That has a hard consequence. Merging two processes into one container gives the
merged process the **union** of both network attachments and both privilege
sets. There is no way to say "this code may reach the Docker socket but that
code may not" inside a single Node process. So these boundaries are not code
organization that happens to be deployed separately — they are the only
mechanism by which the reachability rules can be stated at all. Collapse the
containers and the network topology, which *is* the security control, stops
existing.

Containers are also the cheapest isolation primitive that achieves this.
Separate VMs, a service mesh with mTLS policy, or in-process sandboxing are each
heavier, weaker, or both. The container count is the visible price of the
cheapest adequate mechanism.

## Count trust domains, not containers

The honest inventory is one codebase, about seven trust domains, sixteen Compose
entries:

| Trust domain | Processes | Why it is separate |
| --- | --- | --- |
| Public edge | `workspace-ingress`, `web` | Only published port; terminates untrusted traffic before Control |
| Control plane | `control-api`, `scheduler-worker`, `postgres`, two migration jobs | The application itself |
| Container-runtime authority | `workspace-controller` | Holds the Docker socket, which is host root |
| Gateway data plane | `litellm`, `litellm-postgres`, `ms365-mcp`, `litellm-admin-proxy`, two egress proxies | Third-party execution and provider credential custody |
| Consent | `openvtc-consent` | Isolates the executor signing key |
| Channels | `channel-broker` | Sole holder of decrypted external-channel credentials |
| Workspace runtime | sandbox, relay, egress sidecar, per session | User-controlled code |

## The boundaries that are load-bearing

### Workspace controller

The strongest boundary in the system, and the one most often mistaken for a thin
shim because it is small. It is small *because* it is a boundary.

It holds the Docker socket — host-root-equivalent authority — and it has no
database credential and no private key. It receives only the **public** policy
verification key set; Control holds the signing private key. Every sandbox
creation must carry a signed policy bundle, which the controller verifies
independently, and then it checks that every derived grant matches what was
signed: model-gateway route, MCP control route, egress grant tenant/subject/
workspace/mode/policy-hash, and the exact set of chat runtime grants. Any
mismatch is rejected.

The property this buys: **if Control is completely compromised, the attacker
still cannot provision a sandbox with escalated grants**, because they cannot
forge the signature from inside Control's process. Merging the controller into
Control would collapse signer and verifier into one process and reduce the
signature to self-attestation.

### Workspace ingress

The only published port, and an authorization-aware session gateway rather than
a plain reverse proxy. It routes ordinary pages to the Web application and
exposes exactly two public OAuth routes, so LiteLLM and the Microsoft connector
never publish host ports. For workspace traffic it validates a short-lived
HMAC-signed launch link, exchanges it for an `HttpOnly` path-scoped cookie,
strips the token from the URL, re-checks access with Control on every request,
and continues re-checking on a heartbeat for the life of a WebSocket session.

An off-the-shelf proxy could do the forwarding, but the signed-token exchange,
Control authorization, dynamic signed upstream selection, and mid-session
revocation would still need custom logic. Separating it also means
unauthenticated internet traffic never touches Control directly.

### The two gateway egress proxies

LiteLLM is attached only to internal networks and has **no route to the
internet**. Model traffic leaves through the gateway egress proxy under a static
provider allowlist. Custom and public MCP traffic leaves through the separate
remote-MCP egress proxy, which the pinned strict client selects explicitly with
`trust_env` disabled so a redirect cannot use `NO_PROXY` to reach Control or the
private Microsoft connector.

These are two instances of the same small program with different network
attachments, and the duplication is the point: each instance carries exactly one
egress policy. Merging them would create a single process that can reach both
model providers and arbitrary MCP hosts, which is precisely the combination the
split exists to prevent.

### Channel broker

The only process holding decrypted external-channel credentials and the only one
attached to `channel-egress`. Keeping it out of Control means a compromise of
the browser-facing application does not yield channel credentials or an
unmonitored outbound path.

### OpenVTC consent

Isolates the executor signing key and the cryptographic protocol implementation
from a 17,000-line application. Approval proofs are only meaningful if the key
that signs them is not reachable from the code most exposed to untrusted input.

### LiteLLM, its database, and the Microsoft 365 connector

Third-party components. LiteLLM owns provider and OAuth credential custody and
its own schema; the Microsoft connector is a pinned third-party MCP server with
delegated Graph access. Both execute authorized operations while Control remains
authoritative for identity, policy, routing, and accounting. Running vendor code
in the same process as the control plane would put provider keys and Graph
tokens inside the application's blast radius.

Putting all of the above into one backend would mean a compromise of the
browser-facing application could reach Docker root, provider credentials,
channel credentials, the consent signing key, and unrestricted outbound
networking.

## What is not a trust boundary

Being honest about this matters as much as defending the rest, because
overstating it is what makes the architecture look arbitrary.

**`scheduler-worker` is a deployment unit, not a security boundary.** It holds a
credential for the same Control database and is attached to `control-private`
only — a strict subset of Control's networks. Compromising it yields the Control
database directly, so it reduces blast radius approximately not at all. It
claims due runs with a database-level lease and hands each one back to Control
over HTTP; all execution happens in Control.

It is still correct to run it as its own service, for operational reasons: it
holds requests up to fifteen minutes, and keeping those off the API event loop,
plus crash isolation, independent restart, and headroom to run several
claimants, are real benefits. Keep it.

The distinction is what a diagram claims. On a deployment diagram it belongs
beside Control as a peer process, because that is what it is. On a *trust
boundary* diagram it should not appear as its own domain, because it holds the
same database credential and a subset of Control's networks — drawing a boundary
there implies an isolation that does not exist.

**The two migration containers are jobs.** They run once, must complete before
Control starts, and are not services.

**`litellm-admin-proxy` earns its boundary only in hosted deployments**, where it
terminates mTLS and accepts only the Control workload certificate. In worktree
and customer-managed profiles it is an additional forwarding hop.

**`web` is a static file server**, not an authenticating proxy. It attaches a
service token to `/api` traffic and performs no user authorization; Control does
all of it.

## The rule for adding a process

Give something its own container when at least one is true:

1. It holds a credential, key, or socket that no other process should be able to
   read.
2. It needs a network attachment that would widen another process's reachability.
3. It must verify something the caller could otherwise forge, so it has to sit
   outside the caller's trust domain.
4. It is third-party code executing with real authority.

If none of these apply and the motivation is code organization, event-loop
hygiene, or restart independence, it is a module or a worker — build it as one
and label it as one. `scheduler-worker` is the boundary case: legitimate as a
process, misleading as a service.

## Related

- [Architecture and trust model](overview.md) for the full trust boundaries,
  runtime flows, and the Compose network matrix.
- [MCP networking, egress, and OAuth callbacks](mcp-networking.md) for the
  outbound proxy decisions and redirect handling.
- [LiteLLM gateway architecture](litellm-gateway.md) for what stays
  authoritative in Control.
- [Service reference](../reference/services.md) for each process's interfaces,
  state, and health contract.
