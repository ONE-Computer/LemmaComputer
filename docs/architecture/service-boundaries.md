# Why the stack has separate processes

LemmaComputer is one product codebase with several deployment processes. The
split mostly follows credentials, network reachability, and runtime authority.
It is not a set of independently released microservices. The current process
list is in [Service reference](../reference/services.md); the exact Compose
service count can change.

## Boundaries that matter

| Boundary | Why it has its own process or container |
| --- | --- |
| Workspace controller | Holds node-local Docker authority and verifies the signed policy and grant projection before creating a sandbox |
| Workspace ingress | Owns the one browser origin, exact OAuth relays, short-lived desktop launch exchange, and continuing access checks |
| LiteLLM and its database | Vendor code holds encrypted provider credentials, connector OAuth tokens, and scoped gateway keys outside user processes |
| Model and remote-MCP egress proxies | Apply different destination policies and network attachments; LiteLLM has no direct internet route |
| Microsoft 365 connector | Holds delegated Graph access inside its own private/egress boundary |
| Channel broker | Holds external-channel credentials and channel egress |
| OpenVTC consent | Holds approval signing authority apart from the main Control process |
| User workspace | Runs user-controlled applications on an internal per-workspace network, with only policy-selected relays and egress |

The container is where Docker network attachments and hardening controls are
applied. Merging two processes into one container gives both the union of
those attachments and credentials. A source module alone does not preserve a
network or secret boundary.

The controller's separate verification catches unsigned or altered policy,
missing grant bindings, and requests from callers without the required node
credentials. **Control holds the policy signing private key.** A fully
compromised Control process could sign malicious policy, so the separate
controller does not make Control compromise harmless. Remote placement still
keeps the Docker socket and persistent workspace storage off Control compute.

## Deployment units, not separate trust domains

- The scheduler worker shares Control's database authority. Separation helps
  leases, long-running jobs, and restarts; it does not protect that database
  from compromise of the worker.
- Product, customer-auth, and platform-auth migration containers are one-shot
  jobs, not long-running services. Control waits for their success.
- Web serves the UI and adds a service token to `/api` forwarding; Control
  authenticates and authorizes users. The Web token is not a user principal.
- The LiteLLM admin proxy adds workload mTLS in hosted deployments; in local
  profiles it is mainly a forwarding hop.

## When to add a process

Give a component a distinct runtime when it needs a credential, socket,
network attachment, independent verification boundary, or third-party code
that should not share another component's authority. When the need is only
code organization, keep it a module; when it is scheduling or restart
independence, describe it as a worker instead of claiming a new security
boundary.

See [Architecture and trust model](overview.md) and
[MCP networking](mcp-networking.md) for the actual data paths.
